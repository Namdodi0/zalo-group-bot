/**
 * Danh mục model có thể chọn bằng lệnh /model.
 * `modelKey` trỏ tới field trong config của provider.
 */
export const MODEL_ALIASES = {
  deepseek: {
    provider: 'deepseek',
    modelKey: 'model',
    label: 'DeepSeek V4.1 Flash',
  },
  pro: {
    provider: 'deepseek',
    modelKey: 'proModel',
    label: 'DeepSeek V4 Pro',
  },
  nim: {
    provider: 'nim',
    modelKey: 'model',
    label: 'Nemotron 3.5 Super VL',
  },
  'nim-light': {
    provider: 'nim',
    modelKey: 'fallbackModel',
    label: 'Nemotron 3.5 Lightning',
  },
};

/** Alias mặc định (DeepSeek flash 4.1, reasoning off). */
export const DEFAULT_ALIAS = 'deepseek';

/** Alias dự phòng khi provider chính lỗi. */
export const FALLBACK_ALIAS = 'nim-light';

/** @param {string} value */
export function isKnownAlias(value) {
  return Object.prototype.hasOwnProperty.call(MODEL_ALIASES, value);
}

/**
 * Tìm alias theo tên model hoặc tên provider.
 * @param {string} value
 * @returns {string|null}
 */
export function findAlias(value) {
  const needle = String(value ?? '').trim().toLowerCase();
  if (!needle) return null;
  if (isKnownAlias(needle)) return needle;
  // cho phép "/model deepseek" hoặc "/model nim"
  for (const [alias, meta] of Object.entries(MODEL_ALIASES)) {
    if (meta.provider === needle) return alias;
  }
  for (const [alias, meta] of Object.entries(MODEL_ALIASES)) {
    if (meta.label.toLowerCase().includes(needle)) return alias;
  }
  return null;
}
