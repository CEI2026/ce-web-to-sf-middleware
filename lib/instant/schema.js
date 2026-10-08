'use strict';
// ce-web-to-sf-middleware - lib/instant/schema.js
// Allowed values, and every Salesforce API name Instant Audit uses (CR-S3).
// Matched to the org as built (read from Salesforce 2026-10-07): API names and picklist values are copied
// exactly, including capitalisation, because records come back under their canonical names.
// If the CE Salesforce admin changes anything, change it HERE only (test/instant-org-contract.test.js pins it).

const BUILDING_TYPES = {            // payload value -> Client_building_type__c picklist label
  'worship': 'Worship',
  'school': 'School',
  'office-chancery': 'Office or Chancery',
  'residence': 'Residence',
  'hall-gym': 'Hall or Gym',
  'mixed': 'Mixed Use',
};
const HEATING_FUELS = ['gas', 'electric', 'oil', 'steam', 'none'];
const REASONS = {                   // payload value -> Client_Reasons_to_Look__c picklist label
  capital: 'Equipment replacement or renovation is planned or needed',
  comfort: 'Ongoing comfort, equipment or high-bill complaints',
  deadline: 'A grant, requirement or budget deadline applies',
};
const HEATING_FUEL_LABELS = { gas: 'Gas', electric: 'Electric', oil: 'Oil', steam: 'Steam' };   // Client_Heating_Fuel__c picklist values ("none" has none)
const FUELS = { electric: 'Electric', gas: 'Natural gas', other: 'Other' };   // Fuel__c
const UNITS = { kwh: 'kWh', therms: 'therms', ccf: 'ccf' };                  // Usage_Unit__c
const LIGHTS = { green: 'Green', yellow: 'Yellow', red: 'Red' };             // Screening_Light__c
const BASIS = { client_entered: 'Client Entered Figures', annual_figure: 'Annual Figure Only' };

const STATUS = { pending: 'Instant Audit Pending', completed: 'Instant Audit Completed' };

const SF = {
  monthObject: 'Utility_Month__c',
  month: {
    building: 'Building__c', fuel: 'Fuel__c', accountLabel: 'Account_label__c',
    period: 'Period_Month__c', usage: 'Usage__c', unit: 'Usage_Unit__c', cost: 'Cost__c',
    source: 'Source__c', submissionId: 'Submission_ID__c', enteredAt: 'Entered_At__c',
  },
  sourceClientEntered: 'Client Entered',   // Source__c picklist: Client Entered, Bill Read (set by the admin 2026-10-07)
  building: {
    sqft: 'Client_SQFT__c', confirmedCounty: 'Client_Confirmed_County_SQFT__c',
    heatingFuel: 'Client_Heating_Fuel__c', type: 'Client_building_type__c',
    reasons: 'Client_Reasons_to_Look__c', sharedNote: 'Client_Shared_Meter_Note__c',
    electricSpend: 'Client_Electric_Spend__c', gasSpend: 'Client_Gas_Spend__c',
    contact: 'Building_Contact__c', status: 'Screening_Status__c',
    light: 'Screening_Light__c', headline: 'Screening_Headline__c',
    annualSpend: 'Screening_Annual_Spend__c', basis: 'Screening_Basis__c',
    assumptions: 'Screening_Assumptions_Version__c', resultAt: 'Screening_Result_At__c',
  },
};

module.exports = { BUILDING_TYPES, HEATING_FUELS, HEATING_FUEL_LABELS, REASONS, FUELS, UNITS, LIGHTS, BASIS, STATUS, SF };
