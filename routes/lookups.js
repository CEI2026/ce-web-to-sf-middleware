'use strict';
// ce-web-to-sf-middleware - routes/lookups.js
// GET /accounts, GET /buildings, GET /institutions, POST /accounts.
// Handler code ported VERBATIM from ce-solar-middleware v7.6 server.js.
module.exports = function registerLookups(app, { getSFToken, sfQuery, sfPost, config }) {
  const { NEW_ACCOUNTS_ENABLED, DEMO_MODE, F_DENOMINATION, F_ACCOUNT_STATUS,
          ACCOUNT_STATUS_IN_REVIEW, ORG_RECORD_TYPE_ID, EI_UNKNOWN_ID, EI_OBJECT } = config;

// ── GET /accounts?zip=XXXXX ───────────────────────────────────
//  Returns accounts whose BillingPostalCode matches the ZIP.
//  Form uses this to populate the account picker on Step 1.
app.get('/accounts', async (req, res) => {
  const zip = (req.query.zip || '').trim();
  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: 'zip must be a 5-digit US ZIP code' });
  }

  try {
    const { access_token, instance_url } = await getSFToken();

    // Hide "In Review" accounts once registration is live. In SOQL, != excludes
    // 'In Review' but INCLUDES nulls, so existing accounts need no backfill.
    const statusFilter = NEW_ACCOUNTS_ENABLED
      ? `AND ${F_ACCOUNT_STATUS} != '${ACCOUNT_STATUS_IN_REVIEW}'`
      : '';
    const soql = `
      SELECT Id, Name, BillingStreet, BillingCity, BillingState, BillingPostalCode
      FROM Account
      WHERE BillingPostalCode LIKE '${zip}%'
      AND IsDeleted = false
      ${statusFilter}
      ORDER BY Name
      LIMIT 50
    `.trim();

    const records = await sfQuery(instance_url, access_token, soql);

    const accounts = records.map(r => {
      const parts = [r.BillingStreet, r.BillingCity, r.BillingState, r.BillingPostalCode].filter(Boolean);
      return { id: r.Id, name: r.Name, address: parts.join(', ') };
    });

    res.json({ accounts });

  } catch (err) {
    console.error('/accounts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /buildings?accountId=XXXXX ───────────────────────────
//  Returns Buildings__c records linked to the given Account Id.
//  Form uses this to populate the building checklist on Step 2.
app.get('/buildings', async (req, res) => {
  const accountId = (req.query.accountId || '').trim();
  if (!accountId) {
    return res.status(400).json({ error: 'accountId is required' });
  }

  try {
    const { access_token, instance_url } = await getSFToken();

    const soql = `
      SELECT Id, Name, Full_Address__c, Building_Type__c, SQFT__c, SQFT_Found_in_County_Data__c
      FROM Buildings__c
      WHERE Account__c = '${accountId}'
      AND IsDeleted = false
      ORDER BY Name
      LIMIT 200
    `.trim();

    const records = await sfQuery(instance_url, access_token, soql);

    const buildings = records.map(r => ({
      id:      r.Id,
      name:    r.Name,
      address: r.Full_Address__c || '',
      type:    r.Building_Type__c || '',
      sqft:    (typeof r.SQFT__c === 'number') ? r.SQFT__c : null,
      sqft_county: !!r.SQFT_Found_in_County_Data__c,
    }));

    res.json({ buildings });

  } catch (err) {
    console.error('/buildings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /institutions ─────────────────────────────────────────
//  Active Ecclesiastical Institutions (dioceses / religious orders) for the
//  "Is this a Catholic institution?" affiliation picker on registration.
app.get('/institutions', async (req, res) => {
  try {
    const { access_token, instance_url } = await getSFToken();
    const soql = `
      SELECT Id, Name, Institution_Type__c
      FROM ${EI_OBJECT}
      WHERE Status__c != 'Merged'
      AND Status__c != 'Suppressed'
      AND IsDeleted = false
      ORDER BY Name
      LIMIT 1000
    `.trim();
    const records = await sfQuery(instance_url, access_token, soql);
    const institutions = records.map(r => ({
      id:   r.Id,
      name: r.Name,
      type: r.Institution_Type__c || '',
    }));
    res.json({ institutions });
  } catch (err) {
    console.error('/institutions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /accounts ────────────────────────────────────────────
//  Self-register a new organization. Created "In Review" so it stays
//  hidden from the ZIP picker until CE staff approve (flip to "Live").
//  Returns { id, name, address } so the form proceeds straight to buildings.
app.post('/accounts', async (req, res) => {
  const b = req.body || {};

  // DEMO MODE — simulate the create; no SF write, nothing to clean up afterward.
  if (DEMO_MODE) {
    const dName = (b.name || '').trim();
    if (!dName) return res.status(400).json({ error: 'Organization name is required.' });
    const demoId = 'DEMOACCT' + Date.now();
    const dAddr = [b.street, b.city, b.state, b.zip].filter(Boolean).join(', ');
    console.log(`\u26a0 DEMO MODE: simulated account "${dName}" -> ${demoId} (no SF write)`);
    return res.json({ success: true, id: demoId, name: dName, address: dAddr, status: 'In Review', demo: true });
  }

  if (!NEW_ACCOUNTS_ENABLED) {
    return res.status(503).json({ error: 'Account registration is not enabled yet.' });
  }
  try {
    const { access_token, instance_url } = await getSFToken();

    const name = (b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Organization name is required.' });

    const isCatholic = b.isCatholic === true || b.isCatholic === 'true';

    const DENOMINATIONS = ['Orthodox Christian','Protestant \u2013 Mainline','Protestant \u2013 Evangelical','Jewish','Muslim','Other'];
    const denomination = isCatholic ? 'Catholic'
      : (DENOMINATIONS.indexOf(b.denomination) >= 0 ? b.denomination : 'Other');

    const account = {
      Name:              name,
      RecordTypeId:      ORG_RECORD_TYPE_ID,
      AccountSource:     'Web',
      Type:              isCatholic ? 'Catholic Entity' : 'Non-Catholic Entity',
      BillingStreet:     b.street || '',
      BillingCity:       b.city   || '',
      BillingState:      b.state  || '',
      BillingPostalCode: b.zip    || '',
      [F_DENOMINATION]:   denomination,
      [F_ACCOUNT_STATUS]: ACCOUNT_STATUS_IN_REVIEW,
    };

    // Catholic affiliation → link the chosen Ecclesiastical Institution.
    // Unknown affiliation or non-Catholic → link the placeholder EI (if configured).
    if (isCatholic && b.institutionId) {
      account.Ecclesiastical_Institution__c = b.institutionId;
      if (b.institutionType) account.Ecclesiastical_Institution_Type__c = b.institutionType;
    } else if (EI_UNKNOWN_ID) {
      account.Ecclesiastical_Institution__c = EI_UNKNOWN_ID;
    }

    const result = await sfPost(instance_url, access_token, 'Account', account);
    const addr = [b.street, b.city, b.state, b.zip].filter(Boolean).join(', ');
    console.log(`New account (In Review): ${result.id} — "${name}" — ${denomination}`);

    res.json({ success: true, id: result.id, name, address: addr, status: ACCOUNT_STATUS_IN_REVIEW });
  } catch (err) {
    console.error('POST /accounts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
};
