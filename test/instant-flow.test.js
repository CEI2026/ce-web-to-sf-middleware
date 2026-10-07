'use strict';
// Instant Audit in mock mode (form development), the abuse guards, and the Procurement stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fx, start, post, get } = require('./helpers');

const MOCK = { INSTANT_AUDIT_MOCK: 'true' };
const uuid = n => `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;

test('mock mode: the 12-month sample returns the canned green answer with a working report link', async () => {
  const s = await start(MOCK);
  try {
    const r = await post(s.base, '/instant-audit', fx('submission_chancery_12_months.json'));
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'complete');
    assert.equal(r.body.result.light, 'green');
    assert.equal(r.body.result.annual_spend, 38359);
    assert.equal(r.body.submission_id, '11111111-1111-4111-8111-111111111111');
    assert.equal(r.body.report.state, 'ready');
    const pdf = await fetch(r.body.report.url);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.match(pdf.headers.get('content-disposition'), /attachment/);
    assert.equal((await pdf.text()).slice(0, 4), '%PDF');
    const again = await get(s.base, '/instant-audit/11111111-1111-4111-8111-111111111111');
    assert.equal(again.body.status, 'complete');
  } finally { s.close(); }
});

test('mock mode picks by the entered total cost: green, yellow, red', async () => {
  const s = await start(MOCK);
  try {
    const half = fx('submission_chancery_12_months.json'); half.submission_id = uuid(2);
    half.accounts.forEach(a => a.rows.forEach(x => { x.cost = Math.round(x.cost / 2 * 100) / 100; }));   // about $19,000
    assert.equal((await post(s.base, '/instant-audit', half)).body.result.light, 'yellow');
    const small = await post(s.base, '/instant-audit', fx('submission_small_parish.json'));
    assert.equal(small.body.result.light, 'red');
    assert.equal(small.body.report.state, 'unavailable');
    assert.equal(small.body.report.url, null);
  } finally { s.close(); }
});

test('submitting the same submission id twice gives the same answer and one record', async () => {
  const s = await start(MOCK);
  try {
    const a = await post(s.base, '/instant-audit', fx('submission_chancery_12_months.json'));
    const b = await post(s.base, '/instant-audit', fx('submission_chancery_12_months.json'));
    assert.equal(b.status, 200);
    assert.equal(b.body.result.annual_spend, a.body.result.annual_spend);
    assert.equal(s.store.map.size, 1);
  } finally { s.close(); }
});

test('mock mode: ?force=queued and ?force=error', async () => {
  const s = await start(MOCK);
  try {
    const q = await post(s.base, '/instant-audit?force=queued', fx('submission_chancery_12_months.json'));
    assert.equal(q.status, 200); assert.equal(q.body.status, 'queued'); assert.equal(q.body.result, null);
    assert.equal(q.body.message, fx('response_queued.json').message);
    const e = await post(s.base, '/instant-audit?force=error', { ...fx('submission_small_parish.json'), submission_id: uuid(3) });
    assert.equal(e.status, 500); assert.equal(e.body.ok, false);
  } finally { s.close(); }
});

test('bad input: 400 with errors by field; the bot field; bad JSON; too large', async () => {
  const s = await start(MOCK);
  try {
    const p = fx('submission_chancery_12_months.json'); p.contact.email = 'nope';
    const r = await post(s.base, '/instant-audit', p);
    assert.equal(r.status, 400); assert.equal(r.body.ok, false);
    assert.ok(r.body.errors.some(e => e.field === 'contact.email'));
    const bot = fx('submission_chancery_12_months.json'); bot.website = 'x';
    assert.equal((await post(s.base, '/instant-audit', bot)).status, 400);
    const bad = await post(s.base, '/instant-audit', '{not json');
    assert.equal(bad.status, 400); assert.equal(bad.body.ok, false);
    const big = fx('submission_chancery_12_months.json'); big.facts.shared_meter_note = 'x'.repeat(40000);
    assert.equal((await post(s.base, '/instant-audit', big)).status, 413);
    assert.equal(s.store.map.size, 0, 'nothing is stored for refused requests');
  } finally { s.close(); }
});

test('rate limit per connection returns 429', async () => {
  const s = await start({ ...MOCK, INSTANT_AUDIT_RATE_PER_HOUR: '3' });
  try {
    const out = [];
    for (let i = 0; i < 5; i++) out.push((await post(s.base, '/instant-audit', { ...fx('submission_small_parish.json'), submission_id: uuid(10 + i) })).status);
    assert.deepEqual(out, [200, 200, 200, 429, 429]);
  } finally { s.close(); }
});

test('rate limit per building per day returns 429', async () => {
  const s = await start({ ...MOCK, INSTANT_AUDIT_RATE_PER_BUILDING_DAY: '2' });
  try {
    const out = [];
    for (let i = 0; i < 3; i++) out.push((await post(s.base, '/instant-audit', { ...fx('submission_small_parish.json'), submission_id: uuid(20 + i) })).status);
    assert.deepEqual(out, [200, 200, 429]);
  } finally { s.close(); }
});

test('allowed origins: a website not on the list is refused; one on the list works', async () => {
  const s = await start({ ...MOCK, INSTANT_AUDIT_ALLOWED_ORIGINS: 'https://forms.example.org' });
  try {
    const bad = await post(s.base, '/instant-audit', fx('submission_small_parish.json'), { origin: 'https://evil.example' });
    assert.equal(bad.status, 403);
    const ok = await post(s.base, '/instant-audit', fx('submission_small_parish.json'), { origin: 'https://forms.example.org' });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://forms.example.org');
    const noOrigin = await post(s.base, '/instant-audit', { ...fx('submission_small_parish.json'), submission_id: uuid(30) });
    assert.equal(noOrigin.status, 200);
  } finally { s.close(); }
});

test('Procurement is a stub: not available, nothing saved', async () => {
  const s = await start();
  try {
    const g = await get(s.base, '/procurement');
    assert.equal(g.status, 200); assert.equal(g.body.available, false); assert.equal(g.body.status, 'coming_soon');
    const p = await post(s.base, '/procurement-request', { anything: true });
    assert.equal(p.status, 501); assert.equal(p.body.status, 'coming_soon');
    assert.equal(s.sf.calls.length, 0, 'no Salesforce calls');
  } finally { s.close(); }
});

test('health check reports version, Instant Audit mode and Freddie contact', async () => {
  const s = await start(MOCK);
  try {
    const h = (await get(s.base, '/')).body;
    assert.equal(h.status, 'ok'); assert.equal(h.version, '8.1.0');
    assert.equal(h.instantAudit.mode, 'mock'); assert.equal(h.instantAudit.salesforceWrites, false);
    assert.equal(h.instantAudit.freddie.lastPollSecondsAgo, null);
    assert.equal(h.procurement, 'stub');
  } finally { s.close(); }
});

test('the ported endpoints are mounted (their behavior is proven by the side-by-side comparison)', async () => {
  const s = await start();
  try {
    assert.equal((await get(s.base, '/accounts?zip=abc')).status, 400);
    assert.equal((await get(s.base, '/buildings')).status, 400);
    assert.equal((await post(s.base, '/screening-complete', { building_id: 'x', submission_id: 'x', token: 'nope', failed: [] })).status, 403);
  } finally { s.close(); }
});
