import { DEFAULT_ALIAS, FALLBACK_ALIAS, MODEL_ALIASES } from './models.js';

/**
 * Router chọn provider/model theo chat.
 * - Mặc định: config.model.defaultAlias
 * - Chat có `meta.model` (do /model đặt) thì dùng alias đó
 * - Fallback: config.model.fallbackAlias
 *
 * @param {{config: any, clients: Record<string, any>, logger?: import('../logger.js').Logger}} options
 */
export function createModelRouter(options) {
  const config = options.config;
  const clients = options.clients;
  const logger = options.logger;

  /** @type {Record<string, {alias: string, provider: string, model: string, label: string}>} */
  const registry = {};
  for (const [alias, meta] of Object.entries(MODEL_ALIASES)) {
    const client = clients[meta.provider];
    if (!client) continue;
    const providerConfig = config[meta.provider] ?? {};
    const model = providerConfig[meta.modelKey];
    if (!model) continue;
    registry[alias] = { alias, provider: meta.provider, model, label: meta.label };
  }

  const defaultAlias = registry[config.model?.defaultAlias ?? DEFAULT_ALIAS]
    ? config.model?.defaultAlias ?? DEFAULT_ALIAS
    : Object.keys(registry)[0];
  if (!defaultAlias) throw new Error('Không có model nào khả dụng (thiếu API key?)');

  let fallbackAlias = config.model?.fallbackAlias ?? FALLBACK_ALIAS;
  if (!registry[fallbackAlias] || fallbackAlias === defaultAlias) {
    fallbackAlias = Object.keys(registry).find((alias) => alias !== defaultAlias) ?? defaultAlias;
  }

  logger?.debug('model router ready', {
    default: defaultAlias,
    fallback: fallbackAlias,
    available: Object.keys(registry),
  });

  /** @param {string} alias */
  function targetFor(alias) {
    return registry[alias] ?? null;
  }

  /** @param {any} record */
  function resolve(record) {
    const wanted = record?.meta?.model;
    return (wanted && registry[wanted]) || registry[defaultAlias];
  }

  /** @param {string} input */
  function find(input) {
    const needle = String(input ?? '').trim().toLowerCase();
    if (!needle) return null;
    if (registry[needle]) return registry[needle];
    // cho phép chọn theo tên provider ("deepseek", "nim")
    for (const item of Object.values(registry)) {
      if (item.provider === needle) return item;
    }
    for (const item of Object.values(registry)) {
      if (item.label.toLowerCase().includes(needle) || item.model.toLowerCase().includes(needle)) return item;
    }
    return null;
  }

  function list() {
    return Object.values(registry);
  }

  /**
   * @param {string | {alias: string, provider: string, model: string, label: string}} selection
   * @param {any} input
   */
  async function chatWith(selection, input) {
    const target = typeof selection === 'string' ? find(selection) : selection;
    const picked = target && registry[target.alias] ? target : resolve(null);
    const client = clients[picked.provider];
    if (!client) throw new Error(`provider "${picked.provider}" chưa được cấu hình`);
    return client.chat({ ...input, model: picked.model });
  }

  /**
   * @param {{record?: any, alias?: string} & Record<string, any>} input
   */
  async function chat(input) {
    const { record, alias, ...rest } = input;
    const target = (alias && find(alias)) || resolve(record);
    return chatWith(target, rest);
  }

  return {
    chat,
    chatWith,
    resolve,
    find,
    list,
    registry,
    defaultAlias,
    get fallbackAlias() {
      return fallbackAlias;
    },
  };
}
