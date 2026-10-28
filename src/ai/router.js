import { createModelCatalog } from './llm/catalog.js';

/**
 * Router chọn provider/model theo chat.
 * - Mặc định: config.model.defaultAlias
 * - Chat có `meta.model` (do /model đặt) thì dùng alias đó
 * - Fallback: config.model.fallbackAlias
 *
 * @param {{config: any, service: ReturnType<typeof import('./llm/service.js').createLlmService>, logger?: import('../logger.js').Logger}} options
 */
export function createModelRouter(options) {
  const config = options.config;
  const service = options.service;
  const logger = options.logger;

  const catalog = createModelCatalog({ config, availableProviders: service.providers() });
  const defaultAlias = catalog.defaultAlias;
  const fallbackAlias = catalog.fallbackAlias;

  logger?.debug('model router ready', {
    default: defaultAlias,
    fallback: fallbackAlias,
    available: catalog.list().map((item) => item.alias),
  });

  /** @param {any} record */
  function resolve(record) {
    return catalog.resolve(record);
  }

  /** @param {string} input */
  function find(input) {
    return catalog.find(input);
  }

  function list() {
    return catalog.list();
  }

  /**
   * @param {string | {alias: string}} selection
   * @param {any} input
   */
  async function chatWith(selection, input) {
    const target = typeof selection === 'string' ? find(selection) : selection;
    const entry = (target?.alias && catalog.specFor(target.alias)) || resolve(null);
    return service.chat({ ...input, provider: entry.provider, model: entry.model });
  }

  /**
   * @param {{record?: any, alias?: string} & Record<string, any>} input
   */
  async function chat(input) {
    const { record, alias, ...rest } = input;
    const target = (alias && find(alias)) || resolve(record);
    return chatWith(target, rest);
  }

  /**
   * @param {string} alias
   * @param {{timeoutMs?: number}} [warmupOptions]
   */
  async function warmup(alias, warmupOptions = {}) {
    const entry = find(alias);
    if (!entry) return { ok: false, ms: 0, model: '', error: `Không có model "${alias}"` };
    return service.warmup(entry.provider, { ...warmupOptions, model: entry.model });
  }

  return {
    chat,
    chatWith,
    resolve,
    find,
    list,
    registry: catalog.entries,
    catalog,
    warmup,
    defaultAlias,
    get fallbackAlias() {
      return fallbackAlias;
    },
  };
}
