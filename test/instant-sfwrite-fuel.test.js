'use strict';
// The heating-fuel values written to Salesforce must be the org's picklist values (Gas, Electric, Oil, Steam).
const test = require('node:test');
const assert = require('node:assert/strict');
const { fx } = require('./helpers');
const { validate } = require('../lib/instant/validate');
const { buildingPatch } = require('../lib/instant/sfwrite');

const patch = fuel => {
  const p = fx('submission_chancery_12_months.json'); p.facts.heating_fuel = fuel;
  const v = validate(p); assert.ok(v.ok, JSON.stringify(v.errors));
  return buildingPatch(v.clean, { electricSpend: 1, gasSpend: 1 }, null);
};

test('each heating fuel is written as the picklist value', () => {
  assert.equal(patch('gas').Client_Heating_Fuel__c, 'Gas');
  assert.equal(patch('electric').Client_Heating_Fuel__c, 'Electric');
  assert.equal(patch('oil').Client_Heating_Fuel__c, 'Oil');
  assert.equal(patch('steam').Client_Heating_Fuel__c, 'Steam');
});

test('"none" is written blank, never as a value the picklist does not have', () => {
  assert.equal(patch('none').Client_Heating_Fuel__c, null);
});
