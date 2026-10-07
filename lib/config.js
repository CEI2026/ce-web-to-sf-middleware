'use strict';
// ce-web-to-sf-middleware - lib/config.js
// Ported VERBATIM from ce-solar-middleware v7.6 server.js (lines 41-74).
// New-app settings (Instant Audit, Freddie relay) live in lib/instant/config.js.

// ── CONFIG ────────────────────────────────────────────────────
const SF_CLIENT_ID     = process.env.SF_CLIENT_ID;
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET;
const SF_LOGIN_URL     = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
const PORT             = process.env.PORT || 3000;

// ── v7 CONFIG: NEW ACCOUNT REGISTRATION ───────────────────────
//  Master switch. While FALSE:
//    • POST /accounts returns 503 (disabled)
//    • GET  /accounts does NOT filter by status (identical to v6 behavior)
//  Flip to 'true' in Heroku Config Vars ONLY after the CE Salesforce admin has created the
//  fields below and granted Create-on-Account to the integration user.
const NEW_ACCOUNTS_ENABLED = process.env.NEW_ACCOUNTS_ENABLED === 'true';

//  DEMO MODE: simulate registration + demo-account submissions with NO Salesforce write.
//  Lets the full new-org flow be demoed live (Netlify form or Squarespace embed) with no
//  schema/permission dependencies. Real accounts & submissions are UNAFFECTED while it's on
//  (only ids starting 'DEMOACCT' are simulated). TURN OFF after the demo.
const DEMO_MODE = process.env.DEMO_MODE === 'true';

//  Account field API names — must match the CE Salesforce admin's SF setup EXACTLY.
const F_DENOMINATION   = 'Denomination__c';    // picklist: Catholic; Non-Catholic
const F_ACCOUNT_STATUS = 'Status__c';           // picklist: Active; In Review (repurposed existing field)
const ACCOUNT_STATUS_IN_REVIEW = 'In Review';

//  Record type + placeholder EI for web-created accounts.
const ORG_RECORD_TYPE_ID = '01241000000WsNCAA0'; // Account "Organization" record type
//  One EI record ("Unknown / Not Yet Verified") the CE Salesforce admin creates; used when the
//  affiliation is unknown or the org is non-Catholic. Blank ('') = store null.
const EI_UNKNOWN_ID = process.env.EI_UNKNOWN_ID || 'a1aJx00000X6M65IAF';  // "Not Applicable" EI record

//  EI object API name. the CE Salesforce admin renamed it to the correct spelling; parameterized
//  via EI_OBJECT so any future rename is a Config Var flip, not a code deploy.
const EI_OBJECT = process.env.EI_OBJECT || 'Ecclesiastical_Institution__c';

module.exports = {
  SF_CLIENT_ID, SF_CLIENT_SECRET, SF_LOGIN_URL, PORT,
  NEW_ACCOUNTS_ENABLED, DEMO_MODE,
  F_DENOMINATION, F_ACCOUNT_STATUS, ACCOUNT_STATUS_IN_REVIEW,
  ORG_RECORD_TYPE_ID, EI_UNKNOWN_ID, EI_OBJECT,
};
