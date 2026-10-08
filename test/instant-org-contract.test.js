'use strict';
// What Instant Audit writes must match the Salesforce org exactly. These values were read from the org
// (describe of Buildings__c and Utility_Month__c) on 2026-10-07. If the admin changes a name or a picklist
// value, this test fails and schema.js is the one place to update.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/instant/schema');

test('Utility_Month__c API names and picklist values', () => {
  assert.equal(S.SF.monthObject, 'Utility_Month__c');
  assert.deepEqual(S.SF.month, {
    building: 'Building__c', fuel: 'Fuel__c', accountLabel: 'Account_label__c', period: 'Period_Month__c',
    usage: 'Usage__c', unit: 'Usage_Unit__c', cost: 'Cost__c', source: 'Source__c',
    submissionId: 'Submission_ID__c', enteredAt: 'Entered_At__c',
  });
  assert.deepEqual(Object.values(S.FUELS).sort(), ['Electric', 'Natural gas', 'Other']);          // Fuel__c
  assert.deepEqual(Object.values(S.UNITS).sort(), ['ccf', 'kWh', 'therms']);                       // Usage_Unit__c (also Other)
  assert.equal(S.SF.sourceClientEntered, 'Client Entered');   // Source__c picklist: Client Entered, Bill Read
});

test('Buildings__c API names', () => {
  assert.deepEqual(S.SF.building, {
    sqft: 'Client_SQFT__c', confirmedCounty: 'Client_Confirmed_County_SQFT__c', heatingFuel: 'Client_Heating_Fuel__c',
    type: 'Client_building_type__c', reasons: 'Client_Reasons_to_Look__c', sharedNote: 'Client_Shared_Meter_Note__c',
    electricSpend: 'Client_Electric_Spend__c', gasSpend: 'Client_Gas_Spend__c', contact: 'Building_Contact__c',
    status: 'Screening_Status__c', light: 'Screening_Light__c', headline: 'Screening_Headline__c',
    annualSpend: 'Screening_Annual_Spend__c', basis: 'Screening_Basis__c', assumptions: 'Screening_Assumptions_Version__c',
    resultAt: 'Screening_Result_At__c',
  });
});

test('Buildings__c picklist values', () => {
  assert.deepEqual(Object.values(S.BUILDING_TYPES).sort(), ['Hall or Gym', 'Mixed Use', 'Office or Chancery', 'Residence', 'School', 'Worship']);
  assert.deepEqual(Object.values(S.REASONS).sort(), [
    'A grant, requirement or budget deadline applies',
    'Equipment replacement or renovation is planned or needed',
    'Ongoing comfort, equipment or high-bill complaints']);
  assert.deepEqual(Object.values(S.LIGHTS).sort(), ['Green', 'Red', 'Yellow']);                    // org also has Insufficient
  assert.deepEqual(Object.values(S.BASIS).sort(), ['Annual Figure Only', 'Client Entered Figures']); // org also has Bills Read
  assert.deepEqual(S.STATUS, { pending: 'Instant Audit Pending', completed: 'Instant Audit Completed' });
  assert.deepEqual(S.HEATING_FUEL_LABELS, { gas: 'Gas', electric: 'Electric', oil: 'Oil', steam: 'Steam' });
});
