// ce-web-to-sf-middleware - routes/screening.js (ported VERBATIM from ce-solar-middleware screening-request.js v1.3)
// Catholic Energies · Energy Screening (WS-D) · v1.2 · 2026-09-26
//
// POST /screening-request
//   Public Energy Screening form → Buildings__c (CR-S2 fields).
//   One submission = one institution, one contact, one or more buildings.
//   Each building gets the client's square footage, last year's spend,
//   optional details, an optional bill upload, and Screening_Status__c
//   = Requested. Freddie AI (read-only) fetches Requested rows; CE
//   staff run the screen there. This endpoint never scores anything.
//
// Doctrine: flag-don't-fix — invalid input is rejected with a plain
// message, never corrected. County SQFT__c is never overwritten; the
// client's figure goes to Client_SQFT__c. Data_Source__c on existing
// rows is left alone (it records where the row came from, not who
// touched it last); manually added rows carry Manual_Form_Submission
// exactly as the Solar Assessment Form writes them.
//
// Wiring (server.js):
//   require('./screening-request').register(app, {
//     getSFToken, sfPost, sfPatch, findOrCreateContact,
//     findExistingBuilding, uploadFilesToSF });
//
// Design authority: Desk Audit Design Revision 2 (ratified 2026-09-21).
//
// v1.1 (2026-09-26, first real client - Notre Dame HS, six meters):
//  - Screening unit: 'building' (default) or 'campus'. A campus entry
//    carries the total square footage of every building its bills
//    cover and must name those buildings (Client_Shared_Meter_Note__c).
//    Flags: screening_unit_campus; campus_coverage_unconfirmed when
//    the client did not confirm the bills cover the whole total.
//  - Contact names now reach Salesforce (the shared helper reads
//    firstname/lastname; v1.0 created contacts named "Unknown").
//  - Heating fuel "none" is not a Client_Heating_Fuel__c picklist
//    value: written as blank with flag heating_fuel_none.
//  - 503 "CR-S2 pending" only for a genuinely missing field; every
//    other Salesforce error is reported as itself.
//
// v1.2 (2026-09-26): one bill per request. The whole submission used to
// travel in one request, so several large scans could exceed Heroku's
// 30-second limit (and the 5 MB file cap). Now, with upload_mode
// 'separate':
//   1. POST /screening-request carries the building details and the
//      NAMES of the bills only. Buildings with bills are written with
//      Screening_Status__c blank (not yet fetchable) and get a signed,
//      2-hour upload token bound to building + submission.
//   2. POST /screening-file uploads ONE bill (up to 25 MB) per request;
//      a failure is returned, never swallowed.
//   3. POST /screening-complete sets Screening_Status__c = 'Requested'
//      and, if any bill failed, adds flag bills_upload_incomplete.
// Requests without upload_mode keep the v1.1 single-request behaviour.

'use strict';

const HEATING_FUELS = new Set(['gas', 'electric', 'oil', 'steam', 'none']);
const SCREENING_UNITS = new Set(['building', 'campus']);
const MAX_BUILDINGS = 25;
const MAX_FILES_PER_BUILDING = 36; // v1.3 2026-09-28: was 12; a two-fuel year is 24, three accounts 36
const MAX_FILE_B64_BYTES = 7 * 1024 * 1024; // ~5 MB binary, base64-encoded (v1.1 path)
const MAX_SEPARATE_BYTES = 25 * 1024 * 1024; // binary, one bill per request (v1.2)
const MAX_SEPARATE_B64 = Math.ceil(MAX_SEPARATE_BYTES / 3) * 4 + 4;
const UPLOAD_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const BILL_EXT = /\.(pdf|jpe?g|png)$/i;
const crypto = require('crypto');
const COUNTY_MISMATCH_RATIO = 2.0;

function isSfId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/.test(v);
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string') v = v.replace(/,/g, '').trim();
  const n = Number(v);
  return Number.isFinite(n) ? n : 'bad';
}

function str(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

// ── validation ────────────────────────────────────────────────
// Returns { ok:true, buildings:[normalized...] } or { ok:false, errors:[...] }
function validate(payload) {
  const separate = payload && payload.upload_mode === 'separate';
  const errors = [];
  const accountId = str(payload.sf_account_id, 18);
  if (!isSfId(accountId)) errors.push('Institution is not valid.');

  const contact = payload.contact || {};
  const email = str(contact.email, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('A valid email address is required.');
  if (!str(contact.first_name, 60) || !str(contact.last_name, 60)) errors.push('First and last name are required.');

  const raw = Array.isArray(payload.buildings) ? payload.buildings : [];
  if (!raw.length) errors.push('Select at least one building.');
  if (raw.length > MAX_BUILDINGS) errors.push(`At most ${MAX_BUILDINGS} buildings per submission.`);

  const buildings = [];
  raw.forEach((b, i) => {
    const label = str(b.building_name, 120) || `Building ${i + 1}`;
    const manual = !!b.manually_added || b.sf_building_id === 'NEW';
    if (!manual && !isSfId(b.sf_building_id)) errors.push(`${label}: building record is not valid.`);
    if (manual && (!str(b.building_name, 120) || !str(b.building_type, 40) || !str(b.building_address, 200)))
      errors.push(`${label}: an added building needs a name, a type, and a full address.`);

    const sqft = num(b.client_sqft);
    if (sqft === null || sqft === 'bad' || sqft <= 0) errors.push(`${label}: square footage is required.`);

    const elec = num(b.client_electric_spend), gas = num(b.client_gas_spend);
    if (elec === 'bad' || gas === 'bad') errors.push(`${label}: annual spend must be a number.`);
    if ((elec !== null && elec !== 'bad' && elec < 0) || (gas !== null && gas !== 'bad' && gas < 0))
      errors.push(`${label}: annual spend cannot be negative.`);
    const files = Array.isArray(b.bill_files) ? b.bill_files : [];
    if (elec === null && gas === null && !files.length)
      errors.push(`${label}: enter last year's energy spend, or attach energy bills, or both.`);
    if (files.length > MAX_FILES_PER_BUILDING) errors.push(`${label}: at most ${MAX_FILES_PER_BUILDING} bill files.`);
    files.forEach(f => {
      if (separate) {
        const size = Number(f && f.size);
        if (!f || !str(f.name, 200) || !BILL_EXT.test(str(f.name, 200))) errors.push(`${label}: a bill file is not a PDF, JPG or PNG.`);
        else if (!(size > 0)) errors.push(`${label}: ${f.name} is empty.`);
        else if (size > MAX_SEPARATE_BYTES) errors.push(`${label}: ${f.name} is larger than 25 MB.`);
      } else if (!f || typeof f.data !== 'string' || !str(f.name, 200)) errors.push(`${label}: a bill file is unreadable.`);
      else if (f.data.length > MAX_FILE_B64_BYTES) errors.push(`${label}: ${f.name} is larger than 5 MB.`);
    });

    const fuel = str(b.client_heating_fuel, 20).toLowerCase();
    if (fuel && !HEATING_FUELS.has(fuel)) errors.push(`${label}: heating fuel is not valid.`);
    const unit = str(b.screening_unit, 20).toLowerCase() || 'building';
    if (!SCREENING_UNITS.has(unit)) errors.push(`${label}: screening unit is not valid.`);
    if (unit === 'campus' && !str(b.client_shared_meter_note, 255))
      errors.push(`${label}: for a campus, name the buildings these bills cover.`);
    const occ = num(b.client_occupancy_hours_week);
    if (occ !== null && (occ === 'bad' || occ < 0 || occ > 168)) errors.push(`${label}: occupancy hours must be 0-168.`);

    const county = num(b.county_sqft_reference);
    const confirmedRaw = b.client_confirmed_county_sqft === true || String(b.client_confirmed_county_sqft) === '1' || String(b.client_confirmed_county_sqft) === 'true';
    const flags = [];
    if (unit === 'campus') {
      flags.push('screening_unit_campus');
      const covered = b.campus_coverage_confirmed === true || String(b.campus_coverage_confirmed) === 'true';
      if (!covered) flags.push('campus_coverage_unconfirmed');
    }
    if (fuel === 'none') flags.push('heating_fuel_none');
    let confirmed = confirmedRaw;
    if (typeof sqft === 'number' && typeof county === 'number' && county > 0) {
      if (confirmed && Math.abs(sqft - county) > 0.5) { confirmed = false; flags.push('county_confirmed_but_edited'); }
      if (!confirmed) {
        const ratio = sqft / county;
        if (ratio > COUNTY_MISMATCH_RATIO || ratio < 1 / COUNTY_MISMATCH_RATIO) flags.push('sqft_vs_county_mismatch');
      }
    } else if (confirmed) {
      confirmed = false; flags.push('county_confirmed_but_no_county_figure');
    }

    buildings.push({
      label, manual,
      sf_building_id: manual ? null : b.sf_building_id,
      name: str(b.building_name, 120),
      type: str(b.building_type, 40),
      address: str(b.building_address, 200),
      sqft: typeof sqft === 'number' ? sqft : null,
      confirmed,
      elec: typeof elec === 'number' ? elec : null,
      gas: typeof gas === 'number' ? gas : null,
      unit,
      fuel: fuel && fuel !== 'none' ? fuel[0].toUpperCase() + fuel.slice(1) : null,
      occ: typeof occ === 'number' ? occ : null,
      hvac: str(b.client_hvac_vintage, 200),
      sharedNote: str(b.client_shared_meter_note, 255),
      flags,
      files: files.map(f => ({ name: str(f.name, 200), type: str(f.type, 100), data: f.data })),
    });
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, separate, accountId, contact: {
    first_name: str(contact.first_name, 60), last_name: str(contact.last_name, 60),
    email, phone: str(contact.phone, 40), title: str(contact.role || contact.title, 80),
  }, buildings };
}

function screeningFields(b, nowIso, contactId, separate) {
  const f = {
    Client_SQFT__c:                  b.sqft,
    Client_Confirmed_County_SQFT__c: !!b.confirmed,
    Client_Electric_Spend__c:        b.elec,
    Client_Gas_Spend__c:             b.gas,
    Client_Heating_Fuel__c:          b.fuel,
    Client_Occupancy_Hours_Week__c:  b.occ,
    Client_HVAC_Vintage__c:          b.hvac || null,
    Client_Shared_Meter_Note__c:     b.sharedNote || null,
    Screening_Intake_Flags__c:       b.flags.join(';') || null,
    // v1.2: a building whose bills upload separately is not fetchable
    // until /screening-complete - Freddie never lands a half upload.
    Screening_Status__c:             separate && b.files.length ? null : 'Requested',
    Screening_Requested_At__c:       nowIso,
    Bill_Count__c:                   b.files.length,
    Bill_Filenames__c:               b.files.map(x => x.name).join(', ') || 'None',
  };
  if (contactId) f.Building_Contact__c = contactId;
  return f;
}

// ---- v1.2 upload tokens: HMAC(building|submission|expiry) ------------
function signUpload(secret, buildingId, sid, now = Date.now()) {
  const exp = now + UPLOAD_TOKEN_TTL_MS;
  const mac = crypto.createHmac('sha256', secret).update(`${buildingId}|${sid}|${exp}`).digest('hex');
  return `${exp}.${mac}`;
}
function checkUpload(secret, buildingId, sid, token, now = Date.now()) {
  const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(String(token || ''));
  if (!m || Number(m[1]) < now) return false;
  const want = crypto.createHmac('sha256', secret).update(`${buildingId}|${sid}|${m[1]}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(want, 'hex'), Buffer.from(m[2], 'hex'));
}

function submissionId() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `ES-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function register(app, deps) {
  app.post('/screening-request', async (req, res) => {
    const { getSFToken, sfPost, sfPatch, findOrCreateContact, findExistingBuilding, uploadFilesToSF } = deps;
    const v = validate(req.body || {});
    if (!v.ok) return res.status(400).json({ success: false, errors: v.errors });

    const sid = submissionId();
    const nowIso = new Date().toISOString();
    try {
      const { access_token, instance_url } = await getSFToken();
      // The shared helper (server.js, also used by the Solar Assessment
      // Form) reads firstname/lastname.
      const contactId = await findOrCreateContact(instance_url, access_token, v.accountId, {
        firstname: v.contact.first_name, lastname: v.contact.last_name,
        email: v.contact.email, phone: v.contact.phone, title: v.contact.title });
      const results = [];

      for (const b of v.buildings) {
        const fields = screeningFields(b, nowIso, contactId, v.separate);
        let buildingId, action;
        if (b.manual) {
          const existing = await findExistingBuilding(instance_url, access_token, v.accountId, b.name);
          if (existing) {
            await sfPatch(instance_url, access_token, 'Buildings__c', existing, fields);
            buildingId = existing; action = 'patched-existing';
          } else {
            const rec = await sfPost(instance_url, access_token, 'Buildings__c', {
              Name: b.name, Account__c: v.accountId,
              Building_Type__c: b.type, Full_Address__c: b.address,
              Manually_Added_Building__c: true, QA_Status__c: 'PENDING',
              Data_Source__c: 'Manual_Form_Submission',
              ...fields,
            });
            buildingId = rec.id; action = 'created';
          }
        } else {
          await sfPatch(instance_url, access_token, 'Buildings__c', b.sf_building_id, fields);
          buildingId = b.sf_building_id; action = 'updated';
        }
        const rec = { building: b.label, action, buildingId, unit: b.unit, files: b.files.length, flags: b.flags };
        if (v.separate && b.files.length) {
          rec.uploadToken = signUpload(deps.uploadSecret, buildingId, sid);
          rec.maxFileBytes = MAX_SEPARATE_BYTES;
        } else if (b.files.length) {
          await uploadFilesToSF(instance_url, access_token, buildingId, b.files);
        }
        results.push(rec);
      }

      console.log(`[${sid}] screening-request complete: ${results.map(r => `${r.building}→${r.action}`).join(', ')}`);
      res.json({ success: true, submissionId: sid, records: results });
    } catch (err) {
      const msg = String(err && err.message || err);
      console.error(`[${sid}] /screening-request error:`, msg);
      if (/INVALID_FIELD|No such column/.test(msg)) {
        return res.status(503).json({ success: false,
          error: 'Screening fields are not yet available in Salesforce (CR-S2 pending).' });
      }
      res.status(500).json({ success: false, error: msg });
    }
  });

  // ---- v1.2: one bill per request --------------------------------------
  function authUpload(body) {
    const buildingId = str(body.building_id, 18), sid = str(body.submission_id, 40);
    if (!isSfId(buildingId) || !/^ES-\d{8}-[A-Z0-9]{6}$/.test(sid)) return null;
    if (!checkUpload(deps.uploadSecret, buildingId, sid, body.token)) return null;
    return { buildingId, sid };
  }

  app.post('/screening-file', async (req, res) => {
    const body = req.body || {};
    const auth = authUpload(body);
    if (!auth) return res.status(403).json({ success: false, error: 'This upload link has expired or is not valid. Please submit the form again.' });
    const name = str(body.name, 200), data = body.data;
    if (!name || !BILL_EXT.test(name)) return res.status(400).json({ success: false, error: 'Bills must be PDF, JPG or PNG files.' });
    if (typeof data !== 'string' || !data.length) return res.status(400).json({ success: false, error: `${name} is empty.` });
    if (data.length > MAX_SEPARATE_B64) return res.status(413).json({ success: false, error: `${name} is larger than 25 MB.` });
    try {
      const { access_token, instance_url } = await deps.getSFToken();
      await deps.uploadOneFileToSF(instance_url, access_token, auth.buildingId, { name, data });
      console.log(`[${auth.sid}] screening-file ${name} → ${auth.buildingId}`);
      res.json({ success: true, name });
    } catch (err) {
      const msg = String(err && err.message || err);
      console.error(`[${auth.sid}] /screening-file error (${name}):`, msg);
      res.status(502).json({ success: false, error: `${name} could not be saved. Please try again.` });
    }
  });

  app.post('/screening-complete', async (req, res) => {
    const body = req.body || {};
    const auth = authUpload(body);
    if (!auth) return res.status(403).json({ success: false, error: 'This upload link has expired or is not valid. Please submit the form again.' });
    const failed = (Array.isArray(body.failed) ? body.failed : []).map(x => str(x, 200)).filter(Boolean);
    try {
      const { access_token, instance_url } = await deps.getSFToken();
      const fields = { Screening_Status__c: 'Requested' };
      if (failed.length) {
        const cur = await deps.sfGetFields(instance_url, access_token, 'Buildings__c', auth.buildingId, ['Screening_Intake_Flags__c']);
        const flags = String(cur && cur.Screening_Intake_Flags__c || '').split(';').filter(Boolean);
        if (!flags.includes('bills_upload_incomplete')) flags.push('bills_upload_incomplete');
        fields.Screening_Intake_Flags__c = flags.join(';');
      }
      await deps.sfPatch(instance_url, access_token, 'Buildings__c', auth.buildingId, fields);
      console.log(`[${auth.sid}] screening-complete ${auth.buildingId}${failed.length ? ` (${failed.length} bill(s) failed)` : ''}`);
      res.json({ success: true, failed: failed.length });
    } catch (err) {
      const msg = String(err && err.message || err);
      console.error(`[${auth.sid}] /screening-complete error:`, msg);
      res.status(500).json({ success: false, error: msg });
    }
  });
}

module.exports = { register, validate, screeningFields, signUpload, checkUpload, MAX_SEPARATE_BYTES };
