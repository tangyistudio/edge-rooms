import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';

import {
  bytesToBase64,
  parseApiKey,
  createNonce,
  tokenRequestSigningString,
  hmacSha256Base64,
  createTokenRequest,
  tokenRequestHandler,
  DEFAULT_TTL_MS,
  DEFAULT_CAPABILITY,
} from '../edge/ably-token.js';

const API_KEY = 'demoApp.demoKey:s3cr3t-key-material';
const KEY_NAME = 'demoApp.demoKey';
const KEY_SECRET = 's3cr3t-key-material';

/**
 * Independent reference implementation, using node:crypto rather than the
 * WebCrypto path the module under test uses. If both agree, the signing
 * string and the base64 encoder are both right.
 */
function referenceMac(secret, message) {
  return createHmac('sha256', secret).update(message, 'utf8').digest('base64');
}

test('bytesToBase64 matches node:crypto for every tail length', () => {
  for (let len = 0; len < 200; len++) {
    const bytes = randomBytes(len);
    assert.equal(
      bytesToBase64(new Uint8Array(bytes)),
      bytes.toString('base64'),
      `mismatch at length ${len}`,
    );
  }
});

test('bytesToBase64 handles a known vector', () => {
  const bytes = new TextEncoder().encode('any carnal pleasure.');
  assert.equal(bytesToBase64(bytes), 'YW55IGNhcm5hbCBwbGVhc3VyZS4=');
});

test('parseApiKey splits at the first colon only', () => {
  assert.deepEqual(parseApiKey(API_KEY), {
    keyName: KEY_NAME,
    keySecret: KEY_SECRET,
  });
  assert.deepEqual(parseApiKey('a.b:c:d'), { keyName: 'a.b', keySecret: 'c:d' });
});

test('parseApiKey rejects missing or malformed keys', () => {
  assert.throws(() => parseApiKey(undefined), TypeError);
  assert.throws(() => parseApiKey(''), TypeError);
  assert.throws(() => parseApiKey('no-colon-here'), /appId\.keyId:keySecret/);
});

test('createNonce returns at least 16 hex characters and varies', () => {
  const a = createNonce();
  const b = createNonce();
  assert.equal(a.length, 32);
  assert.match(a, /^[0-9a-f]+$/);
  assert.notEqual(a, b);
  assert.equal(createNonce(4).length, 16, 'floor is 16 characters');
  assert.equal(createNonce(64).length, 64);
});

test('the signing string is six newline-terminated fields in order', () => {
  const text = tokenRequestSigningString({
    keyName: KEY_NAME,
    ttl: 3600000,
    capability: '{"rooms:*":["publish"]}',
    clientId: 'user-1',
    timestamp: 1700000000000,
    nonce: '0123456789abcdef',
  });
  assert.equal(
    text,
    'demoApp.demoKey\n' +
      '3600000\n' +
      '{"rooms:*":["publish"]}\n' +
      'user-1\n' +
      '1700000000000\n' +
      '0123456789abcdef\n',
  );
  assert.equal(text.split('\n').length - 1, 6, 'trailing newline included');
});

test('hmacSha256Base64 agrees with an independently computed HMAC', async () => {
  const message = 'the message to be signed\nwith a newline\n';
  assert.equal(
    await hmacSha256Base64(KEY_SECRET, message),
    referenceMac(KEY_SECRET, message),
  );
});

test('known-answer vector: a fully pinned TokenRequest', async () => {
  const fixed = {
    clientId: 'user-1',
    capability: { 'rooms:*': ['publish', 'subscribe', 'presence'] },
    ttl: 3600000,
    timestamp: 1700000000000,
    nonce: 'aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb',
  };

  const tokenRequest = await createTokenRequest(API_KEY, fixed);

  // Rebuild the signed text by hand from the spec, then MAC it with
  // node:crypto. Nothing from the module under test is reused here.
  const capabilityJson = '{"rooms:*":["publish","subscribe","presence"]}';
  const expectedText =
    `${KEY_NAME}\n` +
    `3600000\n` +
    `${capabilityJson}\n` +
    `user-1\n` +
    `1700000000000\n` +
    `${fixed.nonce}\n`;

  assert.deepEqual(tokenRequest, {
    keyName: KEY_NAME,
    ttl: 3600000,
    capability: capabilityJson,
    clientId: 'user-1',
    timestamp: 1700000000000,
    nonce: fixed.nonce,
    mac: referenceMac(KEY_SECRET, expectedText),
  });

  // The literal value, so a refactor that changes the encoding is caught even
  // if the reference implementation is edited too.
  assert.equal(tokenRequest.mac, 'p5z3ecPlgPoQ32TIlwWqwlc5oGYk/NSVcRYwjTe1oGg=');
});

test('the MAC is sensitive to every signed field', async () => {
  const base = {
    clientId: 'user-1',
    capability: DEFAULT_CAPABILITY,
    ttl: 3600000,
    timestamp: 1700000000000,
    nonce: 'aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb',
  };
  const original = await createTokenRequest(API_KEY, base);

  const variants = [
    { ...base, clientId: 'user-2' },
    { ...base, ttl: 3600001 },
    { ...base, timestamp: 1700000000001 },
    { ...base, nonce: 'bbbbbbbbbbbbbbbbaaaaaaaaaaaaaaaa' },
    { ...base, capability: { 'other:*': ['subscribe'] } },
  ];
  for (const variant of variants) {
    const changed = await createTokenRequest(API_KEY, variant);
    assert.notEqual(changed.mac, original.mac);
  }

  const otherKey = await createTokenRequest('demoApp.demoKey:different', base);
  assert.notEqual(otherKey.mac, original.mac);
});

test('the secret half of the key never appears in the output', async () => {
  const tokenRequest = await createTokenRequest(API_KEY, { clientId: 'user-1' });
  assert.ok(!JSON.stringify(tokenRequest).includes(KEY_SECRET));
  assert.equal(tokenRequest.keyName, KEY_NAME);
});

test('defaults: one-hour ttl, rooms:* capability, anonymous clientId', async () => {
  const before = Date.now();
  const tokenRequest = await createTokenRequest(API_KEY);
  const after = Date.now();

  assert.equal(tokenRequest.ttl, DEFAULT_TTL_MS);
  assert.equal(tokenRequest.capability, JSON.stringify(DEFAULT_CAPABILITY));
  assert.equal(tokenRequest.clientId, '');
  assert.ok(tokenRequest.timestamp >= before && tokenRequest.timestamp <= after);
  assert.ok(tokenRequest.nonce.length >= 16);
});

test('a capability passed as a string is used verbatim', async () => {
  const raw = '{"a:*":["subscribe"]}';
  const tokenRequest = await createTokenRequest(API_KEY, { capability: raw });
  assert.equal(tokenRequest.capability, raw);
});

test('a short nonce is rejected', async () => {
  await assert.rejects(
    () => createTokenRequest(API_KEY, { nonce: 'tooshort' }),
    /at least 16/,
  );
});

test('tokenRequestHandler issues a signed TokenRequest for an authorized caller', async () => {
  const handle = tokenRequestHandler({
    apiKey: () => API_KEY,
    authorize: () => 'user-1',
    capability: { 'rooms:*': ['subscribe'] },
    ttl: 60000,
  });

  const res = await handle(new Request('https://example.test/token'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');

  const body = await res.json();
  assert.equal(body.clientId, 'user-1');
  assert.equal(body.ttl, 60000);
  assert.equal(body.capability, '{"rooms:*":["subscribe"]}');
  assert.equal(
    body.mac,
    referenceMac(
      KEY_SECRET,
      tokenRequestSigningString({
        keyName: body.keyName,
        ttl: body.ttl,
        capability: body.capability,
        clientId: body.clientId,
        timestamp: body.timestamp,
        nonce: body.nonce,
      }),
    ),
  );
});

test('tokenRequestHandler refuses when authorize returns null or false', async () => {
  for (const verdict of [null, false]) {
    const handle = tokenRequestHandler({ apiKey: API_KEY, authorize: () => verdict });
    const res = await handle(new Request('https://example.test/token'));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  }
});

test('tokenRequestHandler reports a missing key without leaking details', async () => {
  const handle = tokenRequestHandler({ apiKey: () => undefined });
  const res = await handle(new Request('https://example.test/token'));
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'api key not configured' });
});

test('tokenRequestHandler never leaks the key when signing throws', async () => {
  const handle = tokenRequestHandler({ apiKey: () => 'malformed-key-no-colon' });
  const res = await handle(new Request('https://example.test/token'));
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.equal(text, JSON.stringify({ error: 'token request failed' }));
  assert.ok(!text.includes('malformed-key-no-colon'));
});
