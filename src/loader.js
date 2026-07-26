/**
 * loader.js — single-flight <script> loader.
 *
 * Generalized from a production helper that pulled a realtime SDK off a CDN
 * instead of bundling it. Two properties matter and both are preserved:
 *
 *   1. If the global is already present, resolve immediately and inject
 *      nothing.
 *   2. Concurrent callers share one in-flight promise, so N components asking
 *      for the SDK at the same time still produce exactly one <script> tag.
 *
 * Browser-only: `loadScriptOnce` needs `document`. Importing this module in
 * Node is safe (nothing runs at module scope); calling it is not.
 */

/** @type {Map<string, Promise<unknown>>} */
const inFlight = new Map();

/**
 * Load a script once, ever, per URL.
 *
 * @param {string} src absolute or relative script URL
 * @param {object} [options]
 * @param {string} [options.globalKey] name on `globalThis` that the script
 *   defines. If given, it is checked before injecting and its value is what
 *   the promise resolves to.
 * @param {number} [options.timeout=15000] ms before rejecting. 0 disables.
 * @param {Record<string,string>} [options.attributes] extra attributes to set
 *   on the <script> element (e.g. `crossorigin`, `integrity`).
 * @returns {Promise<unknown>} the global named by `globalKey`, or `undefined`
 */
export function loadScriptOnce(src, options = {}) {
  const { globalKey, timeout = 15000, attributes } = options;

  const existing = globalKey ? globalThis[globalKey] : undefined;
  if (existing) return Promise.resolve(existing);

  const cached = inFlight.get(src);
  if (cached) return cached;

  const promise = new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('loadScriptOnce requires a DOM (document is undefined)'));
      return;
    }

    let timer = null;
    const el = document.createElement('script');

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      el.onload = null;
      el.onerror = null;
    };

    el.src = src;
    el.async = true;
    if (attributes) {
      for (const [k, v] of Object.entries(attributes)) el.setAttribute(k, v);
    }

    el.onload = () => {
      cleanup();
      resolve(globalKey ? globalThis[globalKey] : undefined);
    };
    el.onerror = () => {
      cleanup();
      inFlight.delete(src);
      reject(new Error(`Failed to load script: ${src}`));
    };

    if (timeout > 0) {
      timer = setTimeout(() => {
        cleanup();
        inFlight.delete(src);
        reject(new Error(`Timed out loading script after ${timeout}ms: ${src}`));
      }, timeout);
    }

    document.head.appendChild(el);
  });

  inFlight.set(src, promise);
  return promise;
}

/**
 * Forget the cached promise for a URL so the next call re-injects.
 *
 * Only useful in tests and hot-reload; a successfully loaded script cannot be
 * un-loaded from the page.
 *
 * @param {string} [src] omit to clear every entry
 */
export function resetScriptCache(src) {
  if (src === undefined) inFlight.clear();
  else inFlight.delete(src);
}
