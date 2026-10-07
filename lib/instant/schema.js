'use strict';
// ce-web-to-sf-middleware - lib/instant/schema.js
// Allowed values, and every Salesforce API name Instant Audit uses (CR-S3).
// If the CE Salesforce admin confirms different API names, change them HERE only.

const BUILDING_TYPES = {            // payload value -> Client_Building_Type__c picklist label
  'worship': 'Worship',
  'school': 'School',
  'office-chancery': 'Office or chancery',
  'residence': 'Residence',
  'hall-gym': 'Hall or gym',
  'mixed': 'Mixed use',
};
const HEATING_FUELS = ['gas', 'electric', 'oil', 'steam', 'none'];
const REASONS = {                   // payload value -> Client_Reasons_To_Look__c picklist label
  capital: 'Equipment replacement or renovation is planned or needed',
  comfort: 'Ongoing comfort, equipment or high-bill complaints',
  deadline: 'A grant, requirement or budget deadline applies',
};
const FUELS = { electric: 'Electric', gas: 'Natural gas', other: 'Other' };   // Fuel__c
const UNITS = { kwh: 'kWh', therms: 'therms', ccf: 'ccf' };                  // Usage_Unit__c
const LIGHTS = { green: 'Green', yellow: 'Yellow', red: 'Red' };             // Screening_Light__c
const BASIS = { client_entered: 'Client entered figures', annual_figure: 'Annual figure only' };

const STATUS = { pending: 'Instant audit pending', completed: 'Instant audit completed' };

const SF = {
  monthObject: 'Utility_Month__c',
  month: {
    building: 'Building__c', fuel: 'Fuel__c', accountLabel: 'Account_Label__c',
    period: 'Period_Month__c', usage: 'Usage__c', unit: 'Usage_Unit__c', cost: 'Cost__c',
    source: 'Source__c', submissionId: 'Submission_Id__c', enteredAt: 'Entered_At__c',
  },
  sourceClientEntered: 'Client entered',
  building: {
    sqft: 'Client_SQFT__c', confirmedCounty: 'Client_Confirmed_County_SQFT__c',
    heatingFuel: 'Client_Heating_Fuel__c', type: 'Client_Building_Type__c',
    reasons: 'Client_Reasons_To_Look__c', sharedNote: 'Client_Shared_Meter_Note__c',
    electricSpend: 'Client_Electric_Spend__c', gasSpend: 'Client_Gas_Spend__c',
    contact: 'Building_Contact__c', status: 'Screening_Status__c',
    light: 'Screening_Light__c', headline: 'Screening_Headline__c',
    annualSpend: 'Screening_Annual_Spend__c', basis: 'Screening_Basis__c',
    assumptions: 'Screening_Assumptions_Version__c', resultAt: 'Screening_Result_At__c',
  },
};

module.exports = { BUILDING_TYPES, HEATING_FUELS, REASONS, FUELS, UNITS, LIGHTS, BASIS, STATUS, SF };
