import { addFact, clearFacts, latestSummary, MAX_FACTS, removeFact } from '../context/record.js';
import { createTokenMeter } from '../context/token-meter.js';
import { SUMMARY_SYSTEM_PROMPT } from '../ai/prompt/index.js';
import { formatDuration } from '../text/format.js';
import { REMINDER_LIMITS, formatReminderTime, parseReminderArgs } from '../ai/reminders.js';

const SUMMARY_DEFAULT_COUNT = 30;
const SUMMARY_MAX_COUNT = 200;
const SUMMARY_MAX_TRANSCRIPT = 12_000;
const SUMMARY_TIMEOUT_MS = 15_000;

/**
 * @param {string} text
 * @returns {{name: string, args: string}|null}
 */
export function parseCommand(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('/')) return null;
  const match = trimmed.match(/^\/([a-zA-Z0-9_]+)(?:@[^\s]+)?(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

/**
 * @param {{config: any, store: ReturnType<typeof import('../context/store.js').createContextStore>, metrics: ReturnType<typeof import('../metrics.js').createMetrics>, zalo: ReturnType<typeof import('../zalo/client.js').createZaloClient>, http: ReturnType<typeof import('../http.js').createHttp>, models: ReturnType<typeof import('../ai/router.js').createModelRouter>, stickers?: ReturnType<typeof import('../ai/stickers.js').createStickerStore>, reminders?: ReturnType<typeof import('../ai/reminders.js').createReminderStore>, logger?: import('../logger.js').Logger, compaction?: ReturnType<typeof import('../context/compaction/engine.js').createCompactionEngine>}} deps
 */
export function createCommands(deps) {
  const { config, store, metrics, zalo, models, compaction } = deps;
  const http = deps.http;
  const stickers = deps.stickers;
  const reminders = deps.reminders;
  const logger = deps.logger;

  function canManage(ctx) {
    if (!config.adminIds.length) return true;
    if (ctx.chatType !== 'GROUP') return true;
    return config.adminIds.includes(ctx.senderId);
  }

  function helpText() {
    const lines = [
      '**Bot commands**',
      '• `/help` — list of commands',
      '• `/status` — bot status, context, latency',
      '• `/id` — id of the current chat',
      '• `/reset` — clear this chat\'s context (keeps model/tone); `/reset all` also clears the settings',
      '• `/compact` — compact the context now (admin)',
      '• `/summary [N]` — summarize the last N messages (default 30)',
      '• `/search <question>` — force a web search for the question',
      '• `/image <keywords>` — find and send an image',
      '• `/sticker [mood]` — send a sticker; `/sticker add <id> [name]` to add an ID',
      '• `/remind <time> <text>` — set a reminder (e.g. `/remind 20:00 tomorrow team meeting`)',
      '• `/remember <fact>` — pin a fact the bot must not forget; `/forget <n|text|all>`',
      '• `/model` — view/change the model for this chat',
      '• `/tone` — view/change the tone (roast = snarky)',
      '• `/think on|off|low|medium|high|auto` — turn reasoning on/off for this chat',
      '• `/split on|off|auto` — disable/enable splitting replies into multiple messages',
      '• `/ping` — check the connection to Zalo',
      '',
      config.mode === 'polling'
        ? 'The bot is running in polling mode (local).'
        : 'The bot is running in webhook mode.',
      'In groups, **@mention the bot** or **reply** to one of its messages so it answers.',
    ];
    return lines.join('\n');
  }

  /** @param {{chatId: string, chatType: string, senderId: string}} ctx @param {any} record */
  async function statusText(ctx, record) {
    const snapshot = metrics.snapshot();
    const nimLatency = snapshot.latency['llm.latency'];
    const replyLatency = snapshot.latency['agent.reply'];
    const count = (name) => snapshot.counters[name] ?? 0;
    const messages = record?.messages?.length ?? 0;
    const factsCount = Array.isArray(record?.meta?.facts) ? record.meta.facts.length : 0;
    const thinking = record?.meta?.thinking ?? 'per config';
    const current = models.resolve(record);
    const contextBudget =
      config.context.maxTokens > 0 || config.context.maxMessages > 0
        ? `${config.context.maxTokens > 0 ? `${config.context.maxTokens} token` : '∞ token'} / ${
            config.context.maxMessages > 0 ? `${config.context.maxMessages} msg` : '∞ msg'
          }`
        : 'unlimited';
    const replyLimit =
      config.maxMessagesPerReply > 0 ? `${config.maxMessagesPerReply} msg` : 'unlimited';
    const generationSpeed = Number(snapshot.gauges?.['llm.tokensPerSec'] ?? 0);
    const contextFiles = typeof store.count === 'function' ? await store.count() : null;
    const contextStore = `• Context storage: \`${config.context.dir}\`${
      contextFiles === null ? '' : ` · ${contextFiles} file`
    } · TTL ${config.context.ttlHours > 0 ? `${config.context.ttlHours}h` : 'never'}`;
    const estimated = createTokenMeter().messages(record?.messages ?? []);
    const window = Number(current.contextWindow ?? config.context.modelWindow ?? 0);
    const pressure = `• Context pressure: ~${estimated} token${window > 0 ? ` / ${window} (${Math.round((estimated / window) * 100)}%)` : ' (context window unknown)'}`;

    /** @type {string[]} */
    const lines = [
      '**Bot status**',
      `• Model: \`${current.alias}\` — ${current.label} (\`${current.model}\`, ${current.provider})`,
      `• Mode: ${config.mode} · Reasoning: ${config.ai.reasoning} (this chat: ${thinking})`,
      `• max_tokens: ${config.ai.maxTokens ?? 'unlimited'}`,
      `• Uptime: ${formatDuration(snapshot.uptimeSec * 1000)} · bot v${config.version ?? '?'}`,
      `• Context: ${messages} msg · ${record?.turns ?? 0} turns · ${factsCount} facts · budget: ${contextBudget} · summary: ${latestSummary(record) ? 'yes' : 'no'}`,
      pressure,
      contextStore,
      `• Reply limit: ${replyLimit}`,
      `• LLM latency: p50 ${nimLatency ? `${nimLatency.p50}ms` : 'n/a'} · p95 ${nimLatency ? `${nimLatency.p95}ms` : 'n/a'}${generationSpeed > 0 ? ` · ~${generationSpeed} tok/s` : ''}`,
      `• Replies: p50 ${replyLatency ? `${replyLatency.p50}ms` : 'n/a'} · p95 ${replyLatency ? `${replyLatency.p95}ms` : 'n/a'}`,
      `• Received: ${count('messages.in')} · Replied: ${count('messages.replied')} · Errors: ${count('messages.error')}`,
      `• Web search: ${config.search.enabled ? `${config.search.depth}/${config.search.maxResults} (auto: ${config.search.auto ? 'on' : 'off'})` : 'off'} · Images: ${config.image.enabled ? 'on' : 'off'}`,
      `• Typing: ${config.typing ? 'on' : 'off'} · Progressive: ${config.progressive}${record?.meta?.split ? ` (this chat: ${record.meta.split})` : ''}`,
      `• Chat: \`${ctx.chatId}\` (${ctx.chatType})`,
    ];

    if (http?.listStates) {
      /** @type {Map<string, {service: string, failures: number, open: boolean}>} */
      const states = new Map();
      for (const state of http.listStates()) states.set(state.service, state);
      for (const name of ['zalo', 'tavily']) {
        if (!states.has(name)) states.set(name, { service: name, failures: 0, open: false });
      }
      const parts = [...states.values()].map(
        (state) => `${state.service}: ${state.open ? `open (${state.failures} errors)` : 'ok'}`,
      );
      lines.push(`• Circuit: ${parts.join(' · ')}`);
    }

    return lines.join('\n');
  }

  /**
   * @param {{name: string, args: string}} command
   * @param {{chatId: string, chatType: string, senderId: string, senderName: string, record: any}} ctx
   */
  async function run(command, ctx) {
    const name = command.name;
    const args = command.args;

    switch (name) {
      case 'help':
        return { kind: 'text', text: helpText() };

      case 'id':
        return {
          kind: 'text',
          text: `Chat id: \`${ctx.chatId}\`\nType: ${ctx.chatType}\nSender: ${ctx.senderName} (\`${ctx.senderId}\`)`,
        };

      case 'reset': {
        if (!canManage(ctx)) {
          return { kind: 'text', text: 'Only group admins can use /reset.' };
        }
        const full = args.trim().toLowerCase() === 'all';
        const turns = ctx.record?.turns ?? 0;
        // Facts are memory, not settings: a normal /reset forgets them too.
        if (!full && Array.isArray(ctx.record?.meta?.facts)) ctx.record.meta.facts = [];
        await store.reset(ctx.chatId, { keepMeta: !full });
        logger?.info('context reset', { chatId: ctx.chatId, turns, full });
        return {
          kind: 'text',
          text: full
            ? `Cleared all context and settings for this chat (${turns} turns). It is like new.`
            : `Cleared this chat's context (${turns} turns) but kept the settings (model/tone/think). Use \`/reset all\` to clear the settings too.`,
        };
      }

      case 'status':
        return { kind: 'text', text: await statusText(ctx, ctx.record) };

      case 'compact': {
        if (!canManage(ctx)) return { kind: 'text', text: 'Only group admins can compact the context.' };
        if (!compaction) return { kind: 'text', text: 'Compaction is not configured.' };
        const meter = createTokenMeter();
        const before = meter.messages(ctx.record.messages);
        const result = await compaction.compactIfNeeded({ record: ctx.record, trigger: 'manual' });
        if (!result?.changed) {
          return { kind: 'text', text: 'The context does not need compaction yet (no safe range left to compact).' };
        }
        store.touch?.(ctx.chatId);
        const after = meter.messages(ctx.record.messages);
        const parts = [];
        if (result.summarized) parts.push('summary');
        if (result.pruned) parts.push('pruned tool results');
        return { kind: 'text', text: `Compacted context (${parts.join(', ')}) — ~${before} → ~${after} tokens.` };
      }

      case 'summary': {
        const raw = args.trim();
        let count = SUMMARY_DEFAULT_COUNT;
        if (raw) {
          const parsed = Number(raw);
          if (!Number.isInteger(parsed) || parsed < 2 || parsed > SUMMARY_MAX_COUNT) {
            return {
              kind: 'text',
              text: `Use \`/summary [count]\` (2–${SUMMARY_MAX_COUNT}, default ${SUMMARY_DEFAULT_COUNT}).`,
            };
          }
          count = parsed;
        }
        const history = (ctx.record?.messages ?? [])
          .filter(
            (message) =>
              (message.kind ?? 'turn') === 'turn' &&
              typeof message.text === 'string' &&
              message.text.trim().length > 0,
          )
          .slice(-count);
        if (history.length < 2) {
          return { kind: 'text', text: 'Not enough messages to summarize (need at least 2).' };
        }
        const transcript = history
          .map(
            (message) =>
              `${message.role === 'assistant' ? 'Bot' : message.name || 'User'}: ${String(message.text).trim()}`,
          )
          .join('\n')
          .slice(0, SUMMARY_MAX_TRANSCRIPT);
        const timeoutMs =
          config.responseTimeoutMs > 0
            ? Math.max(1500, Math.min(SUMMARY_TIMEOUT_MS, config.responseTimeoutMs - 300))
            : SUMMARY_TIMEOUT_MS;
        try {
          const response = await models.chat({
            record: ctx.record,
            messages: [
              { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
              { role: 'user', content: transcript },
            ],
            reasoning: 'none',
            temperature: 0.3,
            maxTokens: 300,
            stream: false,
            timeoutMs,
            signal: AbortSignal.timeout(timeoutMs),
          });
          const text = String(/** @type {any} */ (response)?.content ?? '').trim();
          if (!text) {
            return { kind: 'text', text: 'The model returned no summary; try again later.' };
          }
          return { kind: 'text', text: `**Summary of the last ${history.length} messages:**\n\n${text}` };
        } catch (error) {
          logger?.warn('summary command failed', {
            error: String(/** @type {any} */ (error)?.message ?? error),
          });
          return { kind: 'text', text: `Could not summarize: ${String(/** @type {any} */ (error)?.message ?? error)}` };
        }
      }

      case 'search': {
        if (!args) return { kind: 'text', text: 'Usage: `/search <question>`' };
        if (!config.search.enabled) return { kind: 'text', text: 'Web search is disabled in the config.' };
        return { kind: 'search', query: args };
      }

      case 'image': {
        if (!args) return { kind: 'text', text: 'Usage: `/image <keywords>`' };
        if (!config.image.enabled) return { kind: 'text', text: 'Image sending is disabled.' };
        return { kind: 'image', query: args };
      }

      case 'sticker': {
        if (!config.sticker.enabled) {
          return { kind: 'text', text: 'The sticker feature is disabled in the config.' };
        }
        if (!stickers) {
          return { kind: 'text', text: 'No sticker catalog yet.' };
        }
        const raw = args.trim();
        const lower = raw.toLowerCase();

        const listText = () => {
          const items = stickers.list();
          return [
            `**Stickers** — ${items.length} IDs available`,
            'Send: `/sticker <name or mood>`. Admins add IDs with `/sticker add <id> [name]`.',
            'Only **official sticker IDs** are accepted (20 hex chars); pack IDs from stickers.zaloapp.com make Zalo return error 425.',
            '',
            ...items
              .slice(0, 20)
              .map(
                (item) =>
                  `• \`${item.id}\` — ${item.name}${item.tags.length ? ` (${item.tags.slice(0, 3).join(', ')})` : ''}`,
              ),
          ].join('\n');
        };

        if (!raw || lower === 'list' || lower === 'danh s\u00E1ch') {
          return { kind: 'text', text: listText() };
        }

        if (lower === 'add' || lower.startsWith('add ')) {
          if (!canManage(ctx)) {
            return { kind: 'text', text: 'Only group admins can add stickers.' };
          }
          const rest = raw.slice(3).trim();
          const [idPart, ...nameParts] = rest.split(/\s+/);
          if (!idPart) return { kind: 'text', text: 'Usage: `/sticker add <id> [name]`' };
          if (!/^[a-f0-9]{20}$/i.test(idPart)) {
            return { kind: 'text', text: 'The sticker ID must be exactly 20 hex characters (for example `0e078a2fb66a5f34067b`).' };
          }
          try {
            // send once so Zalo confirms the ID is valid
            await zalo.sendSticker(ctx.chatId, idPart);
          } catch (error) {
            return {
              kind: 'text',
              text: `Zalo rejected the sticker \`${idPart}\`: ${String(/** @type {any} */ (error)?.message ?? error)}`,
            };
          }
          try {
            const { item, added } = await stickers.add({ id: idPart, name: nameParts.join(' ') || undefined });
            return {
              kind: 'text',
              text: added
                ? `Added and test-sent the sticker **${item.name}** (\`${item.id}\`).`
                : `The sticker **${item.name}** was already there — just test-sent it.`,
            };
          } catch (error) {
            return { kind: 'text', text: `Could not save the sticker: ${String(/** @type {any} */ (error)?.message ?? error)}` };
          }
        }

        if (lower === 'remove' || lower === 'xoa' || lower.startsWith('remove ') || lower.startsWith('xoa ')) {
          if (!canManage(ctx)) {
            return { kind: 'text', text: 'Only group admins can remove stickers.' };
          }
          const target = raw.replace(/^(remove|xoa)\s+/i, '').trim();
          if (!target || ['remove', 'xoa'].includes(target.toLowerCase())) {
            return { kind: 'text', text: 'Usage: `/sticker remove <id|name>`' };
          }
          const removed = await stickers.remove(target);
          return {
            kind: 'text',
            text: removed
              ? `Removed the sticker **${removed.name}** (\`${removed.id}\`).`
              : `No sticker named "${target}" was found in the self-added list.`,
          };
        }

        const item = stickers.find(raw);
        if (!item) {
          return { kind: 'text', text: `No sticker matches "${raw}".\n\n${listText()}` };
        }
        return { kind: 'sticker', stickerId: item.id, name: item.name };
      }

      case 'model': {
        if (!canManage(ctx)) {
          return { kind: 'text', text: 'Only group admins can change the model.' };
        }
        const current = models.resolve(ctx.record);
        if (!args) {
          const lines = [
            `**Current model:** \`${current.alias}\` — ${current.label} (\`${current.model}\`, ${current.provider})`,
            '',
            '**Change the model for this chat:**',
            ...models
              .list()
              .map((item) => `• \`/model ${item.alias}\` — ${item.label} (${item.provider}/${item.model})`),
          ];
          return { kind: 'text', text: lines.join('\n') };
        }
        const picked = models.find(args);
        if (!picked) {
          return {
            kind: 'text',
            text: `No model named "${args}". Choose: ${models.list().map((item) => item.alias).join(', ')}`,
          };
        }
        if (!ctx.record.meta) ctx.record.meta = { thinking: null };
        ctx.record.meta.model = picked.alias;
        try {
          store.touch?.(ctx.chatId);
        } catch (error) {
          logger?.debug('persist model failed', { error: String(error) });
        }
        return { kind: 'text', text: `Switched to **${picked.label}** (\`${picked.model}\`, ${picked.provider}).` };
      }

      case 'think': {
        if (!canManage(ctx)) {
          return { kind: 'text', text: 'Only group admins can change the reasoning mode.' };
        }
        if (!ctx.record.meta) ctx.record.meta = { thinking: null };
        const value = args.toLowerCase();
        const persist = () => {
          // persist the reasoning choice for this chat right away
          try {
            store.touch?.(ctx.chatId);
          } catch (error) {
            logger?.debug('persist thinking mode failed', { error: String(error) });
          }
        };
        if (!value) {
          return {
            kind: 'text',
            text: `Current reasoning mode: ${ctx.record.meta.thinking ?? 'per config'}. Use \`/think off|low|high\`.`,
          };
        }
        if (['off', 'none'].includes(value)) {
          ctx.record.meta.thinking = 'off';
          persist();
          return { kind: 'text', text: 'Reasoning is now off for this chat (faster replies).' };
        }
        if (['on', 'low'].includes(value)) {
          ctx.record.meta.thinking = 'low';
          persist();
          return { kind: 'text', text: 'Reasoning is now on at low level for this chat.' };
        }
        if (['medium', 'high'].includes(value)) {
          ctx.record.meta.thinking = value;
          persist();
          return { kind: 'text', text: `Reasoning is now set to ${value} level for this chat.` };
        }
        if (['auto', 'default'].includes(value)) {
          ctx.record.meta.thinking = null;
          persist();
          return { kind: 'text', text: 'Back to the reasoning mode from the config.' };
        }
        return { kind: 'text', text: 'Invalid value. Use `/think off|low|high|auto`.' };
      }

      case 'remember': {
        if (!canManage(ctx)) {
          return { kind: 'text', text: 'Only group admins can change what the bot remembers.' };
        }
        const text = args.trim();
        if (!text) {
          const facts = Array.isArray(ctx.record?.meta?.facts) ? ctx.record.meta.facts : [];
          if (!facts.length) {
            return { kind: 'text', text: 'No pinned facts yet. Use `/remember <fact>`.' };
          }
          return {
            kind: 'text',
            text: [
              `**Pinned facts for this chat** (${facts.length}/${MAX_FACTS})`,
              ...facts.map((fact, index) => `${index + 1}. ${fact.text}`),
              '',
              'Remove with `/forget <number|keyword>` or `/forget all`.',
            ].join('\n'),
          };
        }
        const result = addFact(ctx.record, text);
        if (!result.added) {
          const message =
            result.reason === 'duplicate'
              ? 'I already remember that.'
              : result.reason === 'full'
                ? `The ${MAX_FACTS}-fact limit is reached — remove one with \`/forget\`.`
                : 'The fact is empty.';
          return { kind: 'text', text: message };
        }
        store.touch?.(ctx.chatId);
        return { kind: 'text', text: `Remembered: ${/** @type {any} */ (result.fact).text}` };
      }

      case 'forget': {
        if (!canManage(ctx)) {
          return { kind: 'text', text: 'Only group admins can change what the bot remembers.' };
        }
        const target = args.trim();
        if (!target) {
          return { kind: 'text', text: 'Use `/forget <number|keyword>` or `/forget all`.' };
        }
        if (target.toLowerCase() === 'all') {
          const count = clearFacts(ctx.record);
          if (!count) return { kind: 'text', text: 'There are no pinned facts to forget.' };
          store.touch?.(ctx.chatId);
          return { kind: 'text', text: `Forgot ${count} pinned fact${count === 1 ? '' : 's'}.` };
        }
        const removed = removeFact(ctx.record, target);
        if (!removed) {
          return { kind: 'text', text: `No pinned fact matches "${target}".` };
        }
        store.touch?.(ctx.chatId);
        return { kind: 'text', text: `Forgot: ${removed.text}` };
      }

      case 'remind': {
        if (!reminders) {
          return { kind: 'text', text: 'Reminders are not configured.' };
        }
        const raw = args.trim();
        const lower = raw.toLowerCase();
        const listText = () => {
          const items = reminders
            .list(ctx.chatId)
            .slice()
            .sort((a, b) => a.at - b.at);
          if (!items.length) {
            return `No reminders in this chat yet. Use \`/remind 20:00 tomorrow team meeting\`.`;
          }
          return [
            `**Reminders in this chat** (${items.length}/${REMINDER_LIMITS.MAX_PER_CHAT})`,
            ...items.map((item) => `• #${item.id} — ${formatReminderTime(item.at)} — ${item.text}`),
            '',
            'Remove with `/remind remove <id>`.',
          ].join('\n');
        };

        if (!raw || ['list', 'danh sách', 'danh sach'].includes(lower)) {
          return { kind: 'text', text: listText() };
        }

        const cancel = /^(remove|cancel|xoa|xóa)(?:\s+|$)/i.exec(raw);
        if (cancel) {
          const target = raw.slice(cancel[0].length).trim();
          if (!target) {
            return { kind: 'text', text: 'Use `/remind remove <id>` (see ids with `/remind list`).' };
          }
          const removed = await reminders.remove(ctx.chatId, target);
          return {
            kind: 'text',
            text: removed
              ? `Removed reminder #${removed.id}: ${removed.text}`
              : `No reminder "${target}" in this chat.`,
          };
        }

        const parsed = parseReminderArgs(raw);
        if (parsed.error) return { kind: 'text', text: parsed.error };
        const result = await reminders.add({
          chatId: ctx.chatId,
          text: /** @type {string} */ (parsed.text),
          at: /** @type {number} */ (parsed.at),
          createdBy: ctx.senderId,
        });
        if (!result.ok) {
          const reason = /** @type {any} */ (result).reason;
          return {
            kind: 'text',
            text:
              reason === 'chat-limit'
                ? `This chat already has ${REMINDER_LIMITS.MAX_PER_CHAT} reminders — remove one with \`/remind remove <id>\`.`
                : 'The total reminder limit is reached; try again later.',
          };
        }
        return {
          kind: 'text',
          text: `Reminder #${result.item.id} set for ${formatReminderTime(result.item.at)}: ${result.item.text}`,
        };
      }

      case 'split': {
        if (!canManage(ctx)) {
          return { kind: 'text', text: 'Only group admins can change the split mode.' };
        }
        if (!ctx.record.meta) ctx.record.meta = { thinking: null };
        const value = args.toLowerCase();
        const current = ctx.record.meta.split ?? 'per config';
        const persist = () => {
          try {
            store.touch?.(ctx.chatId);
          } catch (error) {
            logger?.debug('persist split mode failed', { error: String(error) });
          }
        };
        if (!value) {
          return {
            kind: 'text',
            text: `Split mode for this chat: **${current}** (global config: ${config.progressive}).\nUse \`/split off\` to merge replies into one message, \`/split on\` to split early, \`/split auto\` to follow the config.`,
          };
        }
        if (['off', 'tat', 't\u1EAFt', 'gop', 'g\u1ED9p'].includes(value)) {
          ctx.record.meta.split = 'off';
          persist();
          return {
            kind: 'text',
            text: 'Split replies disabled: the bot merges replies into one message. Messages that are too long (over 1900 characters) still have to be split because of Zalo\'s limit.',
          };
        }
        if (['on', 'bat', 'b\u1EADt'].includes(value)) {
          ctx.record.meta.split = 'on';
          persist();
          return { kind: 'text', text: 'Split replies enabled: the bot sends the first part as soon as a complete sentence is ready, so you wait less.' };
        }
        if (['auto', 'default', 'reset'].includes(value)) {
          ctx.record.meta.split = null;
          persist();
          return { kind: 'text', text: `Back to the split mode from the config (${config.progressive}).` };
        }
        return { kind: 'text', text: 'Invalid value. Use `/split off|on|auto`.' };
      }

      case 'tone': {
        if (!canManage(ctx)) {
          return { kind: 'text', text: 'Only group admins can change the tone.' };
        }
        if (!ctx.record.meta) ctx.record.meta = { thinking: null };
        const value = args.toLowerCase();
        const persist = () => {
          try {
            store.touch?.(ctx.chatId);
          } catch (error) {
            logger?.debug('persist tone failed', { error: String(error) });
          }
        };
        // The chat history is anchored very strongly to the old tone. Insert a bot message as a
        // "tone switch marker" so the next turn does not imitate the old tone.
        const markTone = (text) => {
          try {
            if (Array.isArray(ctx.record.messages)) {
              ctx.record.messages.push({
                role: 'assistant',
                text,
                ts: Date.now(),
              });
            }
          } catch (error) {
            logger?.debug('mark tone failed', { error: String(error) });
          }
          persist();
        };
        if (!value) {
          return {
            kind: 'text',
            text: `Tone for this chat: **${ctx.record.meta.tone ?? config.tone}** (global config: ${config.tone}).\nUse \`/tone roast\` (snarky, playful roasting) or \`/tone friendly\` (polite); \`/tone default\` to follow the config.`,
          };
        }
        if (['max', 'extreme', 'cuc', 'c\u1EF1c', 'sieu-nang', 'si\u00EAu n\u1EB7ng', 'g\u1EAFt', 'gat'].includes(value)) {
          ctx.record.meta.tone = 'roast-extreme';
          markTone('Ok, from now on I roast without holding back.');
          return { kind: 'text', text: '**Extreme roast** tone enabled for this chat 🔥🔥 (still no: family, discrimination, threats).' };
        }
        if (['hard', 'roast-hard', 'nang', 'n\u1EB7ng', 'manh', 'm\u1EA1nh'].includes(value)) {
          ctx.record.meta.tone = 'roast-hard';
          markTone('Ok, from now on I roast bluntly and harshly.');
          return { kind: 'text', text: '**Hard roast** tone enabled for this chat 🔥 (still no: discrimination, insults about family, threats).' };
        }
        if (['roast', 'cay', 'cakhia', 'c\u00E0 kh\u1ECBa', 'th\u00F4', 'tho'].includes(value)) {
          ctx.record.meta.tone = 'roast';
          markTone('Ok, from now on I tease you again 😈');
          return { kind: 'text', text: '**Roast** tone enabled for this chat 😈 (still limited: no discrimination, no insults about family).' };
        }
        if (['friendly', 'normal', 'thuong', 'th\u01B0\u1EDDng', 'l\u1ECBch s\u1EF1', 'lich su'].includes(value)) {
          ctx.record.meta.tone = 'friendly';
          markTone('Ok, from now on I talk politely and drop the roasting completely.');
          return { kind: 'text', text: 'Back to the polite tone for this chat.' };
        }
        if (['default', 'auto', 'reset'].includes(value)) {
          ctx.record.meta.tone = null;
          markTone('Ok, from now on I use the tone from the bot config.');
          return { kind: 'text', text: `Back to the tone from the config (${config.tone}).` };
        }
        return { kind: 'text', text: 'Invalid value. Use `/tone roast` or `/tone friendly`.' };
      }

      case 'ping': {
        try {
          const ms = await zalo.ping();
          return { kind: 'text', text: `Pong! The Zalo API replied in ${ms}ms.` };
        } catch (error) {
          return { kind: 'text', text: `Ping failed: ${String(/** @type {any} */ (error)?.message ?? error)}` };
        }
      }

      default:
        return { kind: 'text', text: `Unknown command \`/${name}\`. Type /help to see the list.` };
    }
  }

  return { run, parseCommand };
}
