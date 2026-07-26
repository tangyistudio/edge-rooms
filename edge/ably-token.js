/**
 * ably-token.js — sign an Ably TokenRequest with WebCrypto, anywhere.
 *
 * An Ably TokenRequest is a small JSON object with an HMAC-SHA256 over its own
 * fields, keyed by the secret half of your API key. The browser SDK exchanges
 * it for a real token by itself. That means a backend can hand out credentials
 * without a vendor SDK and without making any outbound HTTP call — which is
 * what makes this work in edge runtimes where cold starts and egress are the
 * expensive parts.
 *
 * Portability: this module touches only `globalThis.crypto.subtle`,
 * `globalThis.crypto.getRandomValues` and `TextEncoder`. No Node built-ins, no
 * `Buffer`, no `btoa`. It runs on Deno, Cloudflare Workers, Vercel Edge and
 * Node 18+.
 *
 * Never ship your API key to the browser. Only the signed TokenRequest leaves
 * the server.
 */

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** One hour, in milliseconds. */
export const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** Default capability: full rights on the `rooms:*` channel namespace. */
export const DEFAULT_CAPABILITY = { 'rooms:*': ['publish', 'subscribe', 'presence'] };

/**
 * Base64-encode bytes without `btoa` or `Buffer`.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      BASE64_ALPHABET[(n >>> 18) & 63] +
      BASE64_ALPHABET[(n >>> 12) & 63] +
      BASE64_ALPHABET[(n >>> 6) & 63] +
      BASE64_ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += BASE64_ALPHABET[(n >>> 18) & 63] + BASE64_ALPHABET[(n >>> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      BASE64_ALPHABET[(n >>> 18) & 63] +
      BASE64_ALPHABET[(n >>> 12) & 63] +
      BASE64_ALPHABET[(n >>> 6) & 63] +
      '=';
  }
  return out;
}

/**
 * Split an Ably API key into its two halves.
 *
 * The key looks like `appId.keyId:keySecret`. Everything before the first
 * colon is the key *name* and travels in the clear inside the TokenRequest;
 * everything after it is the secret and is only ever used as an HMAC key.
 *
 * @param {string} apiKey
 * @returns {{keyName: string, keySecret: string}}
 */
export function parseApiKey(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new TypeError('API key is missing');
  }
  const sepIdx = apiKey.indexOf(':');
  if (sepIdx < 0) {
    throw new Error('API key must be in the form "appId.keyId:keySecret"');
  }
  return {
    keyName: apiKey.substring(0, sepIdx),
    keySecret: apiKey.substring(sepIdx + 1),
  };
}

/**
 * A random nonce of at least 16 characters, as the spec requires.
 *
 * @param {number} [length=32]
 * @returns {string} lowercase hex
 */
export function createNonce(length = 32) {
  const size = Math.max(16, length);
  const bytes = new Uint8Array(Math.ceil(size / 2));
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex.substring(0, size);
}

/**
 * The canonical string that gets signed.
 *
 * Field order is fixed — keyName, ttl, capability, clientId, timestamp,
 * nonce — and every field, including the last one, is followed by a newline.
 * Get either wrong and the server rejects the token.
 *
 * @param {object} fields
 * @returns {string}
 */
export function tokenRequestSigningString(fields) {
  const { keyName, ttl, capability, clientId, timestamp, nonce } = fields;
  return (
    keyName + '\n' +
    ttl + '\n' +
    capability + '\n' +
    clientId + '\n' +
    timestamp + '\n' +
    nonce + '\n'
  );
}

/**
 * HMAC-SHA256 a string and return the MAC as base64.
 *
 * @param {string} secret
 * @param {string} message
 * @returns {Promise<string>}
 */
export async function hmacSha256Base64(secret, message) {
  const enc = new TextEncoder();
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await globalThis.crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return bytesToBase64(new Uint8Array(sigBuf));
}

/**
 * Build a signed TokenRequest.
 *
 * Hand the returned object to the browser as-is; the Ably SDK's `authCallback`
 * takes it verbatim.
 *
 * @param {string} apiKey full `appId.keyId:keySecret`
 * @param {object} [options]
 * @param {string} [options.clientId=''] identity the token is issued to
 * @param {object|string} [options.capability] capability object or its JSON
 * @param {number} [options.ttl=3600000] lifetime in ms
 * @param {number} [options.timestamp=Date.now()] ms since epoch
 * @param {string} [options.nonce] 16+ random chars; generated if omitted
 * @returns {Promise<{keyName: string, ttl: number, capability: string,
 *   clientId: string, timestamp: number, nonce: string, mac: string}>}
 */
export async function createTokenRequest(apiKey, options = {}) {
  const { keyName, keySecret } = parseApiKey(apiKey);

  const clientId = options.clientId === undefined || options.clientId === null
    ? ''
    : String(options.clientId);
  const capabilityInput = options.capability === undefined
    ? DEFAULT_CAPABILITY
    : options.capability;
  const capability = typeof capabilityInput === 'string'
    ? capabilityInput
    : JSON.stringify(capabilityInput);
  const ttl = options.ttl === undefined ? DEFAULT_TTL_MS : Number(options.ttl);
  const timestamp = options.timestamp === undefined ? Date.now() : Number(options.timestamp);
  const nonce = options.nonce === undefined ? createNonce() : String(options.nonce);

  if (nonce.length < 16) throw new Error('nonce must be at least 16 characters');

  const fields = { keyName, ttl, capability, clientId, timestamp, nonce };
  const mac = await hmacSha256Base64(keySecret, tokenRequestSigningString(fields));
  return { ...fields, mac };
}

/**
 * Wrap `createTokenRequest` in a fetch-style handler.
 *
 * This is a convenience shell, not the interesting part — it exists so the
 * common case is one export in an edge function:
 *
 *   export default tokenRequestHandler({
 *     apiKey: () => Deno.env.get('ABLY_API_KEY'),
 *     authorize: async (req) => (await myAuth(req))?.id ?? null,
 *   });
 *
 * `authorize` returns the clientId to issue the token to, or `null`/`false`
 * to refuse. Returning `undefined` issues an anonymous token; if you want no
 * anonymous access, say so explicitly by returning `null`.
 *
 * @param {object} options
 * @param {string|(() => string|Promise<string>)} options.apiKey
 * @param {(request: Request) => unknown} [options.authorize]
 * @param {object|string} [options.capability]
 * @param {number} [options.ttl]
 * @param {Record<string,string>} [options.headers] extra response headers
 * @returns {(request: Request) => Promise<Response>}
 */
export function tokenRequestHandler(options = {}) {
  const { apiKey, authorize, capability, ttl, headers } = options;

  const json = (body, status) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });

  return async function handle(request) {
    try {
      let clientId;
      if (typeof authorize === 'function') {
        const result = await authorize(request);
        if (result === null || result === false) {
          return json({ error: 'unauthorized' }, 401);
        }
        if (result !== undefined) clientId = String(result);
      }

      const key = typeof apiKey === 'function' ? await apiKey() : apiKey;
      if (!key) return json({ error: 'api key not configured' }, 500);

      const tokenRequest = await createTokenRequest(key, { clientId, capability, ttl });
      return json(tokenRequest, 200);
    } catch {
      // Never leak the key or a stack trace to the client.
      return json({ error: 'token request failed' }, 500);
    }
  };
}
