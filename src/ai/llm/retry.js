/**
 * Retry executor kept separate from the adapter: the adapter declares the policy, the executor re-runs it.
 * @param {{maxAttempts?: number, backoffMs?: (attempt: number) => number, shouldRetry?: (error: unknown) => boolean, sleep?: (ms: number) => Promise<void>, minRemainingMs?: number}} [options]
 */
export function createRetryExecutor(options = {}) {
  const maxAttempts = options.maxAttempts ?? 2;
  const backoffMs = options.backoffMs ?? ((attempt) => 400 * attempt);
  const shouldRetry = options.shouldRetry ?? (() => false);
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const minRemainingMs = options.minRemainingMs ?? 1500;

  /**
   * @template T
   * @param {(input: {attempt: number, deadline: number}) => Promise<T>} fn
   * @param {{deadline?: number, onRetry?: (error: unknown, attempt: number) => void}} [context]
   * @returns {Promise<T>}
   */
  async function execute(fn, context = {}) {
    const deadline = context.deadline ?? Number.POSITIVE_INFINITY;
    /** @type {unknown} */
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (deadline - Date.now() < minRemainingMs) break;
      try {
        return await fn({ attempt, deadline });
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts - 1 || !shouldRetry(error)) break;
        context.onRetry?.(error, attempt + 1);
        await sleep(backoffMs(attempt + 1));
      }
    }

    if (lastError) throw lastError;
    throw new Error('Timed out before calling the model');
  }

  return { execute, maxAttempts };
}
