/**
 * Model catalog selectable via the /model command.
 * `modelKey` points to a field in the provider config.
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
  ultra: {
    provider: 'nim',
    modelKey: 'ultraModel',
    label: 'Nemotron 3 Ultra 550B (A55B)',
  },
  'nim-light': {
    provider: 'nim',
    modelKey: 'fallbackModel',
    label: 'Nemotron 3.5 Lightning',
  },
};

/** Default alias (DeepSeek flash 4.1, reasoning off). */
export const DEFAULT_ALIAS = 'deepseek';

/** Fallback alias when the primary provider fails. */
export const FALLBACK_ALIAS = 'nim-light';

/** @param {string} value */
export function isKnownAlias(value) {
  return Object.prototype.hasOwnProperty.call(MODEL_ALIASES, value);
}

/**
 * Find an alias by model name or provider name.
 * @param {string} value
 * @returns {string|null}
 */
export function findAlias(value) {
  const needle = String(value ?? '').trim().toLowerCase();
  if (!needle) return null;
  if (isKnownAlias(needle)) return needle;
  // allow "/model deepseek" or "/model nim"
  for (const [alias, meta] of Object.entries(MODEL_ALIASES)) {
    if (meta.provider === needle) return alias;
  }
  for (const [alias, meta] of Object.entries(MODEL_ALIASES)) {
    if (meta.label.toLowerCase().includes(needle)) return alias;
  }
  return null;
}
