# edge-rooms

**To make eight phones show the same order, don't sync the list — sync one number.**

Realtime multiplayer rooms without running a game server: sign realtime tokens from an edge
function, derive shared state from a seed.

Zero runtime dependencies. ESM only. Node 18+, and any browser that can run a module script.

---

## The problem, in three lines

1. Every device in a room has to see the same thing in the same order, and keep seeing it after
   a re-render or a reconnect.
2. Broadcasting the ordered list means the list is now state you have to version, resend to
   latecomers, and reconcile when two devices disagree.
3. Standing up a server just to be the authority on "what order are we in" is a lot of
   infrastructure for one integer.

---

## 1. The seed idea

A pseudo-random shuffle is a pure function of its seed. If every device agrees on the seed, every
device computes the same order — with no message describing that order ever crossing the wire.

```js
import { seededShuffle, makeRoomSeed } from 'edge-rooms/seed';

const questions = ['ocean', 'gas', 'minutes', 'moons', 'mountain', 'metal'];
const seed = makeRoomSeed('R4TQ', 3);        // room code + round number

seededShuffle(questions, seed);              // same array on every device
seededShuffle(questions, seed);              // same array on every re-render
seededShuffle(questions, makeRoomSeed('R4TQ', 4)); // next round, new order
```

So the host publishes `{ room: 'R4TQ', round: 3 }` — 25 bytes of JSON — and a six-item list, a
six-hundred-item list and a lazily-fetched list all cost exactly the same on the wire. A device
that joins late replays the same function and lands in the same place.

Under the hood: FNV-1a over the seed string, an LCG stepped from that hash, Fisher-Yates walking
the array downwards. Everything is 32-bit integer arithmetic via `Math.imul`, which is
spec-defined, so two engines cannot disagree about the result. It is optimised for agreement, not
for statistical quality — the shuffle has a measurable bias, quantified under
[Limits](#7-limits).

```js
import { hashSeed, makeRng, seededInt, seededPick } from 'edge-rooms/seed';

hashSeed('R4TQ|3');                    // 32-bit unsigned integer
makeRng('R4TQ|3');                     // () => next uint32
seededInt('R4TQ|3', 1, 6);             // integer in [1, 6]
seededPick(players, 'R4TQ|3:first');   // who goes first
```

`edge-rooms/seed` is pure: no DOM, no network, no timers. Import it on a server, in a worker, in a
test, or on its own without touching the rest of the package.

**It is not a CSPRNG, and it is not a secret.** Anyone holding the seed can compute the whole
sequence. Use it for ordering and selection, never to hide an answer or generate a token.

---

## 2. Signing tokens at the edge

To let a browser talk to a realtime service you have to hand it a credential, and you cannot hand
it your API key. The usual answer is to install the vendor's server SDK and have your backend call
the vendor's REST API for a token.

You don't have to. For providers whose auth format is a signed request — Ably's `TokenRequest` is
the one shipped here — the credential is just a small JSON object with an HMAC-SHA256 over its own
fields, keyed by the secret half of your API key. The browser SDK exchanges it for a real token by
itself. So the server side is one HMAC:

- **no vendor server SDK** — nothing to install, nothing to keep on a version treadmill;
- **no outbound HTTP from your backend** — the token endpoint does no network I/O at all, so it
  cannot fail because the vendor's API is slow or down;
- **runs in edge runtimes** — the signer uses only `globalThis.crypto.subtle`,
  `crypto.getRandomValues` and `TextEncoder`, which are standard globals rather than platform
  APIs. No Node built-ins, no `Buffer`, no `btoa`. The original shipped on Deno; this port is
  tested on Node 18–24 in CI. Cloudflare Workers and Vercel Edge expose the same three globals,
  but they are not part of the test matrix here — treat them as expected to work, not verified.

```js
// Cloudflare Workers / Vercel Edge
import { tokenRequestHandler } from 'edge-rooms/edge';

export default {
  fetch: tokenRequestHandler({
    apiKey: (/* env */) => process.env.ABLY_API_KEY,   // "appId.keyId:keySecret"
    authorize: async (request) => {
      const user = await myAuth(request);              // your session check
      return user ? user.id : null;                    // null => 401, no token issued
    },
    capability: { 'rooms:*': ['publish', 'subscribe', 'presence'] },
    ttl: 60 * 60 * 1000,
  }),
};
```

Or drop the wrapper and sign directly:

```js
import { createTokenRequest } from 'edge-rooms/edge';

const tokenRequest = await createTokenRequest(apiKey, {
  clientId: user.id,
  capability: { 'rooms:*': ['publish', 'subscribe', 'presence'] },
});
// -> { keyName, ttl, capability, clientId, timestamp, nonce, mac }
// Send this to the browser as-is. Only keyName travels; keySecret never leaves the server.
```

The signed fields are `keyName, ttl, capability, clientId, timestamp, nonce`, each terminated by a
newline — including the last one. That format is the provider's, not ours; if you are porting this
to another service, `tokenRequestSigningString` and `hmacSha256Base64` are exported so you can
build a different canonical string with the same primitives.

The nonce is 32 hex characters from `crypto.getRandomValues`. The documented minimum the original
targeted is 16, and `createNonce` will not go below it.

---

## 3. Room API

```js
import { joinRoom, createAblyAdapter } from 'edge-rooms';

const adapter = createAblyAdapter({ authUrl: '/api/realtime-token' });

const room = await joinRoom({
  adapter,
  room: 'R4TQ',
  namespace: 'rooms',                    // channel is `rooms:room:R4TQ`
  presenceData: { name: 'Ana' },
  onMessage: ({ name, data, clientId }) => { /* ... */ },
  onPresence: ({ action, clientId, data }) => { /* enter | update | leave */ },
  onConnectionState: (state) => { /* 'connected', 'disconnected', ... */ },
  onError: (err, context) => console.warn(context, err),
});

await room.publish('round', { room: 'R4TQ', round: 3 }); // -> true | false
const off = room.subscribe((msg) => { /* extra handler */ });
await room.presence.update({ name: 'Ana', ready: true });
await room.presence.get();                                // -> [{ clientId, data, action }]
room.state();                                             // provider connection state
room.connected();                                         // state === 'connected'
await room.leave();                                       // detach; connection stays open
```

Two behaviours worth knowing:

- **`publish` never throws.** It resolves to `true` or `false` and routes the error to `onError`.
  This is deliberate. In the app this came from, a lost publish was covered by a slower fallback
  path, and an exception escaping a click handler was strictly worse than a lost message. If you
  want failures to be fatal, check the return value.
- **The client is shared.** All rooms on one adapter reuse a single connection. The original kept
  a module-level singleton explicitly to conserve its connection count, and that is what this
  preserves. `room.leave()` detaches a channel; `releaseClient(adapter)` closes the connection
  itself.

```js
import { getClient, releaseClient } from 'edge-rooms';

await getClient(adapter);      // single-flight; concurrent callers share one client
await releaseClient(adapter);  // close it and forget it
```

---

## 4. React

`edge-rooms/react` is the only entry point that needs React (an optional peer dependency,
`>=16.8`). It is plain `.js` and contains no JSX, so it resolves under Node's ESM loader — in
tests and in SSR — without a build step.

```js
import { useRoom } from 'edge-rooms/react';
import { seededShuffle, makeRoomSeed } from 'edge-rooms/seed';
import { useMemo, useState } from 'react';

function Quiz({ adapter, roomCode, questions }) {
  const [round, setRound] = useState(1);

  const { publish, connected, members } = useRoom({
    adapter,
    room: roomCode,                       // falsy => not connected
    presenceData: { name: 'Ana' },
    onMessage: (msg) => {
      if (msg.name === 'round') setRound(msg.data.round);
    },
  });

  const order = useMemo(
    () => seededShuffle(questions, makeRoomSeed(roomCode, round)),
    [questions, roomCode, round],
  );

  return renderQuiz({ order, connected, members, onNext: () =>
    publish('round', { room: roomCode, round: round + 1 }) });
}
```

The message handler is held in a ref, so an inline arrow function does not re-join the room on
every render. Changing `room` leaves the old room and joins the new one; unmounting leaves.
Joining is allowed to fail — the hook reports `state: 'failed'` and an `error` rather than
throwing, on the assumption that an app with a fallback path should keep working without the
realtime channel.

---

## 5. Provider adapters

Nothing above names a vendor except `createAblyAdapter`. An adapter is a plain object:

```js
const adapter = {
  name: 'my-provider',

  createClient(options),                  // -> Promise<client> | client
  getChannel(client, channelName),        // -> channel
  subscribe(channel, handler),            // -> unsubscribe fn (may be async)
  publish(channel, eventName, data),      // -> Promise<void>
  detach(channel),                        // -> Promise<void> | void

  // optional
  connectionState(client),                // -> string, 'connected' when connected
  onConnectionState(client, handler),     // -> unsubscribe fn
  close(client),
  presence: {
    enter(channel, data), update(channel, data), leave(channel),
    get(channel),                         // -> Promise<[{ clientId, data, action }]>
    subscribe(channel, handler),          // -> unsubscribe fn
  },
};
```

`handler` receives a normalized `{ name, data, clientId }`; normalizing the provider's message
shape is the adapter's job. Omit `presence` and the presence methods on the room become
no-ops that resolve empty, so a provider without presence still works.

Two adapters ship in the box:

- **`createAblyAdapter({ authUrl })`** — loads the Ably browser SDK from their CDN
  (single-flight, once per page), and wires the SDK's `authCallback` to `fetch(authUrl)`, passing
  the signed TokenRequest through untouched. Pass `getTokenRequest` instead of `authUrl` to
  supply it yourself, `cdnUrl` to pin a different build, or `clientOptions` to reach the rest of
  the SDK's options.
- **`createStubAdapter({ bus })`** — in-memory. Adapters sharing a `bus` see each other's
  messages and presence, in one process or one page. That is what the tests and
  `examples/basic.html` run on: no account, no network.

If you bundle your SDK instead of loading it from a CDN, your adapter's `createClient` just
constructs it directly and `loadScriptOnce` never enters the picture.

---

## 6. Where this comes from

This package was extracted from a production app. The split below is exact, because a claim about
provenance is still a claim.

### Field-tested — carried over from a shipped app

- **The seeded shuffle**, constants and all: FNV-1a (`2166136261` / `16777619`), the LCG
  (`1103515245` / `12345`), and Fisher-Yates walking downwards. Ported unchanged, including the
  `"x"` fallback for an empty seed. The original's own comment names the two problems it solved:
  a stable order across re-renders, and an identical order for everyone in a room.
- **Signing the TokenRequest in the edge function with WebCrypto** instead of calling the
  vendor's API: the field order, the trailing newline on every line including the nonce, the
  HMAC-SHA256-to-base64 step, and splitting the API key at the first colon. This is the shape that
  actually ran.
- **Refusing to sign for an unauthenticated caller** before doing any crypto.
- **Handing the signed TokenRequest to the browser SDK's `authCallback` verbatim**, including
  accepting a `{ data: ... }` wrapper from backends that wrap responses.
- **Loading the SDK from a CDN behind a single-flight promise**, resolved from the global if it is
  already there.
- **One module-level realtime client for the whole app**, to conserve concurrent connections.
- **Channel naming as `<namespace>:room:<code>`**, matching the capability granted in the token.
- **The subscribe-on-mount / unsubscribe-and-detach-on-unmount lifecycle keyed by room code**,
  with the message handler in a ref, and a cancellation flag so a room that unmounts mid-connect
  is left rather than leaked.
- **Silent publish failure and silent join failure**, on the assumption that the realtime channel
  is an accelerator with something slower behind it.

### Added here — designed for this package, tested, no production mileage

- **The adapter abstraction itself.** The original was wired directly to one vendor. The Ably
  adapter is that code re-expressed against the contract; the stub adapter is new.
- **`seededInt`, `seededPick`, `makeRoomSeed`, `hashSeed`, `makeRng`** as separate exports. Only
  the shuffle existed before; the rest are the same primitives factored out.
- **The presence API.** The original granted `presence` in its token capability but the extracted
  client code did not use it. The wrappers here are written against the provider's documented
  presence API and covered by the stub adapter tests — they have never run against a live service.
- **`tokenRequestHandler`**, the keyed client registry, `releaseClient`, `resetClients`,
  `resetScriptCache`, and the `timeout` / `attributes` options on `loadScriptOnce`.
- **`bytesToBase64` and `createNonce`.** The original used `btoa` and two `randomUUID` calls;
  both are replaced with implementations that make no assumption about the host runtime.
- **Structured error reporting** (`onError` with a context string) and `publish` returning a
  boolean. The original swallowed errors into a console call.
- **`members` in `useRoom`**, and the normalized `{ name, data, clientId }` message shape.

Not claimed anywhere: benchmarks, browser-specific bug workarounds, or scale numbers. Nothing in
this README is measured, because nothing here was measured.

---

## 7. Limits

- **A seed gives you shared *derivation*, not shared *mutable state*.** Anything that is a
  consequence of the seed — order, assignment, selection — is free. Anything a participant
  *does* — an answer, a score, a vote, someone leaving — still has to travel over the realtime
  channel. This package does not replace the channel; it removes one particular thing from it.
- **No conflict resolution, no history, no replay.** A device that joins mid-round gets the seed
  and can derive the order, but it will not learn what anyone did before it arrived unless you
  send that yourself.
- **The PRNG is not secure.** Given the seed, the full sequence is computable by anyone. Do not
  seed anything you need to keep hidden until later.
- **`seededShuffle` is not statistically uniform, and this is measured.** The LCG has modulus
  2³², so its lowest bit repeats with period 2 and its lowest two bits with period 4. Fisher-Yates
  fills the array from the end downwards, so the last few swaps use `next() % 2` and `next() % 3`
  — exactly the bits that are patterned. Over 200,000 seeds shuffling 10 items, the highest
  positions land within 0.99x–1.01x of the expected count, while the lowest positions range from
  0.28x to 2.31x. Every element still reaches every position, and every device still agrees, but
  do not use this where the distribution itself matters.

  The port is kept exact on purpose: changing it would make new clients disagree with clients
  already in the field, which is the one failure this whole approach exists to avoid. If you
  need a uniform shuffle and have no compatibility constraint, drive your own Fisher-Yates off
  the exported `makeRng` and take the high bits — `Math.floor((next() / 2 ** 32) * (i + 1))`
  measures at 0.99x–1.01x across the whole matrix.
- **`seededInt` uses modulo** and inherits the same low-bit weakness for small ranges, on top of
  the usual modulo bias toward the low end when the range size does not divide 2³².
- **The seed helpers are 32-bit.** The state space is 2³², which is plenty for distinguishing
  rounds and rooms but is not a large space in absolute terms.
- **`loadScriptOnce` needs a DOM.** Importing it in Node is safe; calling it is not. Everything
  else in the package runs anywhere.
- **Only one provider adapter ships.** The contract is small on purpose, but a second adapter is
  yours to write and yours to test.
- **The stub adapter is not a network.** It has no latency, no reordering, no disconnects. It is
  good for tests and demos and it will not tell you whether your reconnect logic works.

---

## Install

```sh
npm install edge-rooms
```

| Entry point | Contents | Needs |
| --- | --- | --- |
| `edge-rooms` | rooms, client, adapters, and the seed helpers | — |
| `edge-rooms/seed` | seed helpers only, pure | — |
| `edge-rooms/edge` | TokenRequest signer | WebCrypto |
| `edge-rooms/react` | `useRoom` | `react >= 16.8` |

## Run the example

```sh
npx http-server . -p 8080     # or any static server
# open http://localhost:8080/examples/basic.html
```

Four simulated devices, one in-memory bus, one published number.

## Test

```sh
npm test        # node --test
```

## License

MIT © 2026 Tangyi Studio

Built by [Tangyi Studio](https://github.com/tangyistudio)
