import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasTurnLogins, turnLogins } from '../worker/turn-login.js';

test('TURN logins: none, fixed, and Metered on demand (reused, refused)', async () => {
  assert.equal(hasTurnLogins({}), false);
  const none = await turnLogins({});
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.servers, []);
  assert.ok(none.body.error);

  const fixedEnv = { TURN_URLS: 'turns:a.test:443?transport=tcp, turn:a.test:80?transport=tcp,', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' };
  assert.equal(hasTurnLogins(fixedEnv), true);
  const fixed = await turnLogins(fixedEnv);
  assert.deepEqual(fixed.body.servers.map((s) => s.url), ['turns:a.test:443?transport=tcp', 'turn:a.test:80?transport=tcp']);
  assert.ok(fixed.body.servers.every((s) => s.username === 'u' && s.credential === 'p'));

  const realFetch = globalThis.fetch;
  const calls = [];
  let refuse = false;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (refuse) return Response.json({ message: 'quota exceeded' }, { status: 402 });
    return Response.json({ username: `user${calls.length}`, password: 'pw' });
  };
  try {
    const env = { METERED_APP: 'sayltest', METERED_SECRET_KEY: 'k e y' };
    assert.equal(hasTurnLogins(env), true);
    const a = await turnLogins(env);
    assert.equal(calls[0].url, 'https://sayltest.metered.live/api/v1/turn/credential?secretKey=k%20e%20y');
    assert.equal(calls[0].body.expiryInSeconds, 7200);
    assert.deepEqual(a.body.servers.map((s) => s.url), ['turns:standard.relay.metered.ca:443?transport=tcp', 'turn:standard.relay.metered.ca:80?transport=tcp']);
    assert.equal(a.body.servers[0].username, 'user1');
    const b = await turnLogins(env);
    assert.equal(calls.length, 1, 'the login is reused');
    assert.equal(b.body.servers[0].username, 'user1');

    refuse = true;
    const other = await turnLogins({ ...env, METERED_APP: 'other' });
    assert.equal(other.status, 503, 'another app does not get the cached login');
    assert.match(other.body.error, /refused \(402: quota exceeded\)/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
