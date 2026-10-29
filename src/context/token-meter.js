/** @param {string} text */
export function estimateTextTokens(text) {
  const value = String(text ?? '');
  if (!value) return 0;
  return Math.ceil(value.length / 3.2);
}

/**
 * @param {{text?: string, toolCalls?: Array<{name?: string, arguments?: any, rawArguments?: string}>}} message
 */
export function estimateMessageTokens(message) {
  const overhead = 6;
  let chars = String(message.text ?? '').length;
  for (const call of message.toolCalls ?? []) {
    const args = call?.rawArguments ?? JSON.stringify(call?.arguments ?? {});
    chars += String(call?.name ?? '').length + String(args ?? '').length;
  }
  return overhead + Math.ceil(chars / 3.2);
}

/**
 * Calibrate the estimate using real token counts from `usage.prompt_tokens`.
 * @param {{initial?: number, min?: number, max?: number}} [options]
 */
export function createCalibrator(options = {}) {
  const min = options.min ?? 0.5;
  const max = options.max ?? 2.5;
  let ratio = options.initial ?? 1;

  /**
   * @param {number} estimated
   * @param {number} actual
   */
  function observe(estimated, actual) {
    if (!Number.isFinite(estimated) || !Number.isFinite(actual) || estimated <= 0 || actual <= 0) return;
    const sample = actual / estimated;
    if (!Number.isFinite(sample) || sample <= 0) return;
    ratio = Math.min(max, Math.max(min, 0.7 * ratio + 0.3 * sample));
  }

  return {
    observe,
    ratio: () => ratio,
    /** @param {number} raw */
    estimate: (raw) => Math.ceil(raw * ratio),
    reset: () => {
      ratio = options.initial ?? 1;
    },
  };
}

/**
 * Measure the context pressure of a request — no model call, deterministic for the input.
 * @param {{calibrator?: ReturnType<typeof createCalibrator>}} [options]
 */
export function createTokenMeter(options = {}) {
  const calibrator = options.calibrator ?? createCalibrator();

  /** @param {any[]} messages */
  function messageTokens(messages) {
    let total = 0;
    for (const message of messages ?? []) total += estimateMessageTokens(message);
    return total;
  }

  /** @param {any[]} tools */
  function toolTokens(tools) {
    if (!tools?.length) return 0;
    return estimateTextTokens(JSON.stringify(tools));
  }

  /**
   * @param {{systemPrompt?: string, tools?: any[], messages?: any[], contextWindow?: number}} input
   */
  function request(input = {}) {
    const system = estimateTextTokens(input.systemPrompt ?? '');
    const tools = toolTokens(input.tools);
    const messages = messageTokens(input.messages);
    const raw = system + tools + messages;
    const promptTokens = calibrator.estimate(raw);
    const window = Number(input.contextWindow ?? 0);
    return {
      promptTokens,
      systemTokens: calibrator.estimate(system),
      toolTokens: calibrator.estimate(tools),
      messageTokens: calibrator.estimate(messages),
      contextWindow: window > 0 ? window : 0,
      pressure: window > 0 ? promptTokens / window : null,
    };
  }

  return {
    text: estimateTextTokens,
    message: estimateMessageTokens,
    messages: messageTokens,
    tools: toolTokens,
    request,
    observe: calibrator.observe,
    ratio: calibrator.ratio,
    calibrator,
  };
}
