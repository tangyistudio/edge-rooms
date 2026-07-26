/**
 * seed.js — deterministic, seed-derived ordering.
 *
 * Pure module: no DOM, no network, no timers, no globals beyond `Math.imul`.
 * Every function is a pure function of its arguments, so the same seed string
 * produces the same result in every JavaScript runtime, on every device, on
 * every render.
 *
 * The hash + PRNG below are ported unchanged from a production app:
 *   - FNV-1a (32-bit) over the seed string  — offset basis 2166136261, prime 16777619
 *   - LCG                                    — multiplier 1103515245, increment 12345
 *   - Fisher-Yates, walking the array downwards
 *
 * The two problems it was written to solve, in the original author's words:
 * a stable order across re-renders, and an identical order on every device in
 * a room.
 */

const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;
const LCG_MULTIPLIER = 1103515245;
const LCG_INCREMENT = 12345;

/**
 * FNV-1a 32-bit hash of a string, returned as an unsigned 32-bit integer.
 *
 * An empty / nullish seed is coerced to the string "x" so that callers who
 * forget to pass a seed still get a defined (if useless) result rather than
 * NaN. That fallback is carried over from the original implementation.
 *
 * @param {string} seedStr
 * @returns {number} unsigned 32-bit integer
 */
export function hashSeed(seedStr) {
  let s = FNV_OFFSET_BASIS >>> 0;
  const str = String(seedStr || 'x');
  for (let i = 0; i < str.length; i++) {
    s ^= str.charCodeAt(i);
    s = Math.imul(s, FNV_PRIME) >>> 0;
  }
  return s;
}

/**
 * Build a seeded pseudo-random generator.
 *
 * The returned function yields the next unsigned 32-bit LCG state on each
 * call. It is not cryptographically secure and is not meant to be — its only
 * job is to be identical everywhere.
 *
 * Known weakness, inherited from the LCG: because the modulus is 2^32, bit 0
 * of the state has period 2 and bits 0-1 have period 4. `next() % smallN` is
 * therefore strongly patterned. If you are writing your own consumer and want
 * a uniform value, take the *high* bits instead:
 *
 *   const j = Math.floor((next() / 4294967296) * n);
 *
 * Measured over 200k seeds shuffling 10 items, that variant keeps every
 * position/value cell within 0.99x-1.01x of expected, where `seededShuffle`
 * (which uses the low bits, as the original did) ranges 0.28x-2.31x.
 *
 * @param {string} seedStr
 * @returns {() => number} next() -> unsigned 32-bit integer
 */
export function makeRng(seedStr) {
  let s = hashSeed(seedStr);
  return function next() {
    s = (Math.imul(s, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
    return s;
  };
}

/**
 * Deterministic Fisher-Yates shuffle.
 *
 * Returns a new array; the input is never mutated.
 *
 * This is the exact algorithm that shipped, low bits and all, so that clients
 * built against the original still agree with clients built against this
 * package. It is a good shuffle in the sense that matters here — everyone
 * computes the same one — and a mediocre one statistically: see `makeRng` for
 * the measured skew and the one-line variant that avoids it.
 *
 * @template T
 * @param {readonly T[]} arr
 * @param {string} seedStr
 * @returns {T[]}
 */
export function seededShuffle(arr, seedStr) {
  const a = Array.prototype.slice.call(arr);
  const next = makeRng(seedStr);
  for (let i = a.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/**
 * Deterministic integer in the inclusive range [min, max].
 *
 * Uses a single modulo of the 32-bit LCG state. That is fast and stable
 * across runtimes, but it is *not* perfectly uniform: when the range size
 * does not divide 2^32, the lowest values of the range are very slightly
 * more likely. The skew is on the order of rangeSize / 2^32 and is
 * irrelevant for orderings, turn assignment and picking; do not use this
 * where uniformity is a security property.
 *
 * @param {string} seedStr
 * @param {number} min inclusive
 * @param {number} max inclusive
 * @returns {number}
 */
export function seededInt(seedStr, min, max) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  const span = hi - lo + 1;
  if (!Number.isFinite(span) || span <= 1) return lo;
  const next = makeRng(seedStr);
  return lo + (next() % span);
}

/**
 * Deterministically pick one element of an array.
 *
 * Returns `undefined` for an empty array.
 *
 * @template T
 * @param {readonly T[]} arr
 * @param {string} seedStr
 * @returns {T | undefined}
 */
export function seededPick(arr, seedStr) {
  if (!arr || arr.length === 0) return undefined;
  const next = makeRng(seedStr);
  return arr[next() % arr.length];
}

/**
 * Join any number of parts into one stable seed string.
 *
 * The point is to make the seed explicit and reproducible: everything that
 * should change the derived order goes in, and nothing else does. A room code
 * plus a round number is the usual shape.
 *
 *   makeRoomSeed('R4TQ', 3)  // -> "R4TQ|3"
 *
 * `null` and `undefined` become empty segments rather than the strings
 * "null" / "undefined", so an accidental missing part is at least stable.
 *
 * @param {...unknown} parts
 * @returns {string}
 */
export function makeRoomSeed(...parts) {
  return parts
    .map((p) => (p === null || p === undefined ? '' : String(p)))
    .join('|');
}
