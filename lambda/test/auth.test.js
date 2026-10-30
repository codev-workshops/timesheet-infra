process.env.DB_MODE = 'sqlite';
process.env.JWT_SECRET = 'test-secret';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../lambda');

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const post = (path, body) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

const email = 'alice@acme.com';
const password = 'correct horse battery';

test('login with only an email is rejected', async () => {
  const res = await post('/api/auth/login', { email });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).token, undefined);
});

test('login does not auto-create unknown accounts', async () => {
  const res = await post('/api/auth/login', { email: 'nobody@acme.com', password });
  assert.equal(res.status, 401);
  const retry = await post('/api/auth/register', { email: 'nobody@acme.com', password });
  assert.equal(retry.status, 201);
});

test('register rejects short passwords', async () => {
  const res = await post('/api/auth/register', { email: 'short@acme.com', password: 'short' });
  assert.equal(res.status, 400);
});

test('register then login with the correct password issues a token', async () => {
  const reg = await post('/api/auth/register', { email, password });
  assert.equal(reg.status, 201);
  const regBody = await reg.json();
  assert.equal(regBody.token, undefined);
  assert.equal(regBody.user.password_hash, undefined);

  const res = await post('/api/auth/login', { email, password });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.token);
  assert.equal(body.user.password_hash, undefined);

  const me = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${body.token}` }
  });
  assert.equal(me.status, 200);
  const meBody = await me.json();
  assert.equal(meBody.email, email);
  assert.equal(meBody.password_hash, undefined);
});

test('login with a wrong password is rejected', async () => {
  const res = await post('/api/auth/login', { email, password: 'wrong password here' });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).token, undefined);
});

test('registering an existing email cannot take over the account', async () => {
  const res = await post('/api/auth/register', { email, password: 'attacker password 123' });
  assert.equal(res.status, 409);
  const login = await post('/api/auth/login', { email, password: 'attacker password 123' });
  assert.equal(login.status, 401);
});
