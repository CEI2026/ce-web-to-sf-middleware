'use strict';
// Side-by-side proof: OLD ce-solar-middleware v7.6 vs the NEW app, same requests, same fake Salesforce.
process.env.SF_CLIENT_ID = 'cid'; process.env.SF_CLIENT_SECRET = 'csecret';
process.env.NEW_ACCOUNTS_ENABLED = 'true'; process.env.PORT = '4101';
process.env.SCREENING_UPLOAD_SECRET = 'fixed-test-secret';
const path = require('path');
const Module = require('module');
let calls = [], ctr = 0;
const R = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
function stubFetch(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const u = decodeURIComponent(url);
  let body = null; try { body = opts.body && typeof opts.body === 'string' && opts.body[0] === '{' ? JSON.parse(opts.body) : opts.body || null; } catch (e) { body = opts.body; }
  if (u.includes('/oauth2/token')) return Promise.resolve(R(200, { access_token: 'T', instance_url: 'https://sf.test' }));
  calls.push({ method, url: u, body });
  if (method === 'GET' && u.includes('/query?q=')) {
    const q = u.split('/query?q=')[1];
    let records = [];
    if (/FROM Account/.test(q)) records = [{ Id: '001A', Name: 'St. A', BillingStreet: '1 Main', BillingCity: 'Knox', BillingState: 'TN', BillingPostalCode: '37902' }, { Id: '001B', Name: 'St. B', BillingStreet: '', BillingCity: 'Knox', BillingState: 'TN', BillingPostalCode: '37902' }];
    else if (/FROM Buildings__c/.test(q) && /Name = /.test(q)) records = /Name = 'Dup Hall'/.test(q) ? [{ Id: 'a1ODUP', Name: 'Dup Hall' }] : [];
    else if (/FROM Buildings__c/.test(q)) records = [{ Id: 'a1O1', Name: 'Church', Full_Address__c: '1 Main', Building_Type__c: 'Church', SQFT__c: 18000, SQFT_Found_in_County_Data__c: true }, { Id: 'a1O2', Name: 'Hall', Full_Address__c: null, Building_Type__c: null, SQFT__c: null, SQFT_Found_in_County_Data__c: false }];
    else if (/FROM Contact/.test(q)) records = /known@x\.org/.test(q) ? [{ Id: '003KNOWN', FirstName: 'Ann', LastName: 'Lee', Phone: '', Title: '' }] : [];
    else if (/FROM Ecclesiastical_Institution__c/.test(q)) records = [{ Id: 'a1aEI1', Name: 'Diocese of Knoxville', Institution_Type__c: 'Diocese' }, { Id: 'a1aEI2', Name: 'Some Order', Institution_Type__c: null }];
    return Promise.resolve(R(200, { records }));
  }
  if (method === 'POST') return Promise.resolve(R(201, { id: u.includes('ContentVersion') ? '0680CV' + (++ctr) : 'NEW' + (++ctr), success: true }));
  if (method === 'PATCH') return Promise.resolve({ ok: true, status: 204, json: async () => ({}), text: async () => '' });
  if (method === 'GET' && u.includes('/ContentVersion/')) return Promise.resolve(R(200, { ContentDocumentId: '069DOC' }));
  if (method === 'GET' && u.includes('/Buildings__c/')) return Promise.resolve(R(200, { Screening_Intake_Flags__c: '' }));
  return Promise.resolve(R(404, [{ message: 'unhandled in stub: ' + method + ' ' + u }]));
}
const orig = Module._load;
Module._load = function (request, ...rest) { return request === 'node-fetch' ? stubFetch : orig.call(this, request, ...rest); };

const ACCT = '001Jx00001tqn9JIAQ', BLD = 'a1OJx000001UtZAMA0';
const contact = { first_name: 'Fred', last_name: 'F', email: 'fred@example.org', role: 'Business manager' };
const bld = (extra) => ({ sf_building_id: BLD, building_name: 'Church', client_sqft: 18000, county_sqft_reference: 18000, client_confirmed_county_sqft: true, client_electric_spend: '21,300', ...extra });
const safContact = { firstname: 'Ann', lastname: 'Lee', email: 'known@x.org', phone: '555-1', title: 'Pastor', notes: 'hello' };
const safB = (e) => ({ building_name: 'Church', sf_building_id: 'a1OEXIST', building_type: 'Church', building_address: '1 Main', q1: 'Yes', q2: 'No', roof: 'North', budget: '5000', bill_count: '2', bill_filenames: 'a.pdf, b.pdf', gm_answer: 'No', gm_desc: '', ...e });
const files = [{ name: 'a.pdf', data: 'JVBERi0x' }, { name: 'b.pdf', data: 'JVBERi0y' }];
const S = [
  ['GET', '/accounts?zip=37902'], ['GET', '/accounts?zip=abc'], ['GET', '/buildings?accountId=001A'], ['GET', '/buildings'], ['GET', '/institutions'],
  ['POST', '/accounts', { name: 'St. New', isCatholic: true, institutionId: 'a1aEI1', institutionType: 'Diocese', street: '1 A St', city: 'Knox', state: 'TN', zip: '37902' }],
  ['POST', '/accounts', { name: 'First Baptist', isCatholic: false, denomination: 'Protestant \u2013 Mainline', zip: '37902' }],
  ['POST', '/accounts', { name: '  ' }],
  ['POST', '/submit', { sf_account_id: '001A00000000001AAA', timestamp: '2026-10-06T00:00:00.000Z', contact: safContact, buildings: [safB({ bill_files: files }), safB({ building_name: 'New Gym', sf_building_id: 'NEW', manually_added: true, bill_files: [] }), safB({ building_name: 'Dup Hall', sf_building_id: 'NEW', manually_added: true, bill_count: '0', bill_files: [] })] }],
  ['POST', '/submit', { sf_account_id: '001A00000000001AAA', contact: { firstname: 'Bo', lastname: 'New', email: 'new@x.org' }, buildings: [safB({})] }],
  ['POST', '/screening-request', { sf_account_id: ACCT, contact, buildings: [bld({})] }],
  ['POST', '/screening-request', { sf_account_id: ACCT, contact, buildings: [bld({ client_sqft: 50000, client_electric_spend: 20000 })] }],
  ['POST', '/screening-request', { sf_account_id: ACCT, contact, buildings: [{ sf_building_id: BLD, building_name: 'Church', client_sqft: 18000 }] }],
  ['POST', '/screening-request', { sf_account_id: ACCT, contact, buildings: [{ sf_building_id: BLD, building_name: 'Church', client_sqft: 18000, bill_files: [{ name: 'jan.pdf', type: 'application/pdf', data: 'JVBERi0x' }] }] }],
  ['POST', '/screening-request', { sf_account_id: ACCT, contact, buildings: [{ sf_building_id: 'NEW', manually_added: true, building_name: 'New Gym', building_type: 'Gymnasium', building_address: '9 Main St', client_sqft: 9000, client_electric_spend: 5000 }] }],
  ['POST', '/screening-request', { sf_account_id: "001'; DROP", contact, buildings: [] }],
  ['POST', '/screening-complete', { building_id: BLD, submission_id: 'x', token: 'nope', failed: [] }],
  ['POST', '/screening-file', { building_id: BLD, submission_id: 'x', token: 'nope', name: 'a.pdf', data: 'JVBERi0x' }],
  ['GET', '/nope'],
];
const norm = (x) => JSON.stringify(x)
  .replace(/SA-\d{8}-[A-Z0-9]{6}/g, 'SA-X').replace(/ES-\d{8}-[A-Z0-9]{6}/g, 'ES-X')
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, 'TS').replace(/"uploadToken":"[^"]*"/g, '"uploadToken":"TOKEN"');
async function hit(base, [m, p, b]) {
  calls = []; ctr = 0;
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  let body; const t = await r.text(); try { body = JSON.parse(t); } catch (e) { body = t.slice(0, 80); }
  return { status: r.status, body, calls };
}
(async () => {
  const log = console.log, err = console.error; console.log = () => {}; console.error = () => {}; console.warn = () => {};
  require(path.join(process.env.LEGACY_DIR || path.join(__dirname, 'legacy'), 'server.js'));                                  // OLD listens on 4101
  const { createApp } = require('../server.js');
  const nsrv = createApp({ env: process.env, log: () => {} }).listen(4102);   // NEW
  await new Promise(r => setTimeout(r, 400));
  let same = 0, diff = 0;
  for (const s of S) {
    const o = await hit('http://127.0.0.1:4101', s), n = await hit('http://127.0.0.1:4102', s);
    const ok = norm(o) === norm(n);
    ok ? same++ : diff++;
    log(`${ok ? 'IDENTICAL' : 'DIFFERENT'}  ${s[0].padEnd(4)} ${s[1].padEnd(32)} status ${o.status}/${n.status}  SF calls ${o.calls.length}/${n.calls.length}`);
    if (!ok) { log('  OLD:', norm(o).slice(0, 700)); log('  NEW:', norm(n).slice(0, 700)); }
  }
  log(`\n${same} identical, ${diff} different (of ${S.length})`);
  nsrv.close(); process.exit(diff ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
