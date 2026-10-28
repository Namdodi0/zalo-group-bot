import { LLM_ERROR, LlmError, asLlmError } from './errors.js';

/**
 * Provider-neutral model service: adapter registry + dispatch + error normalization.
 * A call ends in exactly one of two states: it resolves a result or throws LlmError.
 * @param {{adapters?: any[], logger?: import('../../logger.js').Logger, metrics?: any}} [options]
 */
export function createLlmService(options = {}) {
  const logger = options.logger;
  /** @type {Map<string, any>} */
  const routes = new Map();

  /** @param {any} adapter */
  function register(adapter) {
    const id = adapter?.id;
    if (!id) throw new LlmError(LLM_ERROR.NO_ADAPTER, 'Adapter is missing id/provider');
    if (routes.has(id)) {
      throw new LlmError(LLM_ERROR.PROVIDER_ERROR, `Duplicate adapter route: ${id}`, { provider: id });
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
      throw new LlmError(LLM_ERROR.NO_ADAPTER, `No adapter for provider "${provider}"`, { provider });
    }
    const model = request?.model ?? adapter.model;
    if (adapter.credentialed === false) {
      throw new LlmError(LLM_ERROR.MISSING_CREDENTIAL, `Missing API key for provider "${provider}"`, {
        provider,
        model,
      });
    }
    // The request is immutable to the service: adapters must not change the provider/model choice.
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
      return { ok: false, ms: 0, model: '', error: `No adapter for provider "${provider}"` };
    }
    return adapter.warmup(warmupOptions);
  }

  return { register, chat, stream, warmup, providers, has, routes };
}
