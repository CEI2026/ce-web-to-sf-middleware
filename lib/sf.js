'use strict';
// ce-web-to-sf-middleware - lib/sf.js
// Salesforce helpers, ported VERBATIM from ce-solar-middleware v7.6 server.js
// (token cache, query/post/patch, contact + building helpers, file upload).
// Only additions: the require lines, sfCreateMany (new), and the exports.
const fetch = require('node-fetch');
const { SF_CLIENT_ID, SF_CLIENT_SECRET, SF_LOGIN_URL } = require('./config');

// ── TOKEN CACHE ───────────────────────────────────────────────
// Reuse access token until 5 min before expiry (~2hr window)
let _token = null;
let _tokenExpiry = 0;

async function getSFToken() {
  const now = Date.now();
  if (_token && now < _tokenExpiry) return _token;

  const params = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     SF_CLIENT_ID,
    client_secret: SF_CLIENT_SECRET,
  });
  const res = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Salesforce auth failed: ${err}`);
  }
  const data = await res.json();
  _token = data;
  _tokenExpiry = now + (110 * 60 * 1000); // cache for 110 min
  return _token;
}

// ── SF SOQL QUERY HELPER ──────────────────────────────────────
async function sfQuery(instanceUrl, accessToken, soql) {
  const encoded = encodeURIComponent(soql);
  const res = await fetch(
    `${instanceUrl}/services/data/v59.0/query?q=${encoded}`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  const body = await res.json();
  if (!res.ok) throw new Error(`SF Query failed: ${JSON.stringify(body)}`);
  return body.records; // array of SF records
}

// ── SF REST HELPERS ───────────────────────────────────────────
async function sfPost(instanceUrl, token, object, data) {
  const res = await fetch(
    `${instanceUrl}/services/data/v59.0/sobjects/${object}/`,
    {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    }
  );
  const body = await res.json();
  if (!res.ok) throw new Error(`SF POST ${object} failed: ${JSON.stringify(body)}`);
  return body;
}

async function sfPatch(instanceUrl, token, object, id, data) {
  const res = await fetch(
    `${instanceUrl}/services/data/v59.0/sobjects/${object}/${id}`,
    {
      method:  'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    }
  );
  if (res.status === 204) return { success: true };
  const body = await res.json();
  if (!res.ok) throw new Error(`SF PATCH ${object} failed: ${JSON.stringify(body)}`);
  return body;
}

// ── SUBMISSION ID ─────────────────────────────────────────────
function generateSubmissionId() {
  const now  = new Date();
  const pad  = n => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
  const rand = Math.random().toString(36).substr(2, 6).toUpperCase();
  return `SA-${date}-${rand}`;
}

// ── FIND OR CREATE CONTACT ────────────────────────────────────
//  Looks up a Contact by email address scoped to the given SF Account.
//  If found:  patches Phone and Title if those fields are currently blank.
//  If not found: creates a new Contact linked to the Account.
//  IMPORTANT: Always pass accountId to prevent NPSP from auto-creating
//             a Household account for the contact.
//  Returns the Contact Id (string).
async function findOrCreateContact(instanceUrl, token, accountId, contact) {
  const email = (contact.email || '').trim();
  if (!email) {
    console.warn('findOrCreateContact: no email provided, skipping contact upsert');
    return null;
  }

  // Escape single quotes for SOQL safety
  const safeEmail     = email.replace(/'/g, "\\'");
  const safeAccountId = (accountId || '').replace(/'/g, "\\'");

  // 1. Look for existing Contact with this email linked to this Account
  const soql = `
    SELECT Id, FirstName, LastName, Phone, Title
    FROM Contact
    WHERE Email = '${safeEmail}'
    AND AccountId = '${safeAccountId}'
    AND IsDeleted = false
    LIMIT 1
  `.trim();

  let existing;
  try {
    const records = await sfQuery(instanceUrl, token, soql);
    existing = records && records.length > 0 ? records[0] : null;
  } catch (err) {
    console.error('findOrCreateContact: query error:', err.message);
    existing = null;
  }

  if (existing) {
    // Contact found — patch Phone and Title only if currently blank
    const updates = {};
    if (!existing.Phone && contact.phone) updates.Phone = contact.phone;
    if (!existing.Title && contact.title) updates.Title = contact.title;

    if (Object.keys(updates).length > 0) {
      try {
        await sfPatch(instanceUrl, token, 'Contact', existing.Id, updates);
        console.log(`Contact ${existing.Id} updated:`, updates);
      } catch (err) {
        // Non-fatal: log and continue; contact was found, link will still work
        console.error(`Contact patch failed for ${existing.Id}:`, err.message);
      }
    } else {
      console.log(`Contact ${existing.Id} found, no updates needed`);
    }

    return existing.Id;
  }

  // 2. Contact not found — create a new one linked to the Account
  const newContact = {
    AccountId:  accountId,            // links to Catholic Entity; prevents NPSP household creation
    FirstName:  contact.firstname || '',
    LastName:   contact.lastname  || 'Unknown',
    Email:      email,
    Phone:      contact.phone    || '',
    Title:      contact.title    || '',
  };

  try {
    const result = await sfPost(instanceUrl, token, 'Contact', newContact);
    console.log(`Contact created: ${result.id} for account ${accountId}`);
    return result.id;
  } catch (err) {
    // Non-fatal: log and return null; building record will be written without contact link
    console.error('findOrCreateContact: create failed:', err.message);
    return null;
  }
}

// ── FIND EXISTING BUILDING ────────────────────────────────────
//  Duplicate guard: before creating a manually-added building,
//  check whether one with the same Name already exists under this Account.
//  Returns the existing Building Id if found, null otherwise.
async function findExistingBuilding(instanceUrl, token, accountId, buildingName) {
  const safeName      = (buildingName || '').replace(/'/g, "\\'");
  const safeAccountId = (accountId || '').replace(/'/g, "\\'");

  const soql = `
    SELECT Id, Name
    FROM Buildings__c
    WHERE Account__c = '${safeAccountId}'
    AND Name = '${safeName}'
    AND IsDeleted = false
    LIMIT 1
  `.trim();

  try {
    const records = await sfQuery(instanceUrl, token, soql);
    if (records && records.length > 0) {
      console.log(`Duplicate guard: found existing building ${records[0].Id} for "${buildingName}"`);
      return records[0].Id;
    }
  } catch (err) {
    console.error('findExistingBuilding: query error:', err.message);
  }
  return null;
}

// v7.6: single-file upload that REPORTS failure (the screening form's
// one-bill-per-request path must know when a bill did not save).
async function uploadOneFileToSF(instanceUrl, token, buildingId, file) {
  const cv = await sfPost(instanceUrl, token, 'ContentVersion', {
    Title: file.name, PathOnClient: file.name, VersionData: file.data, IsMajorVersion: true,
  });
  const r = await fetch(
    `${instanceUrl}/services/data/v59.0/sobjects/ContentVersion/${cv.id}?fields=ContentDocumentId`,
    { headers: { 'Authorization': `Bearer ${token}` } });
  if (!r.ok) throw new Error(`ContentVersion read failed (${r.status})`);
  const docId = (await r.json()).ContentDocumentId;
  await sfPost(instanceUrl, token, 'ContentDocumentLink', {
    ContentDocumentId: docId, LinkedEntityId: buildingId, ShareType: 'V', Visibility: 'AllUsers',
  });
}

async function sfGetFields(instanceUrl, token, obj, id, fields) {
  const r = await fetch(
    `${instanceUrl}/services/data/v59.0/sobjects/${obj}/${id}?fields=${fields.join(',')}`,
    { headers: { 'Authorization': `Bearer ${token}` } });
  if (!r.ok) throw new Error(`SF GET ${obj} failed (${r.status})`);
  return r.json();
}

// ── UPLOAD FILES TO SALESFORCE ────────────────────────────────
// Creates ContentVersion (file) + ContentDocumentLink (links to building)
async function uploadFilesToSF(instanceUrl, token, buildingId, files) {
  for (const file of files || []) {
    try {
      const cv = await sfPost(instanceUrl, token, 'ContentVersion', {
        Title:          file.name,
        PathOnClient:   file.name,
        VersionData:    file.data,  // base64 encoded
        IsMajorVersion: true,
      });

      const r = await fetch(
        `${instanceUrl}/services/data/v59.0/sobjects/ContentVersion/${cv.id}?fields=ContentDocumentId`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const cvData = await r.json();
      const docId  = cvData.ContentDocumentId;

      await sfPost(instanceUrl, token, 'ContentDocumentLink', {
        ContentDocumentId: docId,
        LinkedEntityId:    buildingId,
        ShareType:         'V',
        Visibility:        'AllUsers',
      });

      console.log(`Uploaded ${file.name} → Building ${buildingId}`);
    } catch (err) {
      console.error(`File upload failed for ${file.name}:`, err.message);
      // Non-fatal — continue with other files
    }
  }
}

// NEW (Instant Audit): create many records in one request (sObject Collections, max 200).
async function sfCreateMany(instanceUrl, token, object, records) {
  const res = await fetch(`${instanceUrl}/services/data/v59.0/composite/sobjects`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ allOrNone: true, records: records.map(r => ({ attributes: { type: object }, ...r })) }),
  });
  const body = await res.json();
  if (!res.ok || (Array.isArray(body) && body.some(x => x.success === false))) {
    throw new Error(`SF bulk create ${object} failed: ${JSON.stringify(body)}`);
  }
  return body;
}

module.exports = {
  getSFToken, sfQuery, sfPost, sfPatch, sfGetFields, sfCreateMany,
  generateSubmissionId, findOrCreateContact, findExistingBuilding,
  uploadFilesToSF, uploadOneFileToSF,
};
