import { LLM_ERROR, LlmError, asLlmError } from './errors.js';

/**
 * Service gọi model trung lập provider: registry adapter + dispatch + chuẩn hoá lỗi.
 * Một lần gọi kết thúc đúng một trong hai trạng thái: resolve kết quả hoặc throw LlmError.
 * @param {{adapters?: any[], logger?: import('../../logger.js').Logger, metrics?: any}} [options]
 */
export function createLlmService(options = {}) {
  const logger = options.logger;
  /** @type {Map<string, any>} */
  const routes = new Map();

  /** @param {any} adapter */
  function register(adapter) {
    const id = adapter?.id;
    if (!id) throw new LlmError(LLM_ERROR.NO_ADAPTER, 'Adapter thiếu id/provider');
    if (routes.has(id)) {
      throw new LlmError(LLM_ERROR.PROVIDER_ERROR, `Adapter trùng route: ${id}`, { provider: id });
    }
    routes.set(id, adapter);
    return () => {
      routes.delete(id);
    };
  }

  for (const adapter of options.adapters ?? []) register(adapter);

  function providers() {
    return [...routes.keys()];
  }

  /** @param {string} provider */
  function has(provider) {
    return routes.has(String(provider ?? ''));
  }

  /**
   * @param {{provider: string, model?: string} & Record<string, any>} request
   */
  async function chat(request) {
    const provider = String(request?.provider ?? '');
    const adapter = routes.get(provider);
    if (!adapter) {
      throw new LlmError(LLM_ERROR.NO_ADAPTER, `Chưa có adapter cho provider "${provider}"`, { provider });
    }
    const model = request?.model ?? adapter.model;
    if (adapter.credentialed === false) {
      throw new LlmError(LLM_ERROR.MISSING_CREDENTIAL, `Thiếu API key cho provider "${provider}"`, {
        provider,
        model,
      });
    }
    // Request bất biến với service: adapter không được sửa lựa chọn provider/model.
    const frozen = Object.freeze({ ...request, provider, model });

    try {
      return await adapter.chat(frozen);
    } catch (error) {
      const normalized = asLlmError(error, { provider, model });
      if (normalized !== error) {
        logger?.debug('llm error normalized', {
          provider,
          model,
          code: normalized.code,
          status: normalized.status,
          error: normalized.message,
        });
      }
      throw normalized;
    }
  }

  /** @param {any} request */
  function stream(request) {
    return chat({ ...request, stream: true });
  }

  /**
   * @param {string} provider
   * @param {{model?: string, timeoutMs?: number}} [warmupOptions]
   */
  async function warmup(provider, warmupOptions = {}) {
    const adapter = routes.get(String(provider ?? ''));
    if (!adapter) {
      return { ok: false, ms: 0, model: '', error: `Chưa có adapter cho provider "${provider}"` };
    }
    return adapter.warmup(warmupOptions);
  }

  return { register, chat, stream, warmup, providers, has, routes };
}
