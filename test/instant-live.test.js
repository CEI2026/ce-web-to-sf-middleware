'use strict';
// Instant Audit with the real Freddie relay, acting as Freddie: signed polling, results,
// reports, Salesforce writes, the queued path, and the failure paths.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fx, fakeSf, start, post, get, signed, PDF_B64, sleep } = require('./helpers');
const { signReport } = require('../lib/instant/signing');

const SECRET = 's3cret-for-tests';
const LIVE = { FREDDIE_JOB_SECRET: SECRET, INSTANT_AUDIT_SF_WRITE: 'true', INSTANT_AUDIT_WAIT_MS: '3000' };
const SID = '11111111-1111-4111-8111-111111111111';
const greenResult = () => fx('response_complete_green.json').result;

// One Freddie work cycle: fetch a job, return the result, then the report.
async function freddieCycle(s, { result = greenResult(), report = true, wait = 2 } = {}) {
  const j = await signed(s.base, SECRET, 'GET', `/instant-audit/jobs/next?wait=${wait}`);
  if (j.status === 204) return null;
  const job = j.body;
  const r = await signed(s.base, SECRET, 'POST', `/instant-audit/jobs/${job.job_id}/result`, { submission_id: job.submission_id, result });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (report) {
    const p = await signed(s.base, SECRET, 'POST', `/instant-audit/jobs/${job.job_id}/report`, { submission_id: job.submission_id, filename: 'Instant Audit - Chancery.pdf', pdf_base64: PDF_B64 });
    assert.equal(p.status, 200, JSON.stringify(p.body));
  }
  return job;
}

test('full flow: saved first, Freddie fetches the job, the browser gets the result, report follows', async () => {
  const s = await start(LIVE);
  try {
    const freddie = freddieCycle(s);
    const r = await post(s.base, '/instant-audit', fx('submission_chancery_12_months.json'));
    const job = await freddie;
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'complete');
    assert.equal(r.body.result.annual_spend, 38359);
    assert.equal(job.payload.accounts.length, 2, 'Freddie received the validated submission');
    assert.equal(job.payload.facts.sqft_total, 15848);

    // Salesforce: contact, 24 monthly records, then the building patch
    const many = s.sf.of('sfCreateMany');
    assert.equal(many.length, 1);
    const [, , object, records] = many[0].args;
    assert.equal(object, 'Utility_Month__c');
    assert.equal(records.length, 24);
    const first = records.find(x => x.Fuel__c === 'Electric' && x.Period_Month__c === '2025-06-01');
    assert.equal(first.Usage__c, 18660); assert.equal(first.Usage_Unit__c, 'kWh'); assert.equal(first.Cost__c, 3420.5);
    assert.equal(first.Source__c, 'Client entered'); assert.equal(first.Submission_Id__c, SID);
    assert.equal(first.Building__c, 'a1O000000000TEST');
    assert.ok(records.some(x => x.Fuel__c === 'Natural gas' && x.Usage_Unit__c === 'therms'));
    await sleep(80);
    const patches = s.sf.of('sfPatch').map(c => c.args[4]);
    const pending = patches.find(p => p.Screening_Status__c === 'Instant audit pending');
    assert.equal(pending.Client_SQFT__c, 15848);
    assert.equal(pending.Client_Building_Type__c, 'Office or chancery');
    assert.equal(pending.Client_Heating_Fuel__c, 'gas');
    assert.equal(pending.Client_Electric_Spend__c, 31959.4);
    assert.equal(pending.Client_Gas_Spend__c, 6399.3);
    assert.equal(pending.Building_Contact__c, '003CONTACT');
    const done = patches.find(p => p.Screening_Status__c === 'Instant audit completed');
    assert.equal(done.Screening_Light__c, 'Green'); assert.equal(done.Screening_Annual_Spend__c, 38359);
    assert.equal(done.Screening_Basis__c, 'Client entered figures'); assert.equal(done.Screening_Assumptions_Version__c, 'ceos-2026-10-r5');
    const up = s.sf.of('uploadOneFileToSF')[0].args;
    assert.equal(up[2], 'a1O000000000TEST'); assert.equal(up[3].name, 'Instant Audit - Chancery.pdf');
    assert.equal(Buffer.from(up[3].data, 'base64').slice(0, 4).toString(), '%PDF');

    // the report is now ready for the browser
    const st = (await get(s.base, `/instant-audit/${SID}`)).body;
    assert.equal(st.report.state, 'ready');
    const pdf = await fetch(st.report.url);
    assert.equal(pdf.status, 200); assert.equal((await pdf.text()).slice(0, 4), '%PDF');
    assert.ok((await get(s.base, '/')).body.instantAudit.freddie.lastPollSecondsAgo >= 0);
  } finally { s.close(); }
});

test('Freddie not available: the browser is told "queued"; the result still arrives later', async () => {
  const s = await start({ ...LIVE, INSTANT_AUDIT_WAIT_MS: '250' });
  try {
    const r = await post(s.base, '/instant-audit', fx('submission_chancery_12_months.json'));
    assert.equal(r.status, 200); assert.equal(r.body.status, 'queued'); assert.equal(r.body.result, null);
    assert.equal((await get(s.base, `/instant-audit/${SID}`)).body.status, 'queued');
    assert.equal(s.sf.of('sfCreateMany').length, 1, 'saved to Salesforce before queuing');

    await freddieCycle(s);                      // Freddie comes back
    const later = (await get(s.base, `/instant-audit/${SID}`)).body;
    assert.equal(later.status, 'complete'); assert.equal(later.result.light, 'green');
    await sleep(80);
    assert.ok(s.sf.of('sfPatch').some(c => c.args[4].Screening_Status__c === 'Instant audit completed'), 'result written after the browser stopped waiting');
  } finally { s.close(); }
});

test('only signed requests reach Freddie endpoints', async () => {
  const s = await start(LIVE);
  try {
    const p = '/instant-audit/jobs/next?wait=0';
    const old = Math.floor(Date.now() / 1000) - 601;
    assert.equal((await signed(s.base, SECRET, 'GET', p, undefined, { omit: ['x-ce-signature'] })).status, 401);
    assert.equal((await signed(s.base, SECRET, 'GET', p, undefined, { omit: ['x-ce-timestamp'] })).status, 401);
    assert.equal((await signed(s.base, SECRET, 'GET', p, undefined, { badSig: true })).status, 401);
    assert.equal((await signed(s.base, 'wrong-secret', 'GET', p)).status, 401);
    assert.equal((await signed(s.base, SECRET, 'GET', p, undefined, { ts: old })).status, 401, 'older than 5 minutes');
    assert.equal((await get(s.base, p)).status, 401, 'no headers at all');
    assert.equal((await signed(s.base, SECRET, 'GET', p)).status, 204, 'a correct request is accepted');
    // a signature for one body cannot be reused for another
    const body = { submission_id: SID, result: greenResult() };
    const ts = Math.floor(Date.now() / 1000);
    const { freddieSignature } = require('../lib/instant/signing');
    const sig = freddieSignature(SECRET, ts, 'POST', '/instant-audit/jobs/x/result', JSON.stringify(body));
    const tampered = await fetch(s.base + '/instant-audit/jobs/x/result', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ce-timestamp': String(ts), 'x-ce-signature': sig }, body: JSON.stringify({ ...body, extra: 1 }) });
    assert.equal(tampered.status, 401);
  } finally { s.close(); }
});

test('no secret configured: every Freddie request is refused', async () => {
  const s = await start({ INSTANT_AUDIT_SF_WRITE: 'true' });
  try { assert.equal((await signed(s.base, '', 'GET', '/instant-audit/jobs/next?wait=0')).status, 401); } finally { s.close(); }
});

test('a result posted twice is stored once; a malformed result is refused', async () => {
  const s = await start({ ...LIVE, INSTANT_AUDIT_WAIT_MS: '200' });
  try {
    await post(s.base, '/instant-audit', fx('submission_chancery_12_months.json'));
    const j = (await signed(s.base, SECRET, 'GET', '/instant-audit/jobs/next?wait=1')).body;
    const path = `/instant-audit/jobs/${j.job_id}/result`;
    const bad = await signed(s.base, SECRET, 'POST', path, { submission_id: SID, result: { light: 'purple' } });
    assert.equal(bad.status, 400);
    const a = await signed(s.base, SECRET, 'POST', path, { submission_id: SID, result: greenResult() });
    const b = await signed(s.base, SECRET, 'POST', path, { submission_id: SID, result: { ...greenResult(), annual_spend: 1 } });
    assert.equal(a.status, 200); assert.equal(b.body.duplicate, true);
    assert.equal((await get(s.base, `/instant-audit/${SID}`)).body.result.annual_spend, 38359, 'the first result stands');
    assert.equal((await signed(s.base, SECRET, 'POST', path, { submission_id: '99999999-9999-4999-8999-999999999999', result: greenResult() })).status, 404);
  } finally { s.close(); }
});

test('Freddie reports a failure: the job goes back in the queue', async () => {
  const s = await start({ ...LIVE, INSTANT_AUDIT_WAIT_MS: '200' });
  try {
    await post(s.base, '/instant-audit', fx('submission_chancery_12_months.json'));
    const j1 = (await signed(s.base, SECRET, 'GET', '/instant-audit/jobs/next?wait=1')).body;
    const r = await signed(s.base, SECRET, 'POST', `/instant-audit/jobs/${j1.job_id}/result`, { submission_id: SID, error: 'model out of memory' });
    assert.equal(r.body.requeued, true);
    const j2 = (await signed(s.base, SECRET, 'GET', '/instant-audit/jobs/next?wait=1')).body;
    assert.equal(j2.job_id, j1.job_id);
  } finally { s.close(); }
});

test('if Salesforce cannot save, the client is told nothing was saved, and a retry works', async () => {
  let failing = true;
  const sf = fakeSf({ sfCreateMany: async () => { if (failing) throw new Error('INVALID_FIELD Utility_Month__c'); return []; } });
  const s = await start({ ...LIVE, INSTANT_AUDIT_WAIT_MS: '150' }, { sf });
  try {
    const r = await post(s.base, '/instant-audit', fx('submission_chancery_12_months.json'));
    assert.equal(r.status, 500); assert.match(r.body.error, /weren't saved/);
    assert.equal(s.queue.stats().queued, 0, 'nothing queued');
    assert.equal(s.sf.of('sfPatch').length, 0, 'the building was never marked pending');
    failing = false;
    const retry = await post(s.base, '/instant-audit', fx('submission_chancery_12_months.json'));
    assert.equal(retry.status, 200); assert.equal(retry.body.status, 'queued');
  } finally { s.close(); }
});

test('dry run (Salesforce writes off): the flow works and nothing is sent to Salesforce', async () => {
  const s = await start({ FREDDIE_JOB_SECRET: SECRET, INSTANT_AUDIT_WAIT_MS: '3000' });
  try {
    const freddie = freddieCycle(s);
    const r = await post(s.base, '/instant-audit', fx('submission_chancery_12_months.json'));
    await freddie; await sleep(80);
    assert.equal(r.body.status, 'complete');
    assert.equal(s.sf.calls.length, 0);
    assert.ok(s.logs.some(l => l.includes('[dry-run] would save')));
  } finally { s.close(); }
});

test('report links: preparing, tampered, expired, and bad uploads', async () => {
  const s = await start({ ...LIVE, INSTANT_AUDIT_WAIT_MS: '3000' });
  try {
    const freddie = freddieCycle(s, { report: false });
    await post(s.base, '/instant-audit', fx('submission_chancery_12_months.json'));
    const job = await freddie;
    const future = Math.floor(Date.now() / 1000) + 3600;
    const good = signReport(s.cfg.reportSecret, SID, future);
    const url = `/instant-audit/${SID}/report?t=`;
    assert.equal((await get(s.base, url + good)).status, 202, 'no report yet');
    assert.equal((await get(s.base, `/instant-audit/${SID}`)).body.report.state, 'preparing');
    assert.equal((await get(s.base, url + good.replace(/.$/, c => (c === 'a' ? 'b' : 'a')))).status, 403, 'tampered');
    assert.equal((await get(s.base, url + signReport(s.cfg.reportSecret, SID, Math.floor(Date.now() / 1000) - 10))).status, 410, 'expired');
    assert.equal((await get(s.base, url)).status, 403, 'no token');
    const notPdf = await signed(s.base, SECRET, 'POST', `/instant-audit/jobs/${job.job_id}/report`, { submission_id: SID, filename: 'x.pdf', pdf_base64: Buffer.from('hello').toString('base64') });
    assert.equal(notPdf.status, 400);
    assert.equal((await get(s.base, '/instant-audit/22222222-2222-4222-8222-222222222222')).status, 404);
  } finally { s.close(); }
});

test('if Freddie never sends a report, the browser is told it is unavailable after the grace period', async () => {
  const s = await start({ ...LIVE, INSTANT_AUDIT_WAIT_MS: '3000', INSTANT_AUDIT_REPORT_GRACE_MS: '150' });
  try {
    const freddie = freddieCycle(s, { report: false });
    await post(s.base, '/instant-audit', fx('submission_chancery_12_months.json'));
    await freddie; await sleep(250);
    assert.equal((await get(s.base, `/instant-audit/${SID}`)).body.report.state, 'unavailable');
  } finally { s.close(); }
});
