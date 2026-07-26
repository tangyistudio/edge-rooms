/**
 * room.js — framework-free room handle.
 *
 * `joinRoom` resolves the shared client, attaches to one channel, and returns
 * a small object with publish / subscribe / presence / leave. No React, no
 * globals, nothing that needs a DOM.
 */

import { getClient } from './client.js';

/** Default channel namespace. Channels are `${namespace}:room:${room}`. */
export const DEFAULT_NAMESPACE = 'rooms';

/**
 * Build the channel name for a room.
 *
 * Kept as a separate export because your token capability has to grant the
 * same pattern — see `edge-rooms/edge`.
 *
 * @param {string} room
 * @param {string} [namespace]
 * @returns {string}
 */
export function roomChannelName(room, namespace = DEFAULT_NAMESPACE) {
  return `${namespace}:room:${room}`;
}

/**
 * Join a room.
 *
 * @param {object} options
 * @param {object} options.adapter provider adapter (see client.js)
 * @param {string} options.room room code
 * @param {string} [options.namespace='rooms']
 * @param {(msg: {name: string, data: unknown, clientId?: string}) => void} [options.onMessage]
 * @param {(member: {clientId: string, data: unknown, action: string}) => void} [options.onPresence]
 * @param {(state: string) => void} [options.onConnectionState]
 * @param {(err: Error, context: string) => void} [options.onError]
 * @param {unknown} [options.presenceData] if provided, enter presence on join
 * @param {object} [options.clientOptions] passed to `getClient`
 * @returns {Promise<object>} room handle
 */
export async function joinRoom(options) {
  const {
    adapter,
    room,
    namespace = DEFAULT_NAMESPACE,
    onMessage,
    onPresence,
    onConnectionState,
    onError,
    presenceData,
    clientOptions,
  } = options || {};

  if (!adapter) throw new TypeError('joinRoom requires an adapter');
  if (!room) throw new TypeError('joinRoom requires a room code');

  const report = (err, context) => {
    if (typeof onError === 'function') onError(err, context);
  };

  const channelName = roomChannelName(room, namespace);
  const client = await getClient(adapter, clientOptions || {});
  const channel = adapter.getChannel(client, channelName);

  let left = false;
  /** @type {Set<Function>} */
  const messageHandlers = new Set();
  /** @type {Set<Function>} */
  const presenceHandlers = new Set();
  /** @type {Function[]} */
  const teardown = [];

  if (typeof onMessage === 'function') messageHandlers.add(onMessage);
  if (typeof onPresence === 'function') presenceHandlers.add(onPresence);

  const fanOut = (handlers, payload, context) => {
    for (const handler of [...handlers]) {
      try {
        handler(payload);
      } catch (err) {
        report(err, context);
      }
    }
  };

  const unsubscribeMessages = await adapter.subscribe(channel, (message) =>
    fanOut(messageHandlers, message, 'onMessage'),
  );
  if (typeof unsubscribeMessages === 'function') teardown.push(unsubscribeMessages);

  if (adapter.presence && typeof adapter.presence.subscribe === 'function') {
    const unsubscribePresence = adapter.presence.subscribe(channel, (member) =>
      fanOut(presenceHandlers, member, 'onPresence'),
    );
    if (typeof unsubscribePresence === 'function') teardown.push(unsubscribePresence);
  }

  if (typeof onConnectionState === 'function' &&
      typeof adapter.onConnectionState === 'function') {
    const unsubscribeState = adapter.onConnectionState(client, onConnectionState);
    if (typeof unsubscribeState === 'function') teardown.push(unsubscribeState);
    if (typeof adapter.connectionState === 'function') {
      onConnectionState(adapter.connectionState(client));
    }
  }

  if (presenceData !== undefined && adapter.presence) {
    try {
      await adapter.presence.enter(channel, presenceData);
    } catch (err) {
      report(err, 'presence.enter');
    }
  }

  return {
    channelName,
    client,
    channel,

    /**
     * Current connection state, or `'unknown'` if the adapter does not
     * expose one.
     * @returns {string}
     */
    state() {
      return typeof adapter.connectionState === 'function'
        ? adapter.connectionState(client)
        : 'unknown';
    },

    /** @returns {boolean} */
    connected() {
      return this.state() === 'connected';
    },

    /**
     * Publish to the room.
     *
     * Never throws. Failures are handed to `onError` and reported as `false`.
     * This is deliberate and carried over from the app this was extracted
     * from: a dropped publish there was covered by a slower fallback path, and
     * an exception escaping a click handler was worse than a lost message.
     * If you want failures to be fatal, check the return value.
     *
     * @param {string} name
     * @param {unknown} data
     * @returns {Promise<boolean>} true if the provider accepted it
     */
    async publish(name, data) {
      if (left) return false;
      try {
        await adapter.publish(channel, name, data);
        return true;
      } catch (err) {
        report(err, 'publish');
        return false;
      }
    },

    /**
     * Add a message handler.
     * @param {(msg: object) => void} handler
     * @returns {() => void} remove it
     */
    subscribe(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },

    /**
     * Add a presence handler.
     * @param {(member: object) => void} handler
     * @returns {() => void} remove it
     */
    onPresence(handler) {
      presenceHandlers.add(handler);
      return () => presenceHandlers.delete(handler);
    },

    presence: {
      /** @param {unknown} data */
      enter(data) {
        if (!adapter.presence) return Promise.resolve();
        return adapter.presence.enter(channel, data);
      },
      /** @param {unknown} data */
      update(data) {
        if (!adapter.presence) return Promise.resolve();
        return adapter.presence.update(channel, data);
      },
      leave() {
        if (!adapter.presence) return Promise.resolve();
        return adapter.presence.leave(channel);
      },
      /** @returns {Promise<Array<{clientId: string, data: unknown, action: string}>>} */
      get() {
        if (!adapter.presence) return Promise.resolve([]);
        return adapter.presence.get(channel);
      },
    },

    /**
     * Detach from the room. The shared client stays open for other rooms —
     * use `releaseClient` to close the connection itself.
     * @returns {Promise<void>}
     */
    async leave() {
      if (left) return;
      left = true;
      for (const fn of teardown.splice(0).reverse()) {
        try {
          fn();
        } catch (err) {
          report(err, 'teardown');
        }
      }
      messageHandlers.clear();
      presenceHandlers.clear();
      try {
        if (adapter.presence) await adapter.presence.leave(channel);
      } catch (err) {
        report(err, 'presence.leave');
      }
      try {
        await adapter.detach(channel);
      } catch (err) {
        report(err, 'detach');
      }
    },
  };
}
