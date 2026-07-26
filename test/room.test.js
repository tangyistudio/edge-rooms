import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createStubAdapter,
  getClient,
  releaseClient,
  resetClients,
  joinRoom,
  roomChannelName,
  seededShuffle,
  makeRoomSeed,
} from '../src/index.js';

/** A fresh adapter with its own singleton key, so tests never share state. */
let counter = 0;
function freshAdapter(overrides = {}) {
  counter += 1;
  return createStubAdapter({ name: `stub-${counter}`, ...overrides });
}

/** Two adapters that talk to each other, as two devices would. */
function pair() {
  counter += 1;
  const a = createStubAdapter({ name: `pair-a-${counter}`, clientId: 'device-a' });
  const b = createStubAdapter({ name: `pair-b-${counter}`, bus: a.bus, clientId: 'device-b' });
  return { a, b };
}

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

test.afterEach(() => resetClients());

test('roomChannelName namespaces the room code', () => {
  assert.equal(roomChannelName('R4TQ'), 'rooms:room:R4TQ');
  assert.equal(roomChannelName('R4TQ', 'quiz'), 'quiz:room:R4TQ');
});

test('getClient returns one shared client per adapter', async () => {
  const adapter = freshAdapter();
  const [first, second] = await Promise.all([getClient(adapter), getClient(adapter)]);
  assert.equal(first, second, 'concurrent callers share one client');
  assert.equal(await getClient(adapter), first, 'later callers get the same one');
  await releaseClient(adapter);
  assert.notEqual(await getClient(adapter), first, 'released clients are rebuilt');
});

test('getClient does not cache a failed creation', async () => {
  let attempts = 0;
  const adapter = {
    name: `flaky-${++counter}`,
    createClient() {
      attempts += 1;
      if (attempts === 1) throw new Error('boom');
      return { ok: true };
    },
    getChannel: () => ({}),
    subscribe: () => () => {},
    publish: () => Promise.resolve(),
    detach: () => {},
  };

  await assert.rejects(() => getClient(adapter), /boom/);
  assert.deepEqual(await getClient(adapter), { ok: true });
  assert.equal(attempts, 2);
});

test('getClient rejects an adapter without createClient', async () => {
  await assert.rejects(() => getClient({}), TypeError);
});

test('joinRoom validates its arguments', async () => {
  await assert.rejects(() => joinRoom({ room: 'R4TQ' }), TypeError);
  await assert.rejects(() => joinRoom({ adapter: freshAdapter() }), TypeError);
});

test('two devices in one room see each other messages', async () => {
  const { a, b } = pair();
  const received = [];

  const roomA = await joinRoom({ adapter: a, room: 'R4TQ', onMessage: (m) => received.push(m) });
  const roomB = await joinRoom({ adapter: b, room: 'R4TQ' });

  assert.equal(roomA.channelName, 'rooms:room:R4TQ');
  assert.equal(await roomB.publish('answer', { choice: 2 }), true);

  assert.deepEqual(received, [
    { name: 'answer', data: { choice: 2 }, clientId: 'device-b' },
  ]);

  await roomA.leave();
  await roomB.leave();
});

test('rooms are isolated by code and by namespace', async () => {
  const { a, b } = pair();
  const heard = [];

  const roomA = await joinRoom({ adapter: a, room: 'AAAA', onMessage: (m) => heard.push(m.name) });
  const other = await joinRoom({ adapter: b, room: 'BBBB' });
  const sameCodeOtherNamespace = await joinRoom({
    adapter: b,
    room: 'AAAA',
    namespace: 'quiz',
  });

  await other.publish('nope', {});
  await sameCodeOtherNamespace.publish('also-nope', {});
  assert.deepEqual(heard, []);

  await roomA.leave();
  await other.leave();
  await sameCodeOtherNamespace.leave();
});

test('subscribe adds and removes extra handlers', async () => {
  const { a, b } = pair();
  const seen = [];

  const roomA = await joinRoom({ adapter: a, room: 'R4TQ' });
  const roomB = await joinRoom({ adapter: b, room: 'R4TQ' });

  const off = roomA.subscribe((m) => seen.push(m.name));
  await roomB.publish('one', {});
  off();
  await roomB.publish('two', {});

  assert.deepEqual(seen, ['one']);
  await roomA.leave();
  await roomB.leave();
});

test('a throwing handler does not break the others', async () => {
  const { a, b } = pair();
  const errors = [];
  const seen = [];

  const roomA = await joinRoom({
    adapter: a,
    room: 'R4TQ',
    onError: (err, context) => errors.push(context),
    onMessage: () => {
      throw new Error('handler exploded');
    },
  });
  roomA.subscribe((m) => seen.push(m.name));

  const roomB = await joinRoom({ adapter: b, room: 'R4TQ' });
  await roomB.publish('still-delivered', {});

  assert.deepEqual(seen, ['still-delivered']);
  assert.deepEqual(errors, ['onMessage']);

  await roomA.leave();
  await roomB.leave();
});

test('publish reports failure instead of throwing', async () => {
  const adapter = freshAdapter();
  const contexts = [];
  adapter.publish = () => Promise.reject(new Error('network down'));

  const room = await joinRoom({
    adapter,
    room: 'R4TQ',
    onError: (err, context) => contexts.push(context),
  });

  assert.equal(await room.publish('ping', {}), false);
  assert.deepEqual(contexts, ['publish']);
  await room.leave();
});

test('publish after leave is a no-op', async () => {
  const adapter = freshAdapter();
  const room = await joinRoom({ adapter, room: 'R4TQ' });
  await room.leave();
  assert.equal(await room.publish('ping', {}), false);
});

test('leave is idempotent and detaches the listeners', async () => {
  const { a, b } = pair();
  const seen = [];

  const roomA = await joinRoom({ adapter: a, room: 'R4TQ', onMessage: (m) => seen.push(m.name) });
  const roomB = await joinRoom({ adapter: b, room: 'R4TQ' });

  await roomB.publish('before', {});
  await roomA.leave();
  await roomA.leave();
  await roomB.publish('after', {});

  assert.deepEqual(seen, ['before']);
  await roomB.leave();
});

test('presence enter, get, leave and notifications', async () => {
  const { a, b } = pair();
  const events = [];

  const roomA = await joinRoom({
    adapter: a,
    room: 'R4TQ',
    presenceData: { name: 'Ana' },
    onPresence: (member) => events.push(`${member.action}:${member.clientId}`),
  });
  const roomB = await joinRoom({ adapter: b, room: 'R4TQ', presenceData: { name: 'Bo' } });

  const members = await roomA.presence.get();
  assert.deepEqual(
    members.map((m) => m.clientId).sort(),
    ['device-a', 'device-b'],
  );
  assert.deepEqual(
    members.find((m) => m.clientId === 'device-b').data,
    { name: 'Bo' },
  );

  await roomB.presence.update({ name: 'Bo', ready: true });
  await roomB.leave();
  await nextTick();

  assert.ok(events.includes('enter:device-b'));
  assert.ok(events.includes('update:device-b'));
  assert.ok(events.includes('leave:device-b'));

  assert.deepEqual((await roomA.presence.get()).map((m) => m.clientId), ['device-a']);
  await roomA.leave();
});

test('presence calls are safe on an adapter without presence support', async () => {
  const adapter = freshAdapter();
  delete adapter.presence;

  const room = await joinRoom({ adapter, room: 'R4TQ', presenceData: { name: 'Ana' } });
  assert.deepEqual(await room.presence.get(), []);
  await room.presence.enter({});
  await room.presence.update({});
  await room.presence.leave();
  await room.leave();
});

test('connection state is reported and observable', async () => {
  const adapter = freshAdapter();
  const states = [];
  const room = await joinRoom({
    adapter,
    room: 'R4TQ',
    onConnectionState: (s) => states.push(s),
  });

  assert.equal(room.state(), 'connected');
  assert.equal(room.connected(), true);
  assert.deepEqual(states, ['connected'], 'current state is delivered on join');

  await releaseClient(adapter);
  assert.deepEqual(states, ['connected', 'closed']);
  await room.leave();
});

test('state() is "unknown" when the adapter does not report one', async () => {
  const adapter = {
    name: `bare-${++counter}`,
    createClient: () => ({}),
    getChannel: () => ({}),
    subscribe: () => undefined,
    publish: () => Promise.resolve(),
    detach: () => {},
  };
  const room = await joinRoom({ adapter, room: 'R4TQ' });
  assert.equal(room.state(), 'unknown');
  assert.equal(room.connected(), false);
  await room.leave();
});

test('end to end: a seed on the wire beats a list on the wire', async () => {
  // The host publishes one number. Every device derives the same order from
  // it without the order itself ever being transmitted.
  const { a, b } = pair();
  const questions = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'];

  let hostOrder = null;
  let guestOrder = null;

  const guest = await joinRoom({
    adapter: b,
    room: 'R4TQ',
    onMessage: (msg) => {
      if (msg.name !== 'round') return;
      guestOrder = seededShuffle(questions, makeRoomSeed(msg.data.room, msg.data.round));
    },
  });

  const host = await joinRoom({ adapter: a, room: 'R4TQ' });
  const payload = { room: 'R4TQ', round: 7 };
  hostOrder = seededShuffle(questions, makeRoomSeed(payload.room, payload.round));
  await host.publish('round', payload);

  assert.deepEqual(guestOrder, hostOrder);
  assert.notDeepEqual(guestOrder, questions, 'the order really was shuffled');

  await host.leave();
  await guest.leave();
});
