// Mock-SF test for /screening-request. Run: node test-screening-request.js
'use strict';
const assert = require('assert');
const express = require('express');
const { register, validate } = require('../routes/screening');

const calls = { patch: [], post: [], upload: [], contact: [] };
const deps = {
  getSFToken: async () => ({ access_token: 't', instance_url: 'https://mock' }),
  sfPost: async (i, t, obj, data) => { calls.post.push({ obj, data }); return { id: 'a1ONEW00000000001' }; },
  sfPatch: async (i, t, obj, id, data) => { calls.patch.push({ obj, id, data }); return { success: true }; },
  findOrCreateContact: async (i, t, acct, c) => { calls.contact.push({ acct, c }); return '003MOCK0000000001'; },
  findExistingBuilding: async (i, t, acct, name) => (name === 'Dup Hall' ? 'a1ODUP00000000001' : null),
  uploadFilesToSF: async (i, t, bid, files) => { calls.upload.push({ bid, n: files.length }); },
  uploadOneFileToSF: async (i, t, bid, f) => { if (f.name === 'boom.pdf') throw new Error('SF down'); calls.one.push({ bid, name: f.name, len: f.data.length }); },
  sfGetFields: async () => ({ Screening_Intake_Flags__c: 'screening_unit_campus' }),
  uploadSecret: 'test-secret',
};
calls.one = [];
const app = express(); app.use(express.json({ limit: '50mb' })); register(app, deps);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const postTo = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
const post = (body) => fetch(`${base}/screening-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));

const ACCT = '001Jx00001tqn9JIAQ', BLD = 'a1OJx000001UtZAMA0';
const contact = { first_name: 'Fred', last_name: 'F', email: 'fred@example.org', role: 'Business manager' };

(async () => {
  // 1. happy path: existing building, ledger spend, county confirmed
  let r = await post({ sf_account_id: ACCT, contact, buildings: [{ sf_building_id: BLD, building_name: 'Church', client_sqft: 18000, county_sqft_reference: 18000, client_confirmed_county_sqft: true, client_electric_spend: '21,300', client_gas_spend: 11760 }] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  let p = calls.patch.pop();
  assert.strictEqual(p.id, BLD);
  assert.strictEqual(p.data.Screening_Status__c, 'Requested');
  assert.strictEqual(p.data.Client_SQFT__c, 18000);
  assert.strictEqual(p.data.Client_Confirmed_County_SQFT__c, true);
  assert.strictEqual(p.data.Client_Electric_Spend__c, 21300);
  assert.strictEqual(p.data.Building_Contact__c, '003MOCK0000000001');
  assert.ok(!('SQFT__c' in p.data), 'county SQFT__c must never be written');
  assert.ok(!('Data_Source__c' in p.data), 'Data_Source__c untouched on existing rows');

  // 2. mismatch flag + confirmed-but-edited
  r = await post({ sf_account_id: ACCT, contact, buildings: [{ sf_building_id: BLD, building_name: 'Church', client_sqft: 50000, county_sqft_reference: 18000, client_electric_spend: 20000 }] });
  assert.strictEqual(calls.patch.pop().data.Screening_Intake_Flags__c, 'sqft_vs_county_mismatch');
  r = await post({ sf_account_id: ACCT, contact, buildings: [{ sf_building_id: BLD, building_name: 'Church', client_sqft: 18500, county_sqft_reference: 18000, client_confirmed_county_sqft: '1', client_electric_spend: 20000 }] });
  p = calls.patch.pop(); assert.strictEqual(p.data.Client_Confirmed_County_SQFT__c, false); assert.strictEqual(p.data.Screening_Intake_Flags__c, 'county_confirmed_but_edited');

  // 3. no spend, no bills -> 400; bills only -> 200 with upload
  r = await post({ sf_account_id: ACCT, contact, buildings: [{ sf_building_id: BLD, building_name: 'Church', client_sqft: 18000 }] });
  assert.strictEqual(r.status, 400); assert.ok(r.body.errors[0].includes('energy spend'));
  r = await post({ sf_account_id: ACCT, contact, buildings: [{ sf_building_id: BLD, building_name: 'Church', client_sqft: 18000, bill_files: [{ name: 'jan.pdf', type: 'application/pdf', data: 'JVBERi0x' }] }] });
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(calls.upload.pop(), { bid: BLD, n: 1 });
  assert.strictEqual(calls.patch.pop().data.Bill_Count__c, 1);

  // 4. manual building: created with QA pending; duplicate guard patches instead
  r = await post({ sf_account_id: ACCT, contact, buildings: [{ sf_building_id: 'NEW', manually_added: true, building_name: 'New Gym', building_type: 'Gymnasium', building_address: '9 Main St', client_sqft: 9000, client_electric_spend: 5000 }] });
  assert.strictEqual(r.status, 200); let c = calls.post.pop();
  assert.strictEqual(c.obj, 'Buildings__c'); assert.strictEqual(c.data.QA_Status__c, 'PENDING'); assert.strictEqual(c.data.Data_Source__c, 'Manual_Form_Submission'); assert.strictEqual(c.data.Screening_Status__c, 'Requested');
  r = await post({ sf_account_id: ACCT, contact, buildings: [{ sf_building_id: 'NEW', manually_added: true, building_name: 'Dup Hall', building_type: 'Hall', building_address: '2 Main St', client_sqft: 4000, client_electric_spend: 3000 }] });
  assert.strictEqual(r.body.records[0].action, 'patched-existing');
  r = await post({ sf_account_id: ACCT, contact, buildings: [{ sf_building_id: 'NEW', manually_added: true, building_name: 'X', building_type: '', building_address: 'Y', client_sqft: 100, client_electric_spend: 1 }] });
  assert.strictEqual(r.status, 400);

  // 5. identity checks: bad account id, bad email, bad building id
  r = await post({ sf_account_id: "001'; DROP", contact, buildings: [] }); assert.strictEqual(r.status, 400);
  r = await post({ sf_account_id: ACCT, contact: { ...contact, email: 'nope' }, buildings: [{ sf_building_id: BLD, client_sqft: 1, client_electric_spend: 1 }] }); assert.strictEqual(r.status, 400);
  r = await post({ sf_account_id: ACCT, contact, buildings: [{ sf_building_id: 'bad id', client_sqft: 1, client_electric_spend: 1 }] }); assert.strictEqual(r.status, 400);

  // 6. CR-S2 fields not yet in org -> 503, not 500
  deps.sfPatch = async () => { throw new Error('SF PATCH Buildings__c failed: [{"errorCode":"INVALID_FIELD","message":"No such column Client_SQFT__c"}]'); };
  r = await post({ sf_account_id: ACCT, contact, buildings: [{ sf_building_id: BLD, building_name: 'Church', client_sqft: 18000, client_electric_spend: 20000 }] });
  assert.strictEqual(r.status, 503);

  // 7. v1.1 - contact names reach the shared helper as firstname/lastname
  deps.sfPatch = async (i, t, obj, id, data) => { calls.patch.push({ obj, id, data }); return { success: true }; };
  r = await post({ sf_account_id: ACCT, contact, buildings: [{ sf_building_id: BLD, building_name: 'Church', client_sqft: 18000, client_electric_spend: 20000 }] });
  assert.strictEqual(r.status, 200);
  const cc = calls.contact.pop().c;
  assert.strictEqual(cc.firstname, 'Fred'); assert.strictEqual(cc.lastname, 'F'); assert.strictEqual(cc.title, 'Business manager');

  // 8. campus: needs named buildings; flags; coverage
  r = await post({ sf_account_id: ACCT, contact, buildings: [{ sf_building_id: BLD, building_name: 'Campus', screening_unit: 'campus', client_sqft: 143941, bill_files: [{ name: 'a.pdf', data: 'JVBERi0=' }] }] });
  assert.strictEqual(r.status, 400, 'campus without named buildings is rejected');
  r = await post({ sf_account_id: ACCT, contact, buildings: [{ sf_building_id: BLD, building_name: 'Campus', screening_unit: 'campus', campus_coverage_confirmed: true, client_shared_meter_note: 'Main, Athletic Center, Library', client_sqft: 143941, bill_files: [{ name: 'a.pdf', data: 'JVBERi0=' }] }] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  p = calls.patch.pop();
  assert.strictEqual(p.data.Screening_Intake_Flags__c, 'screening_unit_campus');
  assert.strictEqual(p.data.Client_Shared_Meter_Note__c, 'Main, Athletic Center, Library');
  r = await post({ sf_account_id: ACCT, contact, buildings: [{ sf_building_id: BLD, building_name: 'Campus', screening_unit: 'campus', client_shared_meter_note: 'Main, Gym', client_sqft: 90000, client_electric_spend: 80000 }] });
  assert.strictEqual(calls.patch.pop().data.Screening_Intake_Flags__c, 'screening_unit_campus;campus_coverage_unconfirmed');
  r = await post({ sf_account_id: ACCT, contact, buildings: [{ sf_building_id: BLD, building_name: 'Church', screening_unit: 'wing', client_sqft: 1, client_electric_spend: 1 }] });
  assert.strictEqual(r.status, 400);

  // 9. heating fuel "none" -> blank picklist + flag
  r = await post({ sf_account_id: ACCT, contact, buildings: [{ sf_building_id: BLD, building_name: 'Sign', client_sqft: 10, client_electric_spend: 240, client_heating_fuel: 'none' }] });
  p = calls.patch.pop();
  assert.strictEqual(p.data.Client_Heating_Fuel__c, null);
  assert.strictEqual(p.data.Screening_Intake_Flags__c, 'heating_fuel_none');

  // 10. a real Salesforce error is reported as itself, not "CR-S2 pending"
  deps.sfPatch = async () => { throw new Error('SF PATCH Buildings__c failed: [{"errorCode":"INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST","message":"bad value for restricted picklist field","fields":["Screening_Status__c"]}]'); };
  r = await post({ sf_account_id: ACCT, contact, buildings: [{ sf_building_id: BLD, building_name: 'Church', client_sqft: 18000, client_electric_spend: 20000 }] });
  assert.strictEqual(r.status, 500);
  assert.ok(/RESTRICTED_PICKLIST/.test(r.body.error));

  // ---- v1.2: one bill per request ----------------------------------
  const { signUpload, checkUpload } = require('../routes/screening');
  deps.sfPatch = async (i, t, obj, id, data) => { calls.patch.push({ obj, id, data }); return { success: true }; };
  const campus = { sf_building_id: BLD, building_name: 'Campus', screening_unit: 'campus', campus_coverage_confirmed: true,
    client_shared_meter_note: 'Main, Gym', client_sqft: 136950,
    bill_files: [{ name: 'kchs-aug.pdf', size: 14 * 1024 * 1024 }, { name: 'kchs-sep.pdf', size: 9 * 1024 * 1024 }] };

  calls.upload.length = 0;
  // 11. step 1: names only; not yet Requested; token per building
  r = await post({ sf_account_id: ACCT, contact, upload_mode: 'separate', buildings: [campus] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  p = calls.patch.pop();
  assert.strictEqual(p.data.Screening_Status__c, null, 'not fetchable until complete');
  assert.strictEqual(p.data.Bill_Count__c, 2);
  assert.strictEqual(p.data.Bill_Filenames__c, 'kchs-aug.pdf, kchs-sep.pdf');
  assert.strictEqual(calls.upload.length, 0, 'no inline upload');
  const sid = r.body.submissionId, tok = r.body.records[0].uploadToken;
  assert.ok(/^\d+\.[0-9a-f]{64}$/.test(tok));
  assert.strictEqual(r.body.records[0].maxFileBytes, 25 * 1024 * 1024);

  // spend-only building in separate mode is Requested immediately
  r = await post({ sf_account_id: ACCT, contact, upload_mode: 'separate', buildings: [{ sf_building_id: BLD, building_name: 'Hall', client_sqft: 5000, client_electric_spend: 9000 }] });
  assert.strictEqual(calls.patch.pop().data.Screening_Status__c, 'Requested');
  assert.ok(!r.body.records[0].uploadToken);

  // step 1 validation: over 20 MB, wrong type
  r = await post({ sf_account_id: ACCT, contact, upload_mode: 'separate', buildings: [{ ...campus, bill_files: [{ name: 'huge.pdf', size: 26 * 1024 * 1024 }] }] });
  assert.strictEqual(r.status, 400); assert.ok(r.body.errors[0].includes('25 MB'));
  r = await post({ sf_account_id: ACCT, contact, upload_mode: 'separate', buildings: [{ ...campus, bill_files: [{ name: 'bill.docx', size: 1000 }] }] });
  assert.strictEqual(r.status, 400);

  // 12. step 2: one file per request, 12 MB accepted
  const big = 'A'.repeat(Math.ceil(12 * 1024 * 1024 / 3) * 4);
  r = await postTo('/screening-file', { building_id: BLD, submission_id: sid, token: tok, name: 'kchs-aug.pdf', data: big });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(calls.one.pop(), { bid: BLD, name: 'kchs-aug.pdf', len: big.length });
  // a Salesforce failure is reported, not swallowed
  r = await postTo('/screening-file', { building_id: BLD, submission_id: sid, token: tok, name: 'boom.pdf', data: 'JVBERi0x' });
  assert.strictEqual(r.status, 502);
  // token bound to building + submission; tampering and expiry refused
  r = await postTo('/screening-file', { building_id: 'a1OJx000001OTHERAA', submission_id: sid, token: tok, name: 'x.pdf', data: 'JVBERi0x' });
  assert.strictEqual(r.status, 403);
  r = await postTo('/screening-file', { building_id: BLD, submission_id: 'ES-20260926-ZZZZZZ', token: tok, name: 'x.pdf', data: 'JVBERi0x' });
  assert.strictEqual(r.status, 403);
  const old = signUpload('test-secret', BLD, sid, Date.now() - 3 * 60 * 60 * 1000);
  assert.strictEqual(checkUpload('test-secret', BLD, sid, old), false, 'expired token');
  r = await postTo('/screening-file', { building_id: BLD, submission_id: sid, token: tok, name: 'bill.exe', data: 'TVqQ' });
  assert.strictEqual(r.status, 400);
  const tooBig = 'A'.repeat(Math.ceil(26 * 1024 * 1024 / 3) * 4);
  r = await postTo('/screening-file', { building_id: BLD, submission_id: sid, token: tok, name: 'huge.pdf', data: tooBig });
  assert.strictEqual(r.status, 413);

  // 13. step 3: complete -> Requested; failures flagged, existing flags kept
  r = await postTo('/screening-complete', { building_id: BLD, submission_id: sid, token: tok, failed: [] });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(calls.patch.pop().data, { Screening_Status__c: 'Requested' });
  r = await postTo('/screening-complete', { building_id: BLD, submission_id: sid, token: tok, failed: ['kchs-sep.pdf'] });
  assert.deepStrictEqual(calls.patch.pop().data, { Screening_Status__c: 'Requested',
    Screening_Intake_Flags__c: 'screening_unit_campus;bills_upload_incomplete' });
  r = await postTo('/screening-complete', { building_id: BLD, submission_id: sid, token: 'nope', failed: [] });
  assert.strictEqual(r.status, 403);

  server.close();
  console.log('screening-request: all checks passed');
})().catch(e => { console.error('FAIL', e); server.close(); process.exit(1); });
