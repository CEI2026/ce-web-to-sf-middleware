'use strict';
// Shared test helpers: build the app with a fake Salesforce, and act as Freddie.
const fs = require('fs');
const path = require('path');
const { createApp } = require('../server');
const { freddieSignature } = require('../lib/instant/signing');

const fx = name => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8'));

function fakeSf(overrides = {}) {
  const calls = [];
  const defaults = {
    getSFToken: async () => ({ access_token: 'T', instance_url: 'https://sf.test' }),
    sfQuery: async () => [], sfPost: async () => ({ id: 'NEW1' }), sfPatch: async () => ({ success: true }),
    sfGetFields: async () => ({}), sfCreateMany: async () => [], findOrCreateContact: async () => '003CONTACT',
    findExistingBuilding: async () => null, uploadFilesToSF: async () => {}, uploadOneFileToSF: async () => {},
    generateSubmissionId: () => 'SA-TEST',
  };
  const sf = { calls };
  for (const k of Object.keys(defaults)) {
    sf[k] = async (...a) => { calls.push({ name: k, args: a }); return (overrides[k] || defaults[k])(...a); };
  }
  sf.generateSubmissionId = defaults.generateSubmissionId;
  sf.of = name => calls.filter(c => c.name === name);
  return sf;
}

async function start(env = {}, opts = {}) {
  const sf = opts.sf || fakeSf();
  const logs = [];
  const app = createApp({
    env: { INSTANT_AUDIT_RATE_PER_HOUR: '1000', INSTANT_AUDIT_RATE_PER_BUILDING_DAY: '1000', ...env },
    sf, log: (...a) => logs.push(a.join(' ')), now: opts.now,
  });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app, server, base, sf, logs, queue: app.locals.queue, store: app.locals.store, cfg: app.locals.cfg,
    close: () => { app.locals.queue.close(); server.close(); },
  };
}

const post = (base, p, body, headers = {}) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers }));
const get = (base, p, headers = {}) => fetch(base + p, { headers }).then(async r => ({
  status: r.status, headers: r.headers, body: await r.clone().json().catch(() => null), raw: r,
}));

// A signed request, as Freddie would send it.
function signed(base, secret, method, pathAndQuery, bodyObj, o = {}) {
  const ts = o.ts !== undefined ? o.ts : Math.floor(Date.now() / 1000);
  const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  const sig = o.badSig ? '0'.repeat(64) : freddieSignature(secret, ts, method, pathAndQuery.split('?')[0], body);
  const headers = { 'x-ce-timestamp': String(ts), 'x-ce-signature': sig };
  if (o.omit) for (const k of o.omit) delete headers[k];
  if (body) headers['content-type'] = 'application/json';
  return fetch(base + pathAndQuery, { method, headers, body: body || undefined })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
}

const PDF_B64 = Buffer.from('%PDF-1.4\n%test\n').toString('base64');
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { fx, fakeSf, start, post, get, signed, PDF_B64, sleep };
