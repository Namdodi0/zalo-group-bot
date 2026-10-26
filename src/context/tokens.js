export const IMAGE_TOKENS = 1100;

/** @param {string} text */
export function estimateTextTokens(text) {
  const value = String(text ?? '');
  if (!value) return 0;
  return Math.ceil(value.length / 3.2);
}

/**
 * @param {{text?: string, imageUrl?: string|null}} message
 */
export function estimateMessageTokens(message) {
  const overhead = 6;
  return overhead + estimateTextTokens(message.text ?? '') + (message.imageUrl ? IMAGE_TOKENS : 0);
}

/**
 * Hiệu chỉnh ước lượng bằng số token thật từ `usage.prompt_tokens`.
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
