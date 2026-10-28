import { DEFAULT_ALIAS, FALLBACK_ALIAS, MODEL_ALIASES } from '../models.js';

/**
 * Danh mục model: alias -> route + capability.
 * Chỉ chứa alias có model string và provider đang có adapter.
 * @param {{config: any, availableProviders?: Iterable<string>}} options
 */
export function createModelCatalog(options) {
  const config = options.config;
  const filter = options.availableProviders !== undefined;
  const available = new Set(options.availableProviders ?? []);
  const contextWindow = Math.max(0, Number(config.context?.modelWindow ?? 0) || 0);

  /** @type {Record<string, {alias: string, provider: string, model: string, label: string, contextWindow: number}>} */
  const entries = {};
  for (const [alias, meta] of Object.entries(MODEL_ALIASES)) {
    if (filter && !available.has(meta.provider)) continue;
    const providerConfig = config[meta.provider] ?? {};
    const model = providerConfig[meta.modelKey];
    if (!model) continue;
    entries[alias] = { alias, provider: meta.provider, model, label: meta.label, contextWindow };
  }

  const wantedDefault = config.model?.defaultAlias ?? DEFAULT_ALIAS;
  const defaultAlias = entries[wantedDefault] ? wantedDefault : Object.keys(entries)[0];
  if (!defaultAlias) throw new Error('Không có model nào khả dụng (thiếu API key?)');

  let fallbackAlias = config.model?.fallbackAlias ?? FALLBACK_ALIAS;
  if (!entries[fallbackAlias] || fallbackAlias === defaultAlias) {
    fallbackAlias = Object.keys(entries).find((alias) => alias !== defaultAlias) ?? defaultAlias;
  }

  /** @param {string} input */
  function find(input) {
    const needle = String(input ?? '').trim().toLowerCase();
    if (!needle) return null;
    if (entries[needle]) return entries[needle];
    for (const item of Object.values(entries)) {
      if (item.provider === needle) return item;
    }
    for (const item of Object.values(entries)) {
      if (item.label.toLowerCase().includes(needle) || item.model.toLowerCase().includes(needle)) return item;
    }
    return null;
  }

  /** @param {any} record */
  function resolve(record) {
    const wanted = record?.meta?.model;
    return (wanted && entries[wanted]) || entries[defaultAlias];
  }

  function list() {
    return Object.values(entries);
  }

  /** @param {string} alias */
  function specFor(alias) {
    return entries[alias] ?? null;
  }

  return { entries, list, find, resolve, specFor, defaultAlias, fallbackAlias };
}
