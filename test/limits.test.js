'use strict';
// 8.1.0: per-connection rate limits on the ported public endpoints.
const test = require('node:test');
const assert = require('node:assert');
const { start, post, get } = require('./helpers');

const small = { LOOKUP_RATE_PER_HOUR: '3', SUBMIT_RATE_PER_HOUR: '2', FILE_RATE_PER_HOUR: '4', REGISTER_RATE_PER_HOUR: '1' };

test('defaults are generous for people and set from the environment', async () => {
  const t = await start();
  try {
    assert.deepStrictEqual(t.app.locals.limits, { lookupPerHour: 120, submitPerHour: 20, filePerHour: 300, registerPerHour: 5 });
  } finally { t.close(); }
  const t2 = await start({ LOOKUP_RATE_PER_HOUR: '7', SUBMIT_RATE_PER_HOUR: 'junk', FILE_RATE_PER_HOUR: '0' });
  try {
    assert.strictEqual(t2.app.locals.limits.lookupPerHour, 7);
    assert.strictEqual(t2.app.locals.limits.submitPerHour, 20, 'a bad value falls back to the default');
    assert.strictEqual(t2.app.locals.limits.filePerHour, 0);
  } finally { t2.close(); }
});

test('a flood of submits is refused with a readable 429, others are not affected', async () => {
  const t = await start(small);
  try {
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(t.base, '/submit', {})).status);
    assert.ok(statuses.slice(0, 2).every(s => s !== 429), 'the first two are let through: ' + statuses);
    assert.deepStrictEqual(statuses.slice(2), [429, 429]);
    const r = await post(t.base, '/submit', {});
    assert.strictEqual(r.status, 429);
    assert.strictEqual(r.body.success, false);
    assert.strictEqual(r.body.ok, false);
    assert.match(r.body.error, /Too many requests/);
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*', 'the browser must be able to read the refusal');
    assert.ok(r.headers.get('ratelimit') || r.headers.get('retry-after'), 'standard rate-limit headers are sent');
    // each endpoint has its own counter
    assert.notStrictEqual((await post(t.base, '/screening-request', {})).status, 429);
    assert.notStrictEqual((await post(t.base, '/screening-complete', {})).status, 429);
  } finally { t.close(); }
});

test('lookups are limited per endpoint and read-only calls to / are never limited', async () => {
  const t = await start(small);
  try {
    const a = []; for (let i = 0; i < 4; i++) a.push((await get(t.base, '/accounts?zip=37902')).status);
    assert.deepStrictEqual(a.map(s => s === 429), [false, false, false, true]);
    assert.notStrictEqual((await get(t.base, '/buildings?accountId=001Jx00001tqn9JIAQ')).status, 429, 'separate counter');
    for (let i = 0; i < 10; i++) assert.strictEqual((await get(t.base, '/')).status, 200);
  } finally { t.close(); }
});

test('bill uploads and registration have their own limits', async () => {
  const t = await start(small);
  try {
    const f = []; for (let i = 0; i < 5; i++) f.push((await post(t.base, '/screening-file', {})).status === 429);
    assert.deepStrictEqual(f, [false, false, false, false, true]);
    const r = []; for (let i = 0; i < 2; i++) r.push((await post(t.base, '/accounts', {})).status === 429);
    assert.deepStrictEqual(r, [false, true]);
  } finally { t.close(); }
});

test('CORS preflight (OPTIONS) is never counted', async () => {
  const t = await start({ SUBMIT_RATE_PER_HOUR: '1' });
  try {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(t.base + '/submit', { method: 'OPTIONS', headers: { origin: 'https://ce-resource-center.netlify.app', 'access-control-request-method': 'POST' } });
      assert.ok(r.status < 300, 'preflight ' + i + ' gave ' + r.status);
    }
    assert.notStrictEqual((await post(t.base, '/submit', {})).status, 429, 'the one allowed submit still works after five preflights');
  } finally { t.close(); }
});

test('a limit of 0 turns that limit off', async () => {
  const t = await start({ SUBMIT_RATE_PER_HOUR: '0' });
  try {
    for (let i = 0; i < 8; i++) assert.notStrictEqual((await post(t.base, '/submit', {})).status, 429);
  } finally { t.close(); }
});

test('the limit is applied before a large body is read', async () => {
  const t = await start({ SUBMIT_RATE_PER_HOUR: '1' });
  try {
    await post(t.base, '/submit', {});
    const big = JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) });
    const r = await post(t.base, '/submit', big);
    assert.strictEqual(r.status, 429);
  } finally { t.close(); }
});

test('Instant Audit keeps its own limits and is not touched by these', async () => {
  const t = await start({ SUBMIT_RATE_PER_HOUR: '1', LOOKUP_RATE_PER_HOUR: '1' });
  try {
    for (let i = 0; i < 3; i++) assert.notStrictEqual((await post(t.base, '/instant-audit', {})).status, 429, 'an invalid body is a 400, not a rate-limit refusal');
  } finally { t.close(); }
});
