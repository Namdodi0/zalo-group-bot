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
 * Tốc độ sinh token: completion tokens chia cho thời gian sinh thật (đã trừ TTFT
 * nếu có), làm tròn 1 chữ số thập phân.
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
 * Map mode chung (none/low/medium/high/auto) sang giá trị `reasoning_effort`
 * mà từng provider chấp nhận. DeepSeek chỉ nhận none|low|high|max.
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
 * Client OpenAI-compatible (NVIDIA NIM, DeepSeek, ...).
 * @param {{provider?: string, apiKey: string, baseUrl: string, model: string, http: ReturnType<typeof import('../http.js').createHttp>, logger: import('../logger.js').Logger, metrics?: any, defaultTemperature?: number, reasoningMap?: Record<string,string>}} options
 */
export function createLlmClient(options) {
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

  /**
   * @param {Record<string, any>} payload
   * @param {{signal?: AbortSignal|null, timeoutMs?: number}} [opts]
   */
  async function post(payload, opts = {}) {
    return http.requestJson(endpoint, {
      service: provider,
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

    // Timeout cho "byte đầu tiên" (TTFT), không phải toàn bộ câu trả lời:
    // NIM thỉnh thoảng treo request, cần bỏ sớm để retry; nhưng câu trả lời dài vẫn được sinh tiếp.
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
      ? // @ts-ignore AbortSignal.any có từ Node 20.3
        AbortSignal.any([input.signal, ttftController.signal])
      : ttftController.signal;

    /** @type {Response} */
    let response;
    try {
      response = await http.openStream(endpoint, {
        service: provider,
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
      throw error;
    }

    let content = '';
    let reasoning = '';
    let finishReason = '';
    /** @type {number} mốc nhận được token nội dung đầu tiên (để tính TTFT thật) */
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
          clearTimeout(ttftTimer);
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
                      content += delta.content;
                      if (!firstDeltaAt) firstDeltaAt = Date.now();
                      if (input.onDelta) await input.onDelta(delta.content);
                    }
                    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                      reasoning += delta.reasoning_content;
                    }
                    if (Array.isArray(delta.tool_calls)) {
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
    // TTFT = từ lúc gửi request tới token nội dung đầu tiên; phần còn lại mới là
    // thời gian sinh thật, nên tốc độ tok/s tính trên completionMs chứ không phải ms.
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

  async function warmup() {
    const started = Date.now();
    try {
      await chat({
        messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
        reasoning: 'none',
        maxTokens: 1,
        temperature: 0,
        timeoutMs: 20_000,
      });
      const ms = Date.now() - started;
      metrics?.observe('llm.warmup', ms);
      return ms;
    } catch (error) {
      logger.warn('llm warmup failed', { provider, error: String(/** @type {any} */ (error)?.message ?? error) });
      return -1;
    }
  }

  return { chat, warmup, model, endpoint, provider };
}

export const __test__ = { parseChoice, reasoningEffort, tokensPerSec };
