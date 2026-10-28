import { HttpError } from '../../http.js';

/**
 * @typedef {object} NimToolCall
 * @property {string} id
 * @property {string} name
 * @property {any} arguments
 * @property {string} rawArguments
 */

/**
 * @param {any} choice
 * @returns {{content: string, toolCalls: NimToolCall[], reasoning: string, finishReason: string, usage: any}}
 */
function parseChoice(choice) {
  const message = choice?.message ?? {};
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  /** @type {NimToolCall[]} */
  const toolCalls = rawCalls.map((call, index) => {
    const raw = call?.function?.arguments ?? '{}';
    let parsed = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = {};
    }
    return {
      id: String(call?.id ?? `call_${index}`),
      name: String(call?.function?.name ?? ''),
      arguments: parsed,
      rawArguments: typeof raw === 'string' ? raw : JSON.stringify(raw ?? {}),
    };
  });
  return {
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls,
    reasoning: typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
    finishReason: String(choice?.finish_reason ?? ''),
    usage: null,
  };
}

/**
 * Token generation speed: completion tokens divided by the real generation time (TTFT
 * subtracted when available), rounded to 1 decimal place.
 * @param {number} tokens
 * @param {number} ms
 * @returns {number}
 */
function tokensPerSec(tokens, ms) {
  const count = Number(tokens);
  const time = Number(ms);
  if (!Number.isFinite(count) || !Number.isFinite(time) || count <= 0 || time <= 0) return 0;
  return Math.round((count / (time / 1000)) * 10) / 10;
}

/**
 * Map the shared mode (none/low/medium/high/auto) to the `reasoning_effort` value
 * each provider accepts. DeepSeek only accepts none|low|high|max.
 * @param {string} mode
 * @param {Record<string, string>} map
 */
function reasoningEffort(mode, map) {
  const key = mode === 'auto' ? 'auto' : mode;
  return map[key] ?? map.none ?? 'none';
}

export const NIM_REASONING_MAP = {
  none: 'none',
  low: 'low',
  medium: 'medium',
  high: 'high',
  auto: 'low',
};

export const DEEPSEEK_REASONING_MAP = {
  none: 'none',
  low: 'low',
  medium: 'high',
  high: 'high',
  auto: 'low',
};

/**
 * OpenAI-compatible adapter (NVIDIA NIM, DeepSeek, ...).
 * The wire format lives entirely here; the service only knows the neutral vocabulary.
 * @param {{provider?: string, apiKey: string, baseUrl: string, model: string, http: ReturnType<typeof import('../../http.js').createHttp>, logger: import('../../logger.js').Logger, metrics?: any, defaultTemperature?: number, reasoningMap?: Record<string,string>}} options
 */
export function createOpenAiCompatAdapter(options) {
  const provider = options.provider ?? 'nim';
  const apiKey = options.apiKey;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const model = options.model;
  const http = options.http;
  const logger = options.logger;
  const metrics = options.metrics;
  const defaultTemperature = options.defaultTemperature ?? 0.6;
  const reasoningMap = options.reasoningMap ?? NIM_REASONING_MAP;

  const endpoint = `${baseUrl}/chat/completions`;

  // Breaker keyed by provider+model: one slow/hung model does not lock the whole provider.
  /** @param {unknown} modelId */
  const routeKey = (modelId) => `${provider}:${String(modelId ?? model)}`;

  /**
   * @param {Record<string, any>} payload
   * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
   */
  async function post(payload, opts = {}) {
    return http.requestJson(endpoint, {
      service: routeKey(payload.model),
      label: 'chat.completions',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      timeoutMs: opts.timeoutMs ?? 28_000,
      retries: 0,
      signal: opts.signal ?? undefined,
    });
  }

  /**
   * @param {{messages: any[], tools?: any[], toolChoice?: any, model?: string, reasoning?: 'none'|'low'|'medium'|'high'|'auto', temperature?: number, maxTokens?: number|null, signal?: AbortSignal|null, timeoutMs?: number, ttftMs?: number, stream?: boolean, onDelta?: (text: string) => void|Promise<void>}} input
   */
  async function chat(input) {
    /** @type {any} */
    const payload = {
      model: input.model ?? model,
      messages: input.messages,
      temperature: input.temperature ?? defaultTemperature,
      reasoning_effort: reasoningEffort(input.reasoning ?? 'none', reasoningMap),
    };
    if (input.tools?.length) {
      payload.tools = input.tools;
      payload.tool_choice = input.toolChoice ?? 'auto';
    }
    if (input.maxTokens !== null && input.maxTokens !== undefined) {
      payload.max_tokens = input.maxTokens;
    }

    const started = Date.now();
    const latency = () => Date.now() - started;

    if (!input.stream) {
      const response = await post(payload, { signal: input.signal, timeoutMs: input.timeoutMs });
      const data = /** @type {any} */ (response.data);
      const choice = data?.choices?.[0];
      const parsed = parseChoice(choice);
      const usage = data?.usage ?? null;
      metrics?.inc('llm.calls');
      metrics?.inc('llm.promptTokens', usage?.prompt_tokens ?? 0);
      metrics?.inc('llm.completionTokens', usage?.completion_tokens ?? 0);
      metrics?.observe('llm.latency', latency());
      const ms = latency();
      const completionTokens = Number(usage?.completion_tokens ?? 0);
      const tps = tokensPerSec(completionTokens, ms);
      if (tps) metrics?.gauge?.('llm.tokensPerSec', tps);
      logger.debug('llm response', {
        provider,
        model: payload.model,
        finish: parsed.finishReason,
        toolCalls: parsed.toolCalls.length,
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
        ms,
        tps,
      });
      return {
        ...parsed,
        usage,
        latencyMs: ms,
        completionTokens,
        ttftMs: ms,
        completionMs: ms,
        tokensPerSec: tps,
        aborted: false,
      };
    }

    payload.stream = true;
    payload.stream_options = { include_usage: true };

    // Timeout for the "first byte" (TTFT), not the whole answer:
    // NIM sometimes hangs a request and we must bail early to retry; a long answer still keeps generating.
    const ttftMs = input.ttftMs ?? 8000;
    const ttftController = new AbortController();
    let ttftTimer = setTimeout(() => {
      try {
        ttftController.abort();
      } catch {
        // ignore
      }
    }, ttftMs);
    /** @type {AbortSignal} */
    const streamSignal = input.signal
      ? // @ts-ignore AbortSignal.any is available since Node 20.3
        AbortSignal.any([input.signal, ttftController.signal])
      : ttftController.signal;

    /** @type {Response} */
    let response;
    try {
      response = await http.openStream(endpoint, {
        service: routeKey(payload.model),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        timeoutMs: input.timeoutMs ?? 60_000,
        retries: 0,
        signal: streamSignal,
      });
    } catch (error) {
      clearTimeout(ttftTimer);
      // Our own first-token guard fired (the caller's budget is still intact): the request
      // may succeed on a retry, so this must stay retryable — unlike a caller abort.
      if (ttftController.signal.aborted && !input.signal?.aborted) {
        throw new HttpError(`${routeKey(payload.model)} first token timeout`, {
          service: routeKey(payload.model),
          retryable: true,
          cause: error,
        });
      }
      throw error;
    }

    let content = '';
    let reasoning = '';
    let finishReason = '';
    /** @type {number} when the first content token arrived (to compute the real TTFT) */
    let firstDeltaAt = 0;
    /** @type {any} */
    let usage = null;
    /** @type {Map<number, {id: string, name: string, args: string}>} */
    const callMap = new Map();

    const body = response.body;
    let streamError = null;
    if (body) {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf('\n');
          while (newline >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, '').trim();
            buffer = buffer.slice(newline + 1);
            if (line.startsWith('data:')) {
              const raw = line.slice(5).trim();
              if (raw && raw !== '[DONE]') {
                let chunk;
                try {
                  chunk = JSON.parse(raw);
                } catch {
                  chunk = null;
                }
                if (chunk) {
                  if (chunk.usage) usage = chunk.usage;
                  const choice = chunk.choices?.[0];
                  if (choice) {
                    const delta = choice.delta ?? {};
                    if (choice.finish_reason) finishReason = String(choice.finish_reason);
                    if (typeof delta.content === 'string' && delta.content) {
                      // A real token arrived: the first-token guard is satisfied.
                      clearTimeout(ttftTimer);
                      content += delta.content;
                      if (!firstDeltaAt) firstDeltaAt = Date.now();
                      if (input.onDelta) await input.onDelta(delta.content);
                    }
                    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                      clearTimeout(ttftTimer);
                      reasoning += delta.reasoning_content;
                    }
                    if (Array.isArray(delta.tool_calls)) {
                      clearTimeout(ttftTimer);
                      for (const part of delta.tool_calls) {
                        const index = Number(part.index ?? 0);
                        const current = callMap.get(index) ?? { id: '', name: '', args: '' };
                        if (part.id) current.id = String(part.id);
                        if (part.function?.name) current.name += String(part.function.name);
                        if (part.function?.arguments) current.args += String(part.function.arguments);
                        callMap.set(index, current);
                      }
                    }
                  }
                }
              }
            }
            newline = buffer.indexOf('\n');
          }
        }
      } catch (error) {
        streamError = error;
      } finally {
        clearTimeout(ttftTimer);
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
      }
    }

    if (streamError && !content && callMap.size === 0) {
      // Same split as above: guard fired → retryable; caller's deadline → no time left.
      if (ttftController.signal.aborted && !input.signal?.aborted) {
        throw new HttpError(`${routeKey(payload.model)} first token timeout`, {
          service: routeKey(payload.model),
          retryable: true,
          cause: streamError,
        });
      }
      throw streamError;
    }

    /** @type {NimToolCall[]} */
    const toolCalls = [...callMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, value]) => {
        let parsed = {};
        try {
          parsed = value.args ? JSON.parse(value.args) : {};
        } catch {
          parsed = {};
        }
        return {
          id: value.id || `call_${index}`,
          name: value.name,
          arguments: parsed,
          rawArguments: value.args,
        };
      })
      .filter((call) => call.name);

    metrics?.inc('llm.calls');
    metrics?.inc('llm.streamCalls');
    if (usage?.prompt_tokens) metrics?.inc('llm.promptTokens', usage.prompt_tokens);
    if (usage?.completion_tokens) metrics?.inc('llm.completionTokens', usage.completion_tokens);
    metrics?.observe('llm.latency', latency());

    const ms = latency();
    const completionTokens = Number(usage?.completion_tokens ?? 0);
    // TTFT = from sending the request to the first content token; only the rest is
    // real generation time, so tok/s is computed over completionMs, not ms.
    const firstTokenMs = firstDeltaAt ? firstDeltaAt - started : ms;
    const completionMs = Math.max(0, ms - firstTokenMs);
    const tps = tokensPerSec(completionTokens, completionMs || ms);
    if (tps) metrics?.gauge?.('llm.tokensPerSec', tps);
    logger.debug('llm response', {
      provider,
      model: payload.model,
      stream: true,
      finish: finishReason,
      toolCalls: toolCalls.length,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
      ms,
      ttft: firstTokenMs,
      tps,
      ...(streamError ? { error: String(/** @type {any} */ (streamError)?.message ?? streamError) } : {}),
    });

    return {
      content,
      reasoning,
      toolCalls,
      finishReason,
      usage,
      latencyMs: ms,
      completionTokens,
      ttftMs: firstTokenMs,
      completionMs,
      tokensPerSec: tps,
      aborted: Boolean(streamError),
      streamError: streamError ? String(/** @type {any} */ (streamError)?.message ?? streamError) : undefined,
    };
  }

  /**
   * Fire one very short request to "warm up" the model, reducing cold start for the first message.
   * Never throws and never logs noisily: warmup is an optimization, not a survival requirement.
   * @param {{model?: string, timeoutMs?: number}} [options]
   * @returns {Promise<{ok: boolean, ms: number, model: string, error?: string}>}
   */
  async function warmup(options = {}) {
    const targetModel = options.model ?? model;
    const started = Date.now();
    try {
      await chat({
        model: targetModel,
        messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
        reasoning: 'none',
        maxTokens: 1,
        temperature: 0,
        // Keep it short: if the model hangs, drop it; real messages still run normally.
        timeoutMs: options.timeoutMs ?? 8_000,
      });
      const ms = Date.now() - started;
      metrics?.observe('llm.warmup', ms);
      metrics?.gauge?.('llm.warmupMs', ms);
      return { ok: true, ms, model: targetModel };
    } catch (error) {
      return {
        ok: false,
        ms: Date.now() - started,
        model: targetModel,
        error: String(/** @type {any} */ (error)?.message ?? error),
      };
    }
  }

  return { id: provider, chat, warmup, model, endpoint, provider, credentialed: Boolean(apiKey) };
}

export const __test__ = { parseChoice, reasoningEffort, tokensPerSec };
