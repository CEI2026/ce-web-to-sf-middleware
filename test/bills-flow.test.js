'use strict';
// 8.2.0 (CR-S4): bill sets - verification, reuse, new uploads, Solar-only, Instant Audit status split.
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server');
const { fakeSf, post } = require('./helpers');

const ACCT = '001Jx00001tqn9JIAQ', BLD = 'a1OJx000001UtZAMA0', OTHER = 'a1OJx000001UtZBMA0', BU1 = 'a2BJx000000000001', BU2 = 'a2BJx000000000002';
const contact = { first_name: 'Fred', last_name: 'F', email: 'uploader@parish.org', role: 'Business manager' };
const NOW = Date.parse('2026-10-15T12:00:00Z');

function world({ contactEmail = 'office@parish.org', uploads, mailFails = false } = {}) {
  const ups = uploads || [
    { Id: BU1, Name: 'BU-000001', Submission_ID__c: 'ES-20260601-AAAAAA', Uploader_Email__c: 'uploader@parish.org',
      Uploaded_At__c: '2026-06-01T10:00:00Z', Bill_Count__c: 3, Bill_Filenames__c: 'jan.pdf\nfeb.pdf\nmar.pdf', Purpose__c: 'Desk Audit',
      Reuse_Expires_On__c: '2027-07-01', Reuse_Count__c: 0, Status__c: 'Complete' },
    { Id: BU2, Name: 'BU-000002', Submission_ID__c: 'ES-20250101-BBBBBB', Uploader_Email__c: 'uploader@parish.org',
      Uploaded_At__c: '2025-01-01T10:00:00Z', Bill_Count__c: 2, Bill_Filenames__c: 'old.pdf', Purpose__c: 'Desk Audit',
      Reuse_Expires_On__c: '2026-02-01', Reuse_Count__c: 0, Status__c: 'Complete' },       // expired
  ];
  const state = { patches: [], posts: [], links: [], mails: [], docs: [] };
  const sf = fakeSf({
    sfQuery: async (i, t, soql) => {
      if (/FROM Bill_Upload__c WHERE Building__c/.test(soql)) return soql.includes(`'${BLD}'`) ? ups : [];
      if (/FROM Buildings__c WHERE Id/.test(soql)) return [{ Id: BLD, Name: 'St Mary Church', Building_Contact__r: contactEmail ? { Email: contactEmail } : null }];
      if (/FROM Bill_Upload__c WHERE Submission_ID__c/.test(soql)) return state.created ? [{ Id: state.created }] : [];
      if (/FROM ContentDocumentLink/.test(soql)) return state.docs.map(d => ({ ContentDocumentId: d.id }));
      if (/FROM ContentVersion/.test(soql)) return state.docs.map(d => ({ Title: d.name }));
      return [];
    },
    sfPost: async (i, t, obj, data) => { state.posts.push({ obj, data }); if (obj === 'Bill_Upload__c') state.created = 'a2BJx000000000099'; return { id: state.created || 'NEW1' }; },
    sfPatch: async (i, t, obj, id, data) => { state.patches.push({ obj, id, data }); return { success: true }; },
    uploadOneFileToSF: async (i, t, b, f, extra) => { state.links.push({ b, name: f.name, extra }); state.docs.push({ id: '069Jx0000000000' + String(state.docs.length).padStart(3, '0'), name: f.name }); },
  });
  const mailer = { configured: true, send: async m => { if (mailFails) throw new Error('smtp down'); state.mails.push(m); } };
  return { sf, state, mailer };
}

async function boot(env = {}, w = world()) {
  const app = createApp({ env: { BILL_SETS_ENABLED: 'true', BILLS_SESSION_SECRET: 'sess-secret', SCREENING_UPLOAD_SECRET: 'up-secret',
      INSTANT_AUDIT_RATE_PER_HOUR: '1000', INSTANT_AUDIT_RATE_PER_BUILDING_DAY: '1000', ...env },
    sf: w.sf, mailer: w.mailer, log: () => {}, now: () => NOW });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  return { ...w, app, base: `http://127.0.0.1:${server.address().port}`, close: () => { app.locals.queue.close(); server.close(); } };
}
const codeFrom = m => /code is (\d{6})/.exec(m.text)[1];

async function verified(t, optionIdx = 0) {
  const o = await post(t.base, '/bills/options', { building_id: BLD });
  const s = await post(t.base, '/bills/send-code', { building_id: BLD, option: o.body.options[optionIdx].id });
  const v = await post(t.base, '/bills/verify', { challenge: s.body.challenge, code: codeFrom(t.state.mails.at(-1)) });
  return v.body;
}
const reqBody = (extra = {}, b = {}) => ({ sf_account_id: ACCT, contact,
  buildings: [{ sf_building_id: BLD, building_name: 'St Mary', client_sqft: 18000, ...b }], ...extra });

test('flag off: bills endpoints say disabled, reuse is refused, request behaves as 8.1.3', async () => {
  const t = await boot({ BILL_SETS_ENABLED: 'false' });
  try {
    assert.deepStrictEqual((await post(t.base, '/bills/options', { building_id: BLD })).body, { success: true, enabled: false, options: [] });
    assert.strictEqual((await post(t.base, '/bills/send-code', { building_id: BLD, option: 'x' })).status, 404);
    const r = await post(t.base, '/screening-request', reqBody({ reuse: { session: 'x', bill_upload_id: BU1 } }));
    assert.strictEqual(r.status, 503);
    const ok = await post(t.base, '/screening-request', reqBody({ want: { desk: false, solar: true } }, { client_electric_spend: 5000 }));
    assert.strictEqual(ok.status, 200);
    const p = t.state.patches.at(-1).data;
    assert.strictEqual(p.Screening_Status__c, 'Requested', 'a flag-off request is always a Desk Audit');
    assert.ok(!('Screening_Bill_Upload__c' in p));
    assert.ok(!t.state.posts.some(x => x.obj === 'Bill_Upload__c'));
  } finally { t.close(); }
});

test('options: masked, one entry when the contact is also the uploader, two when they differ, none without bills', async () => {
  let t = await boot();
  try {
    const o = await post(t.base, '/bills/options', { building_id: BLD });
    assert.strictEqual(o.body.options.length, 2);
    assert.deepStrictEqual(o.body.options.map(x => x.masked), ['o***@parish.org', 'u***@parish.org']);
    assert.ok(!JSON.stringify(o.body).includes('office@parish.org'), 'the full address is never returned');
    assert.ok(!JSON.stringify(o.body).includes('jan.pdf'), 'no file names before verification');
    assert.deepStrictEqual((await post(t.base, '/bills/options', { building_id: OTHER })).body.options, []);
  } finally { t.close(); }
  t = await boot({}, world({ contactEmail: 'Uploader@Parish.org' }));
  try {
    const o = await post(t.base, '/bills/options', { building_id: BLD });
    assert.strictEqual(o.body.options.length, 1);
    assert.match(o.body.options[0].label, /Contact on record, and the person who uploaded/);
  } finally { t.close(); }
});

test('options: only expired bills means nothing to offer', async () => {
  const t = await boot({}, world({ uploads: [{ Id: BU2, Uploader_Email__c: 'a@b.org', Bill_Count__c: 2, Reuse_Expires_On__c: '2026-10-14', Status__c: 'Complete' }] }));
  try { assert.deepStrictEqual((await post(t.base, '/bills/options', { building_id: BLD })).body.options, []); } finally { t.close(); }
});

test('send-code goes only to a listed address; a made-up option is refused', async () => {
  const t = await boot();
  try {
    assert.strictEqual((await post(t.base, '/bills/send-code', { building_id: BLD, option: 'deadbeef0000' })).status, 400);
    assert.strictEqual(t.state.mails.length, 0);
    const o = await post(t.base, '/bills/options', { building_id: BLD });
    const s = await post(t.base, '/bills/send-code', { building_id: BLD, option: o.body.options[0].id });
    assert.strictEqual(s.status, 200);
    assert.strictEqual(t.state.mails[0].to, 'office@parish.org');
    assert.match(t.state.mails[0].text, /\d{6}/);
    assert.ok(!JSON.stringify(s.body).includes('office@parish.org'));
  } finally { t.close(); }
});

test('send-code: mail failure is reported, not hidden; fourth code in 15 minutes is refused', async () => {
  let t = await boot({}, world({ mailFails: true }));
  try {
    const o = await post(t.base, '/bills/options', { building_id: BLD });
    assert.strictEqual((await post(t.base, '/bills/send-code', { building_id: BLD, option: o.body.options[0].id })).status, 502);
  } finally { t.close(); }
  t = await boot();
  try {
    const o = await post(t.base, '/bills/options', { building_id: BLD });
    const st = [];
    for (let i = 0; i < 4; i++) st.push((await post(t.base, '/bills/send-code', { building_id: BLD, option: o.body.options[0].id })).status);
    assert.deepStrictEqual(st, [200, 200, 200, 429]);
  } finally { t.close(); }
});

test('verify: wrong code counts down, fifth wrong code locks, right code returns the live sets only', async () => {
  const t = await boot();
  try {
    const o = await post(t.base, '/bills/options', { building_id: BLD });
    const s = await post(t.base, '/bills/send-code', { building_id: BLD, option: o.body.options[1].id });
    const real = codeFrom(t.state.mails.at(-1)), wrong = real === '000000' ? '111111' : '000000';
    const r1 = await post(t.base, '/bills/verify', { challenge: s.body.challenge, code: wrong });
    assert.strictEqual(r1.status, 400); assert.strictEqual(r1.body.attempts_left, 4);
    const ok = await post(t.base, '/bills/verify', { challenge: s.body.challenge, code: real });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.body.uploads.map(u => u.id), [BU1], 'the expired set is not offered');
    assert.deepStrictEqual(ok.body.uploads[0].names, ['jan.pdf', 'feb.pdf', 'mar.pdf']);
    assert.strictEqual((await post(t.base, '/bills/verify', { challenge: s.body.challenge, code: real })).status, 400, 'a code works once');
    const s2 = await post(t.base, '/bills/send-code', { building_id: BLD, option: o.body.options[1].id });
    const real2 = codeFrom(t.state.mails.at(-1)), w2 = real2 === '000000' ? '111111' : '000000';
    let last; for (let i = 0; i < 5; i++) last = await post(t.base, '/bills/verify', { challenge: s2.body.challenge, code: w2 });
    assert.match(last.body.error, /Too many wrong codes/);
    assert.strictEqual((await post(t.base, '/bills/verify', { challenge: s2.body.challenge, code: real2 })).status, 400, 'locked even with the right code');
  } finally { t.close(); }
});

test('reuse: needs a session for this building and a live set; files are refused with it', async () => {
  const t = await boot();
  try {
    const v = await verified(t);
    const bad = await post(t.base, '/screening-request', reqBody({ reuse: { session: 'nope', bill_upload_id: BU1 } }));
    assert.strictEqual(bad.status, 403); assert.strictEqual(bad.body.verifyAgain, true);
    const expired = await post(t.base, '/screening-request', reqBody({ reuse: { session: v.session, bill_upload_id: BU2 } }));
    assert.strictEqual(expired.status, 409);
    const forged = await post(t.base, '/screening-request', reqBody({ reuse: { session: v.session, bill_upload_id: 'a2BJx000000000777' } }));
    assert.strictEqual(forged.status, 409);
    const withFiles = await post(t.base, '/screening-request', reqBody({ reuse: { session: v.session, bill_upload_id: BU1 }, upload_mode: 'separate' },
      { bill_files: [{ name: 'x.pdf', size: 10 }] }));
    assert.strictEqual(withFiles.status, 400);
    const other = reqBody({ reuse: { session: v.session, bill_upload_id: BU1 } }); other.buildings[0].sf_building_id = OTHER;
    assert.strictEqual((await post(t.base, '/screening-request', other)).status, 403, 'a session is bound to its building');
    assert.strictEqual(t.state.patches.length, 0, 'nothing was written by any refused attempt');
  } finally { t.close(); }
});

test('reuse: a Desk Audit request names the earlier set, issues no upload token, and counts the reuse', async () => {
  const t = await boot();
  try {
    const v = await verified(t);
    const r = await post(t.base, '/screening-request', reqBody({ reuse: { session: v.session, bill_upload_id: BU1 }, want: { desk: true, solar: false } }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.reused, true); assert.strictEqual(r.body.billSets, true);
    assert.ok(!r.body.records[0].uploadToken);
    const b = t.state.patches.find(p => p.obj === 'Buildings__c').data;
    assert.strictEqual(b.Screening_Status__c, 'Requested');
    assert.strictEqual(b.Screening_Bill_Upload__c, BU1);
    assert.strictEqual(b.Screening_Bill_Source__c, 'Reused earlier upload');
    assert.strictEqual(b.Screening_Requested_By__c, 'uploader@parish.org');
    assert.strictEqual(b.Bill_Count__c, 3);
    const u = t.state.patches.find(p => p.obj === 'Bill_Upload__c');
    assert.strictEqual(u.id, BU1); assert.strictEqual(u.data.Reuse_Count__c, 1);
    assert.strictEqual(u.data.Purpose__c, 'Desk Audit');
  } finally { t.close(); }
});

test('reuse: Solar-only leaves the Desk Audit queue alone; Solar plus Desk sets both', async () => {
  const t = await boot();
  try {
    const v = await verified(t);
    await post(t.base, '/screening-request', reqBody({ reuse: { session: v.session, bill_upload_id: BU1 }, want: { desk: false, solar: true } }));
    let b = t.state.patches.filter(p => p.obj === 'Buildings__c').at(-1).data;
    assert.ok(!('Screening_Status__c' in b) && !('Screening_Requested_At__c' in b) && !('Screening_Bill_Upload__c' in b), 'no Desk Audit fields');
    assert.strictEqual(b.Solar_Bill_Upload__c, BU1);
    assert.match(t.state.patches.filter(p => p.obj === 'Bill_Upload__c').at(-1).data.Purpose__c, /Solar Assessment/);
    await post(t.base, '/screening-request', reqBody({ reuse: { session: v.session, bill_upload_id: BU1 }, want: { desk: true, solar: true } }));
    b = t.state.patches.filter(p => p.obj === 'Buildings__c').at(-1).data;
    assert.strictEqual(b.Screening_Status__c, 'Requested'); assert.strictEqual(b.Solar_Bill_Upload__c, BU1);
  } finally { t.close(); }
});

test('new upload: a Bill_Upload is created, each file is linked to it, complete finalizes it and requests the audit', async () => {
  const t = await boot();
  try {
    const r = await post(t.base, '/screening-request', reqBody({ upload_mode: 'separate', want: { desk: true, solar: false } },
      { bill_files: [{ name: 'a.pdf', size: 10 }, { name: 'b.pdf', size: 10 }] }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const rec = r.body.records[0];
    assert.ok(rec.uploadToken);
    const bu = t.state.posts.find(p => p.obj === 'Bill_Upload__c').data;
    assert.strictEqual(bu.Status__c, 'Uploading'); assert.strictEqual(bu.Uploader_Email__c, 'uploader@parish.org'); assert.ok(!('Uploader_Name__c' in bu), 'the name field was removed from Bill_Upload__c in Salesforce');
    assert.strictEqual(bu.Reuse_Expires_On__c, '2027-11-14', '395 days after 2026-10-15');
    const pre = t.state.patches.find(p => p.obj === 'Buildings__c').data;
    assert.ok(pre.Screening_Status__c == null, 'not fetchable until complete');
    assert.strictEqual(pre.Screening_Bill_Upload__c, null);
    for (const n of ['a.pdf', 'b.pdf']) {
      const f = await post(t.base, '/screening-file', { building_id: BLD, submission_id: r.body.submissionId, token: rec.uploadToken, name: n, data: 'JVBERi0x' });
      assert.strictEqual(f.status, 200);
    }
    assert.ok(t.state.links.every(l => l.extra.length === 1 && l.extra[0] === 'a2BJx000000000099'));
    const c = await post(t.base, '/screening-complete', { building_id: BLD, submission_id: r.body.submissionId, token: rec.uploadToken, failed: [] });
    assert.strictEqual(c.status, 200);
    const done = t.state.patches.find(p => p.obj === 'Bill_Upload__c' && p.data.Status__c);
    assert.strictEqual(done.data.Status__c, 'Complete'); assert.strictEqual(done.data.Bill_Count__c, 2);
    assert.strictEqual(done.data.Bill_Filenames__c, 'a.pdf\nb.pdf');
    const b = t.state.patches.filter(p => p.obj === 'Buildings__c').at(-1).data;
    assert.strictEqual(b.Screening_Status__c, 'Requested'); assert.strictEqual(b.Screening_Bill_Upload__c, 'a2BJx000000000099');
    assert.strictEqual(b.Screening_Bill_Source__c, 'New upload');
  } finally { t.close(); }
});

test('new upload: a failed file leaves the set Incomplete (never offered for reuse)', async () => {
  const t = await boot();
  try {
    const r = await post(t.base, '/screening-request', reqBody({ upload_mode: 'separate' }, { bill_files: [{ name: 'a.pdf', size: 10 }, { name: 'b.pdf', size: 10 }] }));
    const rec = r.body.records[0];
    await post(t.base, '/screening-file', { building_id: BLD, submission_id: r.body.submissionId, token: rec.uploadToken, name: 'a.pdf', data: 'JVBERi0x' });
    await post(t.base, '/screening-complete', { building_id: BLD, submission_id: r.body.submissionId, token: rec.uploadToken, failed: ['b.pdf'] });
    assert.strictEqual(t.state.patches.find(p => p.obj === 'Bill_Upload__c' && p.data.Status__c).data.Status__c, 'Incomplete');
  } finally { t.close(); }
});

test('new upload, Solar only: the set is completed for reuse but no Desk Audit is requested', async () => {
  const t = await boot();
  try {
    const r = await post(t.base, '/screening-request', reqBody({ upload_mode: 'separate', want: { desk: false, solar: true } }, { bill_files: [{ name: 'a.pdf', size: 10 }] }));
    const rec = r.body.records[0];
    assert.ok(!('Screening_Status__c' in t.state.patches.find(p => p.obj === 'Buildings__c').data));
    await post(t.base, '/screening-file', { building_id: BLD, submission_id: r.body.submissionId, token: rec.uploadToken, name: 'a.pdf', data: 'JVBERi0x' });
    await post(t.base, '/screening-complete', { building_id: BLD, submission_id: r.body.submissionId, token: rec.uploadToken, failed: [], want_desk: false, want_solar: true });
    const b = t.state.patches.filter(p => p.obj === 'Buildings__c').at(-1).data;
    assert.ok(!('Screening_Status__c' in b), 'Solar-only never requests a Desk Audit');
    assert.strictEqual(b.Solar_Bill_Upload__c, 'a2BJx000000000099');
    assert.strictEqual(t.state.patches.find(p => p.obj === 'Bill_Upload__c' && p.data.Status__c).data.Status__c, 'Complete');
  } finally { t.close(); }
});

test('a Salesforce org without the new fields gets a clear 503, not a half save', async () => {
  const w = world();
  w.sf.sfPost = async () => { throw new Error('SF POST Bill_Upload__c failed: [{"errorCode":"NOT_FOUND","message":"sObject type \'Bill_Upload__c\' is not supported"}]'); };
  const t = await boot({}, { ...w, sf: fakeSf({ sfPost: w.sf.sfPost, sfQuery: async () => [] }) });
  try {
    const r = await post(t.base, '/screening-request', reqBody({ upload_mode: 'separate' }, { bill_files: [{ name: 'a.pdf', size: 10 }] }));
    assert.strictEqual(r.status, 503); assert.match(r.body.error, /CR-S4/);
  } finally { t.close(); }
});

test('help request becomes a task; falls back when the building cannot hold activities', async () => {
  const w = world(); let n = 0;
  w.sf = fakeSf({ sfPost: async (i, t, obj, data) => { if (obj === 'Task') { w.state.posts.push({ obj, data }); if (data.WhatId && n++ === 0) throw new Error('no activities'); } return { id: 'T1' }; } });
  const t = await boot({ BILLS_STAFF_TASK_OWNER_ID: '005Jx00000000000AA' }, w);
  try {
    const r = await post(t.base, '/bills/request-help', { building_id: BLD, email: 'me@x.org', name: 'Pat', message: 'lost access' });
    assert.strictEqual(r.status, 200);
    const tasks = t.state.posts.filter(p => p.obj === 'Task');
    assert.strictEqual(tasks.length, 2); assert.ok(!tasks[1].data.WhatId);
    assert.strictEqual(tasks[1].data.OwnerId, '005Jx00000000000AA');
    assert.match(tasks[1].data.Description, /lost access/);
    assert.strictEqual((await post(t.base, '/bills/request-help', { building_id: BLD, email: 'bad' })).status, 400);
  } finally { t.close(); }
});

test('Instant Audit writes its own status field when bill sets are on, the shared one when off', () => {
  const sw = require('../lib/instant/sfwrite');
  const clean = { facts: { sqft_total: 1, sqft_confirmed_county: false, heating_fuel: 'gas', building_type: 'worship', reasons: [], shared_meter_note: '' } };
  const totals = { electricSpend: 1, gasSpend: 1 };
  const on = sw.buildingPatch(clean, totals, null, true), off = sw.buildingPatch(clean, totals, null, false);
  assert.strictEqual(on.Instant_Audit_Status__c, 'Pending'); assert.ok(!('Screening_Status__c' in on));
  assert.strictEqual(off.Screening_Status__c, 'Instant Audit Pending'); assert.ok(!('Instant_Audit_Status__c' in off));
  const res = { light: 'green', headline: 'h', annual_spend: 1, basis: 'client_entered', assumptions_version: 'v' };
  assert.strictEqual(sw.resultPatch(res, 'x', true).Instant_Audit_Status__c, 'Completed');
  assert.strictEqual(sw.resultPatch(res, 'x', false).Screening_Status__c, 'Instant Audit Completed');
});

test('mailer: Postmark and SendGrid requests are shaped right; no provider refuses', async () => {
  const { createMailer, MailNotConfigured } = require('../lib/mailer');
  const seen = [];
  const f = async (url, o) => { seen.push({ url, o }); return { ok: true, status: 200 }; };
  await createMailer({ provider: 'postmark', apiKey: 'K', from: 'a@ce.org' }, f).send({ to: 'x@y.org', subject: 's', text: 't' });
  assert.strictEqual(seen[0].url, 'https://api.postmarkapp.com/email'); assert.strictEqual(seen[0].o.headers['X-Postmark-Server-Token'], 'K');
  await createMailer({ provider: 'sendgrid', apiKey: 'K', from: 'a@ce.org' }, f).send({ to: 'x@y.org', subject: 's', text: 't' });
  assert.strictEqual(seen[1].url, 'https://api.sendgrid.com/v3/mail/send'); assert.strictEqual(seen[1].o.headers.Authorization, 'Bearer K');
  await assert.rejects(createMailer({}, f).send({ to: 'x', subject: 's', text: 't' }), MailNotConfigured);
  await assert.rejects(createMailer({ provider: 'postmark', apiKey: 'K' }, f).send({ to: 'x', subject: 's', text: 't' }), MailNotConfigured);
  await assert.rejects(createMailer({ provider: 'postmark', apiKey: 'K', from: 'a@b.org' }, async () => ({ ok: false, status: 422 })).send({ to: 'x', subject: 's', text: 't' }), /refused/);
});
