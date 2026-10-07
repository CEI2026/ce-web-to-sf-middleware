'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { JobQueue, SubmissionStore } = require('../lib/instant/queue');
const { freddieSignature, verifyFreddie, signReport, verifyReport } = require('../lib/instant/signing');

const payload = { building: { building_id: 'a1O000000000TEST' } };

test('a waiting poller is handed a job the moment one is queued', async () => {
  const q = new JobQueue();
  const waiting = q.claim(2000);
  const job = q.enqueue('s1', payload);
  const got = await waiting;
  assert.equal(got.job_id, job.job_id); assert.equal(got.submission_id, 's1');
  assert.deepEqual(Object.keys(got).sort(), ['job_id', 'payload', 'received_utc', 'submission_id']);
  q.close();
});

test('queued jobs are claimed in order; an idle poller gets null after the wait', async () => {
  const q = new JobQueue();
  q.enqueue('a', payload); q.enqueue('b', payload);
  assert.equal((await q.claim(50)).submission_id, 'a');
  assert.equal((await q.claim(50)).submission_id, 'b');
  assert.equal(await q.claim(30), null);
  assert.deepEqual(q.stats().waitingPollers, 0);
});

test('a job claimed but never finished goes back in the queue after the claim timeout', async () => {
  let t = 1000;
  const q = new JobQueue({ claimTimeoutMs: 100, now: () => t });
  const job = q.enqueue('s', payload);
  assert.equal((await q.claim(10)).job_id, job.job_id);
  assert.equal(await q.claim(10), null, 'still claimed');
  t += 150;
  assert.equal((await q.claim(10)).job_id, job.job_id, 'handed out again');
});

test('release puts a job back at the front; complete removes it', async () => {
  const q = new JobQueue();
  const a = q.enqueue('a', payload); q.enqueue('b', payload);
  await q.claim(10);
  assert.equal(q.release(a.job_id), true);
  assert.equal((await q.claim(10)).submission_id, 'a');
  assert.equal(q.complete(a.job_id), true);
  assert.equal(q.get(a.job_id), null);
  assert.equal(q.release('nope'), false);
});

test('submission store: waiters are released by a result, or time out', async () => {
  const s = new SubmissionStore();
  const rec = s.create('x', { payload });
  const w = s.waitComplete('x', 2000);
  s.setResult('x', { light: 'green' });
  assert.equal((await w).result.light, 'green');
  s.create('y', { payload });
  assert.equal(await s.waitComplete('y', 20), null);
  assert.equal(await s.waitComplete('nope', 20), null);
  assert.equal((await s.waitComplete('x', 20)).status, 'complete');
  assert.equal(rec.report.state, 'preparing');
});

test('submission store: old records are purged', () => {
  let t = 0;
  const s = new SubmissionStore({ now: () => t, ttlMs: 1000 });
  s.create('old', { payload }); t = 5000; s.create('new', { payload });
  s.purge();
  assert.equal(s.get('old'), null); assert.ok(s.get('new'));
});

const req = (method, url, headers, rawBody) => ({ method, originalUrl: url, rawBody, get: h => headers[h.toLowerCase()] });

test('signature matches an independent HMAC computation (the contract Freddie implements)', () => {
  const ts = 1790000000, body = '{"a":1}';
  const expected = crypto.createHmac('sha256', 'k').update(`${ts}\nPOST\n/instant-audit/jobs/J/result\n${body}`).digest('hex');
  assert.equal(freddieSignature('k', ts, 'post', '/instant-audit/jobs/J/result', body), expected);
});

test('verifyFreddie: query string is not signed; body is; five-minute window', () => {
  const now = 1790000000 * 1000, ts = 1790000000;
  const sig = freddieSignature('k', ts, 'GET', '/instant-audit/jobs/next', '');
  const ok = req('GET', '/instant-audit/jobs/next?wait=25', { 'x-ce-timestamp': String(ts), 'x-ce-signature': sig });
  assert.equal(verifyFreddie(ok, 'k', now).ok, true);
  assert.equal(verifyFreddie(ok, 'other', now).reason, 'bad_signature');
  assert.equal(verifyFreddie(ok, 'k', now + 301000).reason, 'stale');
  assert.equal(verifyFreddie(ok, 'k', now - 301000).reason, 'stale');
  assert.equal(verifyFreddie(ok, '', now).reason, 'not_configured');
  assert.equal(verifyFreddie(req('GET', '/x', {}), 'k', now).reason, 'missing');
  const withBody = req('POST', '/p', { 'x-ce-timestamp': String(ts), 'x-ce-signature': freddieSignature('k', ts, 'POST', '/p', 'abc') }, Buffer.from('abc'));
  assert.equal(verifyFreddie(withBody, 'k', now).ok, true);
  withBody.rawBody = Buffer.from('abd');
  assert.equal(verifyFreddie(withBody, 'k', now).ok, false);
});

test('report tokens: valid, wrong submission, expired, garbage', () => {
  const now = Date.now(), exp = Math.floor(now / 1000) + 60;
  const t = signReport('k', 'id1', exp);
  assert.equal(verifyReport('k', 'id1', t, now).ok, true);
  assert.equal(verifyReport('k', 'id2', t, now).ok, false);
  assert.equal(verifyReport('k', 'id1', t, now + 120000).reason, 'expired');
  assert.equal(verifyReport('k', 'id1', 'garbage', now).ok, false);
  assert.equal(verifyReport('k', 'id1', '', now).ok, false);
  assert.equal(verifyReport('other', 'id1', t, now).ok, false);
});
