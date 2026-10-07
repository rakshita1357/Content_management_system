import { AppError } from './errors.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SAFE_TO_REPEAT = new Set(['GET', 'HEAD', 'PUT', 'PATCH']);

/**
 * fetch() for Google APIs, made safe to run unattended:
 * - gives up if Google does not start answering within timeoutMs (a hung call would otherwise block every later sync);
 * - repeats network errors, HTTP 429 and 5xx a few times with growing waits (only for calls that are safe to repeat);
 * - turns network failures into a readable error.
 * The timeout covers waiting for the response, not a long download that is already streaming.
 */
export function createGoogleFetch({ timeoutMs = 30000, retries = 3, retryBaseMs = 1000 } = {}, fetchImpl = fetch) {
  return async function googleFetch(url, init = {}, { repeatable = false } = {}) {
    const method = String(init.method || 'GET').toUpperCase();
    const canRepeat = repeatable || SAFE_TO_REPEAT.has(method);
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const outer = init.signal;
      const relay = () => controller.abort(outer.reason);
      if (outer) {
        if (outer.aborted) throw outer.reason || new Error('aborted');
        outer.addEventListener('abort', relay, { once: true });
      }
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        const res = await fetchImpl(url, { ...init, signal: controller.signal });
        clearTimeout(timer); // the response started; a long body is not cut off
        if (canRepeat && (res.status === 429 || res.status >= 500) && attempt < retries) {
          await res.body?.cancel().catch(() => {});
          if (outer) outer.removeEventListener('abort', relay);
          await sleep(retryBaseMs * 2 ** attempt);
          continue;
        }
        return res;
      } catch (err) {
        clearTimeout(timer);
        if (outer) outer.removeEventListener('abort', relay);
        if (outer?.aborted) throw err; // the caller gave up (for example the TV closed the connection)
        if (canRepeat && attempt < retries) { await sleep(retryBaseMs * 2 ** attempt); continue; }
        throw new AppError(
          502,
          timedOut ? 'Google Drive did not answer in time.' : `Cannot reach Google Drive (${err.cause?.code || err.message}).`,
          'Check the internet connection of the computer running the backend. TVs keep playing their saved ads meanwhile.',
        );
      }
    }
  };
}
