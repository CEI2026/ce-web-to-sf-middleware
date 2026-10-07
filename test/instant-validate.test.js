'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('../lib/instant/validate');
const { fx } = require('./helpers');

const good = () => fx('submission_chancery_12_months.json');
const fields = r => r.errors.map(e => e.field);

test('the 12-month sample is accepted and totalled', () => {
  const r = validate(good());
  assert.equal(r.ok, true);
  assert.equal(r.totals.electricMonths, 12);
  assert.ok(Math.abs(r.totals.totalCost - 38358.7) < 0.01);
  assert.ok(Math.abs(r.totals.electricSpend - 31959.4) < 0.01);
});

test('the 8-month and small-site samples are accepted', () => {
  assert.equal(validate(fx('submission_partial_8_months.json')).ok, true);
  assert.equal(validate(fx('submission_small_parish.json')).ok, true);
});

test('errors name the field and use the plain wording of the sample error file', () => {
  const p = good();
  p.facts.sqft_total = 'abc';
  p.accounts[0].rows[3].usage = 'x';
  p.contact.email = 'nope';
  const r = validate(p);
  assert.equal(r.ok, false);
  const want = fx('response_validation_error.json').errors;
  for (const w of want) assert.ok(r.errors.some(e => e.field === w.field && e.message === w.message), `missing ${w.field}`);
});

test('fewer than six electric months is refused', () => {
  const p = good(); p.accounts[0].rows = p.accounts[0].rows.slice(0, 5);
  const r = validate(p);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.field === 'accounts' && /six|6/.test(e.message)));
});

test('gas is optional', () => {
  const p = good(); p.accounts = [p.accounts[0]]; p.facts.heating_fuel = 'electric';
  assert.equal(validate(p).ok, true);
});

test('bad values are refused one by one', () => {
  const cases = [
    ['negative cost', p => { p.accounts[0].rows[0].cost = -1; }, 'accounts[0].rows[0].cost'],
    ['usage too large', p => { p.accounts[0].rows[0].usage = 1e9; }, 'accounts[0].rows[0].usage'],
    ['duplicate month', p => { p.accounts[0].rows[1].month = p.accounts[0].rows[0].month; }, 'accounts[0].rows[1].month'],
    ['bad month', p => { p.accounts[0].rows[0].month = '2025-13'; }, 'accounts[0].rows[0].month'],
    ['missing cost', p => { delete p.accounts[0].rows[0].cost; }, 'accounts[0].rows[0].cost'],
    ['electric in therms', p => { p.accounts[0].unit = 'therms'; }, 'accounts[0].unit'],
    ['gas in kwh', p => { p.accounts[1].unit = 'kwh'; }, 'accounts[1].unit'],
    ['unknown fuel', p => { p.accounts[1].fuel = 'coal'; }, 'accounts[1].fuel'],
    ['unknown building type', p => { p.facts.building_type = 'castle'; }, 'facts.building_type'],
    ['unknown heating fuel', p => { p.facts.heating_fuel = 'wood'; }, 'facts.heating_fuel'],
    ['unknown reason', p => { p.facts.reasons = ['fun']; }, 'facts.reasons'],
    ['sqft zero', p => { p.facts.sqft_total = 0; }, 'facts.sqft_total'],
    ['sqft fraction', p => { p.facts.sqft_total = 1500.5; }, 'facts.sqft_total'],
    ['sqft huge', p => { p.facts.sqft_total = 6000000; }, 'facts.sqft_total'],
    ['no consent', p => { p.consent = false; }, 'consent'],
    ['bad id', p => { p.submission_id = 'abc'; }, 'submission_id'],
    ['bad building id', p => { p.building.building_id = "a1O'; DROP"; }, 'building.building_id'],
    ['bad zip', p => { p.building.zip = '3790'; }, 'building.zip'],
    ['no name', p => { p.contact.name = ' '; }, 'contact.name'],
    ['bad mode', p => { p.mode = 'weekly'; }, 'mode'],
    ['long note', p => { p.facts.shared_meter_note = 'x'.repeat(256); }, 'facts.shared_meter_note'],
  ];
  for (const [name, mutate, field] of cases) {
    const p = good(); mutate(p);
    const r = validate(p);
    assert.equal(r.ok, false, name);
    assert.ok(fields(r).includes(field), `${name}: expected ${field}, got ${fields(r)}`);
  }
});

test('too many accounts or rows is refused', () => {
  const p = good();
  p.accounts = Array.from({ length: 7 }, (_, i) => ({ ...p.accounts[0], label: `E${i}` }));
  assert.equal(validate(p).ok, false);
  const q = good();
  q.accounts[0].rows = Array.from({ length: 25 }, (_, i) => ({ month: `${2024 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`, usage: 1, cost: 1 }));
  assert.ok(fields(validate(q)).includes('accounts[0].rows'));
});

test('the hidden field catches bots', () => {
  const p = good(); p.website = 'http://spam.example';
  const r = validate(p);
  assert.equal(r.ok, false); assert.equal(r.honeypot, true);
});

test('yearly totals mode', () => {
  const p = good(); delete p.accounts; p.mode = 'annual'; p.annual = { electric_cost: 21300, gas_cost: 4000 };
  const r = validate(p);
  assert.equal(r.ok, true); assert.equal(r.totals.totalCost, 25300);
  p.annual = { electric_cost: 0, gas_cost: 0 };
  assert.equal(validate(p).ok, false);
  p.annual = { electric_cost: 'a' };
  assert.equal(validate(p).ok, false);
});

test('the input is never corrected: a clean copy is returned, the original is untouched', () => {
  const p = good(); p.contact.name = '  Test Contact  ';
  const r = validate(p);
  assert.equal(r.clean.contact.name, 'Test Contact');
  assert.equal(p.contact.name, '  Test Contact  ');
});

test('non-objects are refused', () => {
  for (const x of [null, undefined, 5, 'x', []]) assert.equal(validate(x).ok, false);
});
