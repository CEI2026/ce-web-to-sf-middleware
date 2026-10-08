'use strict';
// ce-web-to-sf-middleware - lib/instant/sfwrite.js
// What Instant Audit writes to Salesforce (CR-S3). Every API name comes from schema.js.
// With dryRun true (INSTANT_AUDIT_SF_WRITE not "true") nothing is sent: the intended
// writes are logged instead, so the flow can be tested before CR-S3 exists.
const { BUILDING_TYPES, HEATING_FUEL_LABELS, REASONS, FUELS, UNITS, LIGHTS, BASIS, STATUS, SF } = require('./schema');

const cents = n => Math.round(n * 100) / 100;

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  return { firstname: parts.length > 1 ? parts.slice(0, -1).join(' ') : '', lastname: parts[parts.length - 1] || '' };
}

function monthRecords(clean, nowIso) {
  if (clean.mode !== 'monthly') return [];
  const M = SF.month; const out = [];
  for (const a of clean.accounts) {
    for (const r of a.rows) {
      out.push({
        [M.building]: clean.building.building_id, [M.fuel]: FUELS[a.fuel], [M.accountLabel]: a.label,
        [M.period]: `${r.month}-01`, [M.usage]: r.usage, [M.unit]: UNITS[a.unit], [M.cost]: r.cost,
        [M.source]: SF.sourceClientEntered, [M.submissionId]: clean.submission_id, [M.enteredAt]: nowIso,
      });
    }
  }
  return out;
}

function buildingPatch(clean, totals, contactId) {
  const B = SF.building; const f = clean.facts;
  const patch = {
    [B.sqft]: f.sqft_total,
    [B.confirmedCounty]: f.sqft_confirmed_county,
    [B.heatingFuel]: HEATING_FUEL_LABELS[f.heating_fuel] || null,   // the picklist is Gas, Electric, Oil, Steam; "none" is written blank
    [B.type]: BUILDING_TYPES[f.building_type],
    [B.reasons]: f.reasons.map(r => REASONS[r]).join(';') || null,
    [B.sharedNote]: f.shared_meter_note || null,
    [B.electricSpend]: cents(totals.electricSpend),
    [B.gasSpend]: cents(totals.gasSpend),
    [B.status]: STATUS.pending,
  };
  if (contactId) patch[B.contact] = contactId;
  return patch;
}

function resultPatch(result, nowIso) {
  const B = SF.building;
  return {
    [B.light]: LIGHTS[result.light],
    [B.headline]: String(result.headline || '').slice(0, 80),
    [B.annualSpend]: Math.round(result.annual_spend),
    [B.basis]: BASIS[result.basis] || BASIS.client_entered,
    [B.assumptions]: String(result.assumptions_version || '').slice(0, 40),
    [B.resultAt]: result.generated_utc || nowIso,
    [B.status]: STATUS.completed,
  };
}

// Order matters: contact, then the monthly records, then the building (status "pending").
// If a monthly record fails, the building is never marked pending, so nothing is half-saved.
async function saveSubmission({ sf, clean, totals, nowIso, dryRun, log = console.log }) {
  const months = monthRecords(clean, nowIso);
  const contact = { email: clean.contact.email, phone: clean.contact.phone, ...splitName(clean.contact.name) };
  if (dryRun) {
    log('[instant-audit][dry-run] would save', JSON.stringify({
      building: clean.building.building_id, submission: clean.submission_id,
      monthRecords: months.length, buildingPatch: buildingPatch(clean, totals, null),
    }));
    return { dryRun: true, contactId: null, monthRecords: months.length };
  }
  const { access_token, instance_url } = await sf.getSFToken();
  const contactId = await sf.findOrCreateContact(instance_url, access_token, clean.building.account_id, contact);
  if (months.length) await sf.sfCreateMany(instance_url, access_token, SF.monthObject, months);
  await sf.sfPatch(instance_url, access_token, 'Buildings__c', clean.building.building_id, buildingPatch(clean, totals, contactId));
  return { dryRun: false, contactId, monthRecords: months.length };
}

async function saveResult({ sf, buildingId, result, nowIso, dryRun, log = console.log }) {
  const patch = resultPatch(result, nowIso);
  if (dryRun) { log('[instant-audit][dry-run] would save result', JSON.stringify({ building: buildingId, patch })); return { dryRun: true }; }
  const { access_token, instance_url } = await sf.getSFToken();
  await sf.sfPatch(instance_url, access_token, 'Buildings__c', buildingId, patch);
  return { dryRun: false };
}

async function saveReport({ sf, buildingId, filename, pdf, dryRun, log = console.log }) {
  if (dryRun) { log('[instant-audit][dry-run] would file report', JSON.stringify({ building: buildingId, filename, bytes: pdf.length })); return { dryRun: true }; }
  const { access_token, instance_url } = await sf.getSFToken();
  await sf.uploadOneFileToSF(instance_url, access_token, buildingId, { name: filename, data: pdf.toString('base64') });
  return { dryRun: false };
}

module.exports = { monthRecords, buildingPatch, resultPatch, saveSubmission, saveResult, saveReport, splitName };
