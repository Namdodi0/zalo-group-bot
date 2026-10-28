import { summarizeRange } from './summarizer.js';
import { pruneToolResults } from './tool-result-pruner.js';

/**
 * Pipeline compaction: prune tool-result → summarize range.
 * Trigger: 'pressure' (áp lực token), 'overflow' (provider báo context đầy),
 * 'manual' (/compact), 'dropped' (assembler đã phải bỏ message).
 * @param {{config: any, logger?: import('../../logger.js').Logger, metrics?: any, summarize: (messages: any[], deadline?: number) => Promise<string>}} options
 */
export function createCompactionEngine(options) {
  const config = options.config;
  const logger = options.logger;
  const metrics = options.metrics;
  const summarize = options.summarize;

  function spec() {
    return {
      threshold: config.context.compactThreshold ?? 0.8,
      keepRecent: config.context.keepRecent ?? 8,
      summaryMaxChars: config.context.summaryMaxChars ?? 1200,
      toolResultKeepChars: config.context.toolResultKeepChars ?? 600,
      summaryEnabled: config.context.summary !== false,
    };
  }

  /** @param {string} trigger @param {(() => {pressure: number|null, tokens: number})|undefined} measure */
  function shouldCompact(trigger, measure) {
    if (trigger === 'manual' || trigger === 'overflow' || trigger === 'dropped') return true;
    const snapshot = measure?.();
    return Boolean(snapshot && snapshot.pressure !== null && snapshot.pressure >= spec().threshold);
  }

  /**
   * @param {{record: any, trigger?: 'pressure'|'overflow'|'manual'|'dropped', deadline?: number, measure?: () => {pressure: number|null, tokens: number}}} input
   */
  async function compactIfNeeded(input) {
    const trigger = input.trigger ?? 'pressure';
    if (!shouldCompact(trigger, input.measure)) return null;
    return run(input.record, { trigger, deadline: input.deadline, measure: input.measure });
  }

  /**
   * @param {any} record
   * @param {{trigger: string, deadline?: number, measure?: () => {pressure: number|null, tokens: number}}} context
   */
  async function run(record, context) {
    const limits = spec();
    const before = context.measure?.() ?? null;
    let changed = false;
    let summarized = false;
    let pruned = false;

    const enough = () => {
      if (context.trigger !== 'pressure') return false;
      const snapshot = context.measure?.();
      return Boolean(snapshot && snapshot.pressure !== null && snapshot.pressure < limits.threshold * 0.7);
    };

    const pruneResult = pruneToolResults(record, {
      keepChars: limits.toolResultKeepChars,
      keepRecent: 2,
    });
    pruned = pruneResult.changed;
    changed = changed || pruned;

    if (!enough() && limits.summaryEnabled) {
      const summaryResult = await summarizeRange(record, {
        keepRecent: limits.keepRecent,
        summaryMaxChars: limits.summaryMaxChars,
        deadline: context.deadline,
        summarize,
      });
      summarized = summaryResult.changed;
      changed = changed || summarized;
    }

    const after = context.measure?.() ?? null;
    if (changed) {
      metrics?.inc('context.compact');
      logger?.info('context compacted', {
        trigger: context.trigger,
        tokensBefore: before?.tokens,
        tokensAfter: after?.tokens,
        pruned,
        summarized,
        icon: '🧰',
      });
    }

    return {
      changed,
      summarized,
      pruned,
      tokensBefore: before?.tokens ?? null,
      tokensAfter: after?.tokens ?? null,
      pressureBefore: before?.pressure ?? null,
      pressureAfter: after?.pressure ?? null,
    };
  }

  return { compactIfNeeded, spec };
}
