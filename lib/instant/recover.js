'use strict';
// ce-web-to-sf-middleware - lib/instant/recover.js
// The queue lives in memory and is lost when Heroku restarts the app. Salesforce
// holds every submission first, so unfinished work (building status "Instant audit
// pending") is rebuilt from the building record and its Utility Month records and
// put back in the queue. Only runs when INSTANT_AUDIT_SF_WRITE is true.
const crypto = require('crypto');
const { BUILDING_TYPES, HEATING_FUELS, REASONS, FUELS, UNITS, STATUS, SF } = require('./schema');

const invert = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]));
const TYPE_BY_LABEL = invert(BUILDING_TYPES);
const REASON_BY_LABEL = invert(REASONS);
const FUEL_BY_LABEL = invert(FUELS);
const UNIT_BY_LABEL = invert(UNITS);

// The picklist holds "Gas", "Electric", ...; the engine wants lowercase. "Other" or blank means we do not know: "none".
const heatingFuel = v => { const f = String(v || '').toLowerCase(); return HEATING_FUELS.includes(f) ? f : 'none'; };

async function rebuildPending({ sf, now = Date.now(), minAgeMs = 30000, limit = 25 }) {
  const { access_token, instance_url } = await sf.getSFToken();
  const B = SF.building; const M = SF.month;
  const buildings = await sf.sfQuery(instance_url, access_token,
    `SELECT Id, Account__c, Name, Full_Address__c, ${B.sqft}, ${B.confirmedCounty}, ${B.heatingFuel}, ${B.type}, ` +
    `${B.reasons}, ${B.sharedNote}, ${B.electricSpend}, ${B.gasSpend}, Building_Contact__r.Name, ` +
    `Building_Contact__r.Email, Building_Contact__r.Phone FROM Buildings__c ` +
    `WHERE ${B.status} = '${STATUS.pending}' AND IsDeleted = false LIMIT ${limit}`);
  if (!buildings || !buildings.length) return [];

  const ids = buildings.map(b => `'${b.Id}'`).join(',');     // ids come from Salesforce itself
  const rows = await sf.sfQuery(instance_url, access_token,
    `SELECT ${M.building}, ${M.fuel}, ${M.accountLabel}, ${M.period}, ${M.usage}, ${M.unit}, ${M.cost}, ` +
    `${M.submissionId}, ${M.enteredAt} FROM ${SF.monthObject} WHERE ${M.building} IN (${ids}) ` +
    `AND ${M.source} = '${SF.sourceClientEntered}' ORDER BY ${M.enteredAt} DESC LIMIT 2000`);

  const byBuilding = new Map();
  for (const r of rows || []) {
    const list = byBuilding.get(r[M.building]) || [];
    list.push(r); byBuilding.set(r[M.building], list);
  }

  const payloads = [];
  for (const b of buildings) {
    const all = byBuilding.get(b.Id) || [];
    const latest = all.length ? all[0][M.submissionId] : null;
    const mine = all.filter(r => r[M.submissionId] === latest);
    if (mine.length && now - Date.parse(mine[0][M.enteredAt]) < minAgeMs) continue;   // still being processed

    const zip = (/\b(\d{5})(?:-\d{4})?\s*$/.exec(b.Full_Address__c || '') || [])[1] || '';
    const contact = b.Building_Contact__r || {};
    const payload = {
      submission_id: latest || crypto.randomUUID(),
      mode: mine.length ? 'monthly' : 'annual',
      building: { account_id: b.Account__c, building_id: b.Id, name: b.Name, address: b.Full_Address__c || '', zip },
      facts: {
        sqft_total: b[B.sqft], sqft_county: null, sqft_confirmed_county: !!b[B.confirmedCounty],
        building_type: TYPE_BY_LABEL[b[B.type]] || null,
        heating_fuel: heatingFuel(b[B.heatingFuel]),
        reasons: String(b[B.reasons] || '').split(';').map(l => REASON_BY_LABEL[l]).filter(Boolean),
        shared_meter_note: b[B.sharedNote] || '',
      },
      contact: { name: contact.Name || '', email: contact.Email || '', phone: contact.Phone || '' },
      consent: true, website: '',
    };
    if (mine.length) {
      const accounts = new Map();
      for (const r of mine) {
        const key = `${r[M.fuel]}|${r[M.accountLabel]}|${r[M.unit]}`;
        if (!accounts.has(key)) {
          accounts.set(key, { label: r[M.accountLabel], fuel: FUEL_BY_LABEL[r[M.fuel]] || 'other', unit: UNIT_BY_LABEL[r[M.unit]] || 'kwh', rows: [] });
        }
        accounts.get(key).rows.push({ month: String(r[M.period]).slice(0, 7), usage: r[M.usage], cost: r[M.cost] });
      }
      payload.accounts = [...accounts.values()].map(a => ({ ...a, rows: a.rows.sort((x, y) => (x.month < y.month ? -1 : 1)) }));
    } else {
      payload.annual = { electric_cost: b[B.electricSpend] || 0, gas_cost: b[B.gasSpend] || 0 };
    }
    payloads.push(payload);
  }
  return payloads;
}

// Puts rebuilt work back in the queue, skipping anything already known.
async function recoverPending({ sf, store, queue, now = Date.now(), minAgeMs = 30000, log = console.log }) {
  const payloads = await rebuildPending({ sf, now, minAgeMs });
  let n = 0;
  for (const p of payloads) {
    if (store.get(p.submission_id) || queue.hasSubmission(p.submission_id)) continue;
    const rec = store.create(p.submission_id, { payload: p });
    rec.jobId = queue.enqueue(p.submission_id, p).job_id;
    n++;
  }
  if (n) log(`[instant-audit] recovered ${n} unfinished submission(s) from Salesforce`);
  return n;
}

module.exports = { rebuildPending, recoverPending };
