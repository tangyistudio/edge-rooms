/**
 * useRoom.js — React binding for `joinRoom`.
 *
 * Plain `.js`, not `.jsx`: Node's ESM resolver will not load a `.jsx`
 * extension, which breaks `import('edge-rooms/react')` in tests and in SSR.
 * There is no JSX in this file; if you need an element here, use
 * `React.createElement`.
 *
 * `react` is an optional peer dependency. Importing this entry point without
 * React installed will fail — that is the intent, not a bug.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { joinRoom } from '../src/room.js';

/**
 * Subscribe to a room for as long as the component is mounted.
 *
 * Falsy `room` means "not in a room": nothing connects, and any previous room
 * is left. Changing `room` leaves the old one and joins the new one.
 *
 * The handler is held in a ref, so passing an inline arrow function does not
 * re-join the room on every render.
 *
 * @param {object} options
 * @param {object} options.adapter provider adapter
 * @param {string} [options.room] room code; falsy disables the hook
 * @param {string} [options.namespace]
 * @param {(msg: {name: string, data: unknown, clientId?: string}) => void} [options.onMessage]
 * @param {unknown} [options.presenceData] enter presence with this payload
 * @param {(err: Error, context: string) => void} [options.onError]
 * @param {object} [options.clientOptions]
 * @returns {{publish: (name: string, data: unknown) => Promise<boolean>,
 *   connected: boolean, state: string, members: Array<object>,
 *   error: Error|null, leave: () => Promise<void>}}
 */
export function useRoom(options = {}) {
  const {
    adapter,
    room,
    namespace,
    onMessage,
    onPresence,
    presenceData,
    onError,
    clientOptions,
  } = options;

  const [state, setState] = useState('initialized');
  const [members, setMembers] = useState([]);
  const [error, setError] = useState(null);

  const roomRef = useRef(null);
  const messageRef = useRef(onMessage);
  const presenceRef = useRef(onPresence);
  const errorRef = useRef(onError);
  messageRef.current = onMessage;
  presenceRef.current = onPresence;
  errorRef.current = onError;

  useEffect(() => {
    if (!adapter || !room) {
      setState('initialized');
      setMembers([]);
      return undefined;
    }

    let cancelled = false;
    let handle = null;

    const report = (err, context) => {
      if (errorRef.current) errorRef.current(err, context);
    };

    const refreshMembers = (current) => {
      current.presence
        .get()
        .then((list) => {
          if (!cancelled) setMembers(list);
        })
        .catch((err) => report(err, 'presence.get'));
    };

    (async () => {
      try {
        const current = await joinRoom({
          adapter,
          room,
          namespace,
          presenceData,
          clientOptions,
          onError: report,
          onMessage: (msg) => {
            if (messageRef.current) messageRef.current(msg);
          },
          onPresence: (member) => {
            if (presenceRef.current) presenceRef.current(member);
            if (!cancelled) refreshMembers(current);
          },
          onConnectionState: (next) => {
            if (!cancelled) setState(next);
          },
        });

        if (cancelled) {
          await current.leave();
          return;
        }

        handle = current;
        roomRef.current = current;
        setError(null);
        setState(current.state());
        refreshMembers(current);
      } catch (err) {
        // Joining is allowed to fail: the room is an accelerator, and an app
        // with any fallback path should keep working without it.
        if (cancelled) return;
        roomRef.current = null;
        setError(err);
        setState('failed');
        report(err, 'join');
      }
    })();

    return () => {
      cancelled = true;
      roomRef.current = null;
      if (handle) handle.leave().catch(() => {});
    };
    // `presenceData` is read once at join time on purpose; use
    // `presence.update` for later changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, room, namespace, clientOptions]);

  const publish = useCallback(async (name, data) => {
    const current = roomRef.current;
    if (!current) return false;
    return current.publish(name, data);
  }, []);

  const leave = useCallback(async () => {
    const current = roomRef.current;
    roomRef.current = null;
    if (current) await current.leave();
  }, []);

  return {
    publish,
    leave,
    connected: state === 'connected',
    state,
    members,
    error,
  };
}
