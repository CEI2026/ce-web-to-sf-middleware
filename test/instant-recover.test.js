'use strict';
// After a restart the in-memory queue is gone; unfinished work is rebuilt from Salesforce.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fx } = require('./helpers');
const { rebuildPending, recoverPending } = require('../lib/instant/recover');
const { JobQueue, SubmissionStore } = require('../lib/instant/queue');
const { validate } = require('../lib/instant/validate');
const { monthRecords } = require('../lib/instant/sfwrite');

const NOW = Date.parse('2026-10-06T20:00:00Z');
const original = () => validate(fx('submission_chancery_12_months.json')).clean;

// Salesforce as it would look after the original submission was saved
function salesforce(enteredAt) {
  const clean = original();
  const months = monthRecords(clean, enteredAt);
  return {
    getSFToken: async () => ({ access_token: 'T', instance_url: 'https://sf.test' }),
    sfQuery: async (i, t, soql) => {
      if (/FROM Buildings__c/.test(soql)) return [{
        Id: clean.building.building_id, Account__c: clean.building.account_id, Name: 'Chancery',
        Full_Address__c: '805 Northshore Dr, Knoxville, TN 37902', Client_SQFT__c: 15848, Client_Confirmed_County_SQFT__c: false,
        Client_Heating_Fuel__c: 'Gas', Client_building_type__c: 'Office or Chancery', Client_Reasons_to_Look__c: 'Equipment replacement or renovation is planned or needed;A grant, requirement or budget deadline applies',
        Client_Shared_Meter_Note__c: null, Client_Electric_Spend__c: 31959.4, Client_Gas_Spend__c: 6399.3,
        Building_Contact__r: { Name: 'Test Contact', Email: 'test.contact@example.org', Phone: null },
      }];
      if (/FROM Utility_Month__c/.test(soql)) return months;
      return [];
    },
  };
}

test('unfinished work is rebuilt from Salesforce into the same submission', async () => {
  const [p] = await rebuildPending({ sf: salesforce('2026-10-06T19:00:00Z'), now: NOW });
  const o = original();
  assert.equal(p.submission_id, o.submission_id);
  assert.equal(p.mode, 'monthly');
  assert.equal(p.building.zip, '37902');
  assert.equal(p.facts.sqft_total, 15848);
  assert.equal(p.facts.building_type, 'office-chancery');
  assert.equal(p.facts.heating_fuel, 'gas');
  assert.deepEqual(p.facts.reasons.sort(), ['capital', 'deadline']);
  assert.deepEqual(p.contact, { name: 'Test Contact', email: 'test.contact@example.org', phone: '' });
  const byLabel = Object.fromEntries(p.accounts.map(a => [a.label, a]));
  assert.deepEqual(byLabel['Electric 1'].rows, o.accounts[0].rows);
  assert.deepEqual(byLabel['Gas 1'].rows, o.accounts[1].rows);
  assert.equal(byLabel['Gas 1'].fuel, 'gas'); assert.equal(byLabel['Gas 1'].unit, 'therms');
});

test('a submission less than 30 seconds old is left alone (it is still being processed)', async () => {
  const fresh = new Date(NOW - 5000).toISOString();
  assert.deepEqual(await rebuildPending({ sf: salesforce(fresh), now: NOW }), []);
});

test('recovered work goes in the queue once; known work is skipped', async () => {
  const q = new JobQueue(), s = new SubmissionStore(), logs = [];
  const sf = salesforce('2026-10-06T19:00:00Z');
  assert.equal(await recoverPending({ sf, store: s, queue: q, now: NOW, log: m => logs.push(m) }), 1);
  assert.equal(q.stats().queued, 1);
  assert.ok(s.get(original().submission_id).jobId);
  assert.equal(await recoverPending({ sf, store: s, queue: q, now: NOW, log: () => {} }), 0, 'not queued twice');
  assert.equal(q.stats().queued, 1);
  assert.ok(logs[0].includes('recovered 1'));
});

test('a yearly-totals submission is rebuilt from the spend fields', async () => {
  const sf = salesforce('2026-10-06T19:00:00Z');
  const real = sf.sfQuery;
  sf.sfQuery = async (i, t, soql) => (/FROM Utility_Month__c/.test(soql) ? [] : real(i, t, soql));
  const [p] = await rebuildPending({ sf, now: NOW });
  assert.equal(p.mode, 'annual');
  assert.deepEqual(p.annual, { electric_cost: 31959.4, gas_cost: 6399.3 });
  assert.match(p.submission_id, /^[0-9a-f-]{36}$/);
});

test('nothing pending: nothing to do', async () => {
  const sf = { getSFToken: async () => ({ access_token: 'T', instance_url: 'u' }), sfQuery: async () => [] };
  assert.deepEqual(await rebuildPending({ sf, now: NOW }), []);
});

test('heating fuel is read back from the org picklist: "Gas" becomes gas, "Other" or blank becomes none', async () => {
  const mk = fuel => { const sf = salesforce('2026-10-06T19:00:00Z'); const q = sf.sfQuery;
    sf.sfQuery = async (i, t, soql) => { const r = await q(i, t, soql); if (/FROM Buildings__c/.test(soql)) r[0].Client_Heating_Fuel__c = fuel; return r; };
    return sf; };
  for (const [stored, expected] of [['Gas', 'gas'], ['Electric', 'electric'], ['Oil', 'oil'], ['Steam', 'steam'], ['gas', 'gas'], ['Other', 'none'], [null, 'none']]) {
    const [p] = await rebuildPending({ sf: mk(stored), now: NOW });
    assert.equal(p.facts.heating_fuel, expected, `stored ${stored}`);
  }
});
