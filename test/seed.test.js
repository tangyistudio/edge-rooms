import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hashSeed,
  makeRng,
  seededShuffle,
  seededInt,
  seededPick,
  makeRoomSeed,
} from '../src/seed.js';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const TEN = Array.from({ length: 10 }, (_, i) => i);

test('hashSeed is a pure unsigned 32-bit function of the string', () => {
  const a = hashSeed('room-42');
  const b = hashSeed('room-42');
  assert.equal(a, b);
  assert.ok(Number.isInteger(a));
  assert.ok(a >= 0 && a <= 0xffffffff);
  assert.notEqual(hashSeed('room-42'), hashSeed('room-43'));
});

test('hashSeed matches an independently computed FNV-1a value', () => {
  // Recomputed here from the FNV-1a definition, not from the implementation.
  const fnv1a = (str) => {
    let h = 2166136261 >>> 0;
    for (const ch of str) {
      h = (h ^ ch.charCodeAt(0)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  };
  for (const s of ['', 'a', 'abc', 'room-42|3', 'the quick brown fox']) {
    assert.equal(hashSeed(s || 'x'), fnv1a(s || 'x'), `mismatch for ${JSON.stringify(s)}`);
  }
});

test('empty and nullish seeds fall back to the same defined value', () => {
  const fallback = hashSeed('x');
  assert.equal(hashSeed(''), fallback);
  assert.equal(hashSeed(undefined), fallback);
  assert.equal(hashSeed(null), fallback);
});

test('makeRng is deterministic and stays in uint32 range', () => {
  const a = makeRng('seed');
  const b = makeRng('seed');
  for (let i = 0; i < 100; i++) {
    const value = a();
    assert.equal(value, b());
    assert.ok(Number.isInteger(value));
    assert.ok(value >= 0 && value <= 0xffffffff);
  }
});

test('seededShuffle: same seed, same output', () => {
  const first = seededShuffle(LETTERS, 'R4TQ|1');
  const second = seededShuffle(LETTERS, 'R4TQ|1');
  assert.deepEqual(first, second);
});

test('seededShuffle: eight independent callers agree', () => {
  // The whole point: eight devices, one seed, one order.
  const seed = makeRoomSeed('R4TQ', 3);
  const orders = Array.from({ length: 8 }, () => seededShuffle(LETTERS, seed));
  for (const order of orders) assert.deepEqual(order, orders[0]);
});

test('seededShuffle: different seeds give different orders', () => {
  const a = seededShuffle(LETTERS, 'seed-a');
  const b = seededShuffle(LETTERS, 'seed-b');
  assert.notDeepEqual(a, b);
});

test('seededShuffle: output is a permutation of the input', () => {
  const shuffled = seededShuffle(LETTERS, 'permutation');
  assert.equal(shuffled.length, LETTERS.length);
  assert.deepEqual([...shuffled].sort(), [...LETTERS].sort());
});

test('seededShuffle: input array is not mutated', () => {
  const input = [...LETTERS];
  const snapshot = [...input];
  const out = seededShuffle(input, 'no-mutation');
  assert.deepEqual(input, snapshot);
  assert.notEqual(out, input);
});

test('seededShuffle: empty and single-element arrays', () => {
  assert.deepEqual(seededShuffle([], 'seed'), []);
  assert.deepEqual(seededShuffle(['only'], 'seed'), ['only']);
  assert.deepEqual(seededShuffle(['only'], 'other'), ['only']);
});

test('seededShuffle: accepts array-likes without mutating them', () => {
  const input = Object.freeze(['a', 'b', 'c']);
  const out = seededShuffle(input, 'frozen');
  assert.equal(out.length, 3);
  assert.deepEqual([...out].sort(), ['a', 'b', 'c']);
});

test('seededShuffle: distribution sanity — no fixed points across seeds', () => {
  // Each position should see more than one distinct value over many seeds.
  // A broken shuffle (identity, or a constant j) fails this immediately.
  const seen = TEN.map(() => new Set());
  for (let s = 0; s < 400; s++) {
    const order = seededShuffle(TEN, `seed-${s}`);
    order.forEach((value, index) => seen[index].add(value));
  }
  for (const [index, values] of seen.entries()) {
    assert.ok(
      values.size >= 8,
      `position ${index} only ever held ${values.size} distinct values`,
    );
  }
});

test('seededShuffle: distribution sanity — every element reaches every position', () => {
  const counts = TEN.map(() => new Array(TEN.length).fill(0));
  for (let s = 0; s < 20000; s++) {
    seededShuffle(TEN, `matrix-${s}`).forEach((value, index) => {
      counts[index][value] += 1;
    });
  }
  for (const [index, row] of counts.entries()) {
    for (const [value, count] of row.entries()) {
      assert.ok(count > 0, `element ${value} never reached position ${index}`);
    }
  }
});

test('seededShuffle: positions drawn with a large modulus are near-uniform', () => {
  // Positions are filled from the end of the array downwards, so the highest
  // indices are chosen with the largest moduli and are unbiased. See the
  // companion test below for what happens at the other end.
  const trials = 40000;
  const counts = new Array(TEN.length).fill(0);
  for (let s = 0; s < trials; s++) counts[seededShuffle(TEN, `tail-${s}`).at(-1)] += 1;

  const expected = trials / TEN.length;
  for (const [value, count] of counts.entries()) {
    assert.ok(
      count > expected * 0.9 && count < expected * 1.1,
      `element ${value} landed last ${count} times, expected around ${expected}`,
    );
  }
});

test('seededShuffle: the known low-bit skew of the ported LCG is still there', () => {
  // Documented, not accidental. The LCG has modulus 2^32, so its lowest bit
  // has period 2 and its lowest two bits period 4. The final swaps take
  // `next() % 2` and `next() % 3`, which makes the first few positions
  // measurably non-uniform. This test pins that so the behaviour cannot
  // change without the README changing with it. See "Limits".
  const trials = 40000;
  const counts = new Array(TEN.length).fill(0);
  for (let s = 0; s < trials; s++) counts[seededShuffle(TEN, `head-${s}`)[0]] += 1;

  const expected = trials / TEN.length;
  const ratios = counts.map((c) => c / expected);
  assert.ok(
    Math.max(...ratios) > 1.5,
    `expected a visible skew at position 0, saw max ratio ${Math.max(...ratios).toFixed(2)}`,
  );
});

test('seededShuffle: golden vectors — output is byte-compatible with the original', () => {
  // If these change, every already-shipped client disagrees with every new
  // one. Treat a failure here as a breaking change, not a flaky test.
  assert.equal(seededShuffle(LETTERS, 'R4TQ|3').join(''), 'IDZMJTHWVRKNFYPXUGBALCQEOS');
  assert.deepEqual(seededShuffle(TEN, 'seed-0'), [1, 5, 8, 6, 9, 7, 0, 4, 3, 2]);
  assert.equal(hashSeed('R4TQ|3'), 3601590473);
  assert.equal(hashSeed('x'), 4245442695);

  const rng = makeRng('R4TQ|3');
  assert.deepEqual([rng(), rng(), rng()], [3700788174, 3952704239, 3618134524]);
});

test('seededShuffle: orders differ for adjacent seeds', () => {
  // Consecutive rounds in the same room must not produce the same order.
  const distinct = new Set();
  for (let round = 1; round <= 50; round++) {
    distinct.add(seededShuffle(LETTERS, makeRoomSeed('R4TQ', round)).join(''));
  }
  assert.equal(distinct.size, 50);
});

test('seededInt is deterministic and stays in range', () => {
  for (let i = 0; i < 500; i++) {
    const value = seededInt(`turn-${i}`, 1, 6);
    assert.equal(value, seededInt(`turn-${i}`, 1, 6));
    assert.ok(Number.isInteger(value));
    assert.ok(value >= 1 && value <= 6, `${value} out of range`);
  }
});

test('seededInt covers its whole inclusive range', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(seededInt(`cover-${i}`, 1, 6));
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
});

test('seededInt handles degenerate and reversed ranges', () => {
  assert.equal(seededInt('seed', 5, 5), 5);
  assert.equal(seededInt('seed', 7, 3), seededInt('seed', 3, 7));
  assert.ok(seededInt('seed', 7, 3) >= 3 && seededInt('seed', 7, 3) <= 7);
});

test('seededPick is deterministic and only returns members', () => {
  for (let i = 0; i < 200; i++) {
    const picked = seededPick(LETTERS, `pick-${i}`);
    assert.equal(picked, seededPick(LETTERS, `pick-${i}`));
    assert.ok(LETTERS.includes(picked));
  }
});

test('seededPick handles empty and single-element arrays', () => {
  assert.equal(seededPick([], 'seed'), undefined);
  assert.equal(seededPick(['only'], 'seed'), 'only');
});

test('seededPick reaches every element', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(seededPick(TEN, `reach-${i}`));
  assert.equal(seen.size, TEN.length);
});

test('makeRoomSeed joins parts stably', () => {
  assert.equal(makeRoomSeed('R4TQ', 3), 'R4TQ|3');
  assert.equal(makeRoomSeed('R4TQ', 3), makeRoomSeed('R4TQ', 3));
  assert.notEqual(makeRoomSeed('R4TQ', 3), makeRoomSeed('R4TQ', 4));
  assert.equal(makeRoomSeed(), '');
});

test('makeRoomSeed turns nullish parts into empty segments', () => {
  assert.equal(makeRoomSeed('a', null, 'b'), 'a||b');
  assert.equal(makeRoomSeed('a', undefined, 'b'), 'a||b');
});

test('makeRoomSeed is not ambiguous for the common two-part case', () => {
  assert.notEqual(makeRoomSeed('a', 'b'), makeRoomSeed('ab'));
});
