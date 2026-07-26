/**
 * client.js — one realtime connection per app, behind a provider adapter.
 *
 * The production code this is generalized from kept a single module-level
 * client and handed it to every component, explicitly to conserve its
 * concurrent connection count. That is preserved here, with two changes: the
 * singleton is keyed (so tests and multi-tenant pages can hold more than
 * one), and the provider is supplied as an adapter object rather than
 * hardcoded.
 *
 * ---------------------------------------------------------------------------
 * Adapter contract
 * ---------------------------------------------------------------------------
 * An adapter is a plain object. Only the first six members are required.
 *
 *   name              string                       identity of the provider
 *   createClient(opts)                             -> Promise<client> | client
 *   getChannel(client, channelName)                -> channel
 *   subscribe(channel, handler)                    -> Promise<unsub> | unsub
 *   publish(channel, eventName, data)              -> Promise<void>
 *   detach(channel)                                -> Promise<void> | void
 *
 *   connectionState(client)                        -> string        (optional)
 *   onConnectionState(client, handler)             -> unsub         (optional)
 *   close(client)                                                   (optional)
 *   presence: {                                                     (optional)
 *     enter(channel, data), update(channel, data), leave(channel),
 *     get(channel)                                 -> Promise<members[]>,
 *     subscribe(channel, handler)                  -> unsub
 *   }
 *
 * `handler` receives a normalized message: `{ name, data, clientId }`.
 */

import { loadScriptOnce } from './loader.js';

/** @type {Map<string, Promise<unknown>>} */
const clients = new Map();

function adapterKey(adapter, options) {
  if (options && options.key) return String(options.key);
  return String((adapter && adapter.name) || 'default');
}

/**
 * Get (or create) the shared client for an adapter.
 *
 * Single-flight: concurrent callers share one in-flight promise, and a
 * rejected creation is evicted so the next caller can retry.
 *
 * @param {object} adapter
 * @param {object} [options] passed straight to `adapter.createClient`
 * @param {string} [options.key] override the singleton key
 * @returns {Promise<any>}
 */
export function getClient(adapter, options = {}) {
  if (!adapter || typeof adapter.createClient !== 'function') {
    return Promise.reject(new TypeError('adapter.createClient is required'));
  }
  const key = adapterKey(adapter, options);
  const cached = clients.get(key);
  if (cached) return cached;

  const promise = Promise.resolve()
    .then(() => adapter.createClient(options))
    .catch((err) => {
      clients.delete(key);
      throw err;
    });

  clients.set(key, promise);
  return promise;
}

/**
 * Close and forget the shared client for an adapter.
 *
 * @param {object} adapter
 * @param {object} [options]
 * @returns {Promise<void>}
 */
export async function releaseClient(adapter, options = {}) {
  const key = adapterKey(adapter, options);
  const pending = clients.get(key);
  if (!pending) return;
  clients.delete(key);
  try {
    const client = await pending;
    if (adapter && typeof adapter.close === 'function') adapter.close(client);
  } catch {
    /* creation already failed; nothing to close */
  }
}

/**
 * Drop every cached client without closing them. Tests only.
 */
export function resetClients() {
  clients.clear();
}

/* -------------------------------------------------------------------------
 * Ably adapter
 * ---------------------------------------------------------------------- */

const ABLY_CDN = 'https://cdn.ably.com/lib/ably.min-2.js';

/**
 * Adapter for Ably's browser SDK, loaded from their CDN.
 *
 * Authentication goes through the SDK's `authCallback`: when the SDK needs a
 * token it calls us, we fetch a signed TokenRequest from `authUrl`, and hand
 * the JSON back untouched. The SDK then exchanges it with Ably itself. Your
 * backend never talks to Ably — see `edge-rooms/edge`.
 *
 * @param {object} options
 * @param {string} [options.authUrl] endpoint returning a signed TokenRequest
 * @param {(tokenParams: object) => Promise<object>} [options.getTokenRequest]
 *   supply the TokenRequest yourself instead of fetching `authUrl`
 * @param {RequestInit} [options.fetchOptions] passed to `fetch(authUrl, ...)`
 * @param {string} [options.cdnUrl] override the SDK URL
 * @param {object} [options.clientOptions] merged into `new Ably.Realtime(...)`
 * @returns {object} adapter
 */
export function createAblyAdapter(options = {}) {
  const {
    authUrl,
    getTokenRequest,
    fetchOptions,
    cdnUrl = ABLY_CDN,
    clientOptions = {},
  } = options;

  if (!authUrl && typeof getTokenRequest !== 'function') {
    throw new TypeError('createAblyAdapter needs authUrl or getTokenRequest');
  }

  const fetchTokenRequest = async (tokenParams) => {
    if (typeof getTokenRequest === 'function') return getTokenRequest(tokenParams);
    const res = await fetch(authUrl, {
      credentials: 'include',
      ...fetchOptions,
    });
    if (!res.ok) throw new Error(`Token endpoint returned ${res.status}`);
    const body = await res.json();
    // Some backends wrap the payload; accept both shapes.
    const tokenRequest = body && body.data ? body.data : body;
    if (!tokenRequest || tokenRequest.error) {
      throw new Error(String((tokenRequest && tokenRequest.error) || 'no token'));
    }
    return tokenRequest;
  };

  return {
    name: 'ably',

    async createClient() {
      const Ably = await loadScriptOnce(cdnUrl, { globalKey: 'Ably' });
      if (!Ably) throw new Error('Ably SDK loaded but window.Ably is missing');
      return new Ably.Realtime({
        ...clientOptions,
        authCallback: async (tokenParams, callback) => {
          try {
            callback(null, await fetchTokenRequest(tokenParams));
          } catch (err) {
            callback(err && err.message ? err.message : String(err), null);
          }
        },
      });
    },

    getChannel(client, channelName) {
      return client.channels.get(channelName);
    },

    async subscribe(channel, handler) {
      const listener = (message) =>
        handler({
          name: message.name,
          data: message.data,
          clientId: message.clientId,
        });
      await channel.subscribe(listener);
      return () => channel.unsubscribe(listener);
    },

    publish(channel, eventName, data) {
      return channel.publish(eventName, data);
    },

    async detach(channel) {
      channel.unsubscribe();
      await channel.detach();
    },

    connectionState(client) {
      return client.connection.state;
    },

    onConnectionState(client, handler) {
      const listener = () => handler(client.connection.state);
      client.connection.on(listener);
      return () => client.connection.off(listener);
    },

    close(client) {
      client.close();
    },

    presence: {
      enter(channel, data) {
        return channel.presence.enter(data);
      },
      update(channel, data) {
        return channel.presence.update(data);
      },
      leave(channel) {
        return channel.presence.leave();
      },
      async get(channel) {
        const members = await channel.presence.get();
        return (members || []).map((m) => ({
          clientId: m.clientId,
          data: m.data,
          action: m.action,
        }));
      },
      subscribe(channel, handler) {
        const listener = (member) =>
          handler({
            clientId: member.clientId,
            data: member.data,
            action: member.action,
          });
        channel.presence.subscribe(listener);
        return () => channel.presence.unsubscribe(listener);
      },
    },
  };
}

/* -------------------------------------------------------------------------
 * Stub adapter
 * ---------------------------------------------------------------------- */

/**
 * In-memory adapter. No network, no account, no SDK.
 *
 * Every client built from the same `bus` sees each other's messages and
 * presence, which is enough to demo and test multi-participant behaviour in a
 * single page or a single test process.
 *
 * @param {object} [options]
 * @param {object} [options.bus] share one bus across adapters to link them
 * @param {string} [options.clientId]
 * @returns {object} adapter
 */
export function createStubAdapter(options = {}) {
  const bus =
    options.bus ||
    /** @type {{channels: Map<string, {listeners: Set<Function>, presence: Map<string, unknown>, presenceListeners: Set<Function>}>}} */ ({
      channels: new Map(),
    });
  let seq = 0;

  const room = (channelName) => {
    let entry = bus.channels.get(channelName);
    if (!entry) {
      entry = {
        listeners: new Set(),
        presence: new Map(),
        presenceListeners: new Set(),
      };
      bus.channels.set(channelName, entry);
    }
    return entry;
  };

  return {
    name: options.name || 'stub',
    bus,

    createClient() {
      return {
        clientId: options.clientId || `stub-${++seq}`,
        state: 'connected',
        listeners: new Set(),
      };
    },

    getChannel(client, channelName) {
      return { client, channelName, shared: room(channelName) };
    },

    subscribe(channel, handler) {
      channel.shared.listeners.add(handler);
      return () => channel.shared.listeners.delete(handler);
    },

    publish(channel, eventName, data) {
      const message = { name: eventName, data, clientId: channel.client.clientId };
      for (const listener of [...channel.shared.listeners]) listener(message);
      return Promise.resolve();
    },

    detach(channel) {
      channel.shared.presence.delete(channel.client.clientId);
    },

    connectionState(client) {
      return client.state;
    },

    onConnectionState(client, handler) {
      client.listeners.add(handler);
      return () => client.listeners.delete(handler);
    },

    close(client) {
      client.state = 'closed';
      for (const listener of [...client.listeners]) listener('closed');
    },

    presence: {
      enter(channel, data) {
        channel.shared.presence.set(channel.client.clientId, data);
        emitPresence(channel, 'enter', data);
        return Promise.resolve();
      },
      update(channel, data) {
        channel.shared.presence.set(channel.client.clientId, data);
        emitPresence(channel, 'update', data);
        return Promise.resolve();
      },
      leave(channel) {
        const data = channel.shared.presence.get(channel.client.clientId);
        channel.shared.presence.delete(channel.client.clientId);
        emitPresence(channel, 'leave', data);
        return Promise.resolve();
      },
      get(channel) {
        return Promise.resolve(
          [...channel.shared.presence.entries()].map(([clientId, data]) => ({
            clientId,
            data,
            action: 'present',
          })),
        );
      },
      subscribe(channel, handler) {
        channel.shared.presenceListeners.add(handler);
        return () => channel.shared.presenceListeners.delete(handler);
      },
    },
  };

  function emitPresence(channel, action, data) {
    const member = { clientId: channel.client.clientId, data, action };
    for (const listener of [...channel.shared.presenceListeners]) listener(member);
  }
}
