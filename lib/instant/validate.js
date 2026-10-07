'use strict';
// ce-web-to-sf-middleware - lib/instant/validate.js
// Validates an Instant Audit submission (spec section 7.1). Never corrects input:
// anything wrong is reported by field path with a plain-language message.
const { BUILDING_TYPES, HEATING_FUELS, REASONS, FUELS, UNITS } = require('./schema');

const SF_ID = /^[A-Za-z0-9]{15,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isStr = v => typeof v === 'string';
const MAX_ACCOUNTS = 6;
const MAX_ROWS = 24;
const MIN_ELECTRIC_MONTHS = 6;

function usageWord(fuel) {
  return fuel === 'electric' ? 'kWh' : fuel === 'gas' ? 'gas usage' : 'usage';
}

function validate(p) {
  const errors = [];
  const err = (field, message) => errors.push({ field, message });

  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return { ok: false, errors: [{ field: '', message: 'Send the form as a JSON object' }] };
  }

  // honeypot: a person never sees this field, a bot fills it in
  if (p.website !== undefined && p.website !== '') {
    return { ok: false, honeypot: true, errors: [{ field: 'website', message: 'This request could not be accepted' }] };
  }

  if (!UUID.test(String(p.submission_id || ''))) err('submission_id', 'Reload the page and try again');
  if (p.mode !== 'monthly' && p.mode !== 'annual') err('mode', 'Choose monthly figures or yearly totals');
  if (p.consent !== true) err('consent', 'Agree to the data sharing statement to continue');

  // ---- building (from the institution and building lookup)
  const b = p.building && typeof p.building === 'object' ? p.building : {};
  if (!SF_ID.test(String(b.account_id || ''))) err('building.account_id', 'Choose your institution first');
  if (!SF_ID.test(String(b.building_id || ''))) err('building.building_id', 'Choose your building first');
  if (!isStr(b.name) || !b.name.trim() || b.name.length > 120) err('building.name', 'Choose your building first');
  if (b.address !== undefined && (!isStr(b.address) || b.address.length > 200)) err('building.address', 'The address is too long');
  if (!/^\d{5}$/.test(String(b.zip || ''))) err('building.zip', 'Enter a five-digit ZIP code');

  // ---- facts
  const f = p.facts && typeof p.facts === 'object' ? p.facts : {};
  if (!isNum(f.sqft_total) || !Number.isInteger(f.sqft_total) || f.sqft_total < 1 || f.sqft_total > 5000000) {
    err('facts.sqft_total', 'Enter the total square feet as a number');
  }
  if (!BUILDING_TYPES[f.building_type]) err('facts.building_type', 'Choose a building type');
  if (!HEATING_FUELS.includes(f.heating_fuel)) err('facts.heating_fuel', 'Choose how the building is heated');
  const reasons = f.reasons === undefined ? [] : f.reasons;
  if (!Array.isArray(reasons) || reasons.some(r => !REASONS[r])) err('facts.reasons', 'Choose from the listed reasons');
  if (f.shared_meter_note !== undefined && f.shared_meter_note !== null &&
      (!isStr(f.shared_meter_note) || f.shared_meter_note.length > 255)) {
    err('facts.shared_meter_note', 'Keep the note to 255 characters');
  }
  if (f.sqft_county !== undefined && f.sqft_county !== null && !isNum(f.sqft_county)) err('facts.sqft_county', 'Not a number');
  if (f.sqft_confirmed_county !== undefined && typeof f.sqft_confirmed_county !== 'boolean') err('facts.sqft_confirmed_county', 'Not valid');

  // ---- contact
  const c = p.contact && typeof p.contact === 'object' ? p.contact : {};
  if (!isStr(c.name) || !c.name.trim() || c.name.length > 120) err('contact.name', 'Enter your name');
  if (!isStr(c.email) || c.email.length > 254 || !EMAIL.test(c.email.trim())) err('contact.email', 'Enter an email address we can reach you at');
  if (c.phone !== undefined && c.phone !== null && (!isStr(c.phone) || c.phone.length > 40)) err('contact.phone', 'Enter a shorter phone number');

  // ---- the figures
  const totals = { electricSpend: 0, gasSpend: 0, totalCost: 0, electricMonths: 0 };
  let accounts = [];
  let annual = null;

  if (p.mode === 'monthly') {
    const accts = Array.isArray(p.accounts) ? p.accounts : null;
    if (!accts || accts.length < 1 || accts.length > MAX_ACCOUNTS) {
      err('accounts', 'Enter your monthly figures');
    } else {
      const electricMonths = new Set();
      accts.forEach((a, i) => {
        const at = `accounts[${i}]`;
        if (!a || typeof a !== 'object') { err(at, 'Not valid'); return; }
        if (!isStr(a.label) || !a.label.trim() || a.label.length > 80) err(`${at}.label`, 'Name this account');
        if (!FUELS[a.fuel]) err(`${at}.fuel`, 'Choose electric or gas');
        if (!UNITS[a.unit]) err(`${at}.unit`, 'Choose the unit on your bill');
        else if (a.fuel === 'electric' && a.unit !== 'kwh') err(`${at}.unit`, 'Electric figures are in kWh');
        else if (a.fuel === 'gas' && a.unit !== 'therms' && a.unit !== 'ccf') err(`${at}.unit`, 'Gas figures are in therms or ccf');
        const rows = Array.isArray(a.rows) ? a.rows : null;
        if (!rows || rows.length > MAX_ROWS) { err(`${at}.rows`, `Enter up to ${MAX_ROWS} months for each account`); return; }
        const seen = new Set();
        const cleanRows = [];
        rows.forEach((r, j) => {
          const rt = `${at}.rows[${j}]`;
          if (!r || typeof r !== 'object') { err(rt, 'Not valid'); return; }
          const m = MONTH.exec(String(r.month || ''));
          if (!m || +m[1] < 2015 || +m[1] > 2100) { err(`${rt}.month`, 'Choose a valid month'); return; }
          if (seen.has(r.month)) { err(`${rt}.month`, 'This month is entered twice'); return; }
          seen.add(r.month);
          let ok = true;
          if (!isNum(r.usage) || r.usage < 0 || r.usage > 1e8) { err(`${rt}.usage`, `Enter the ${usageWord(a.fuel)} for this month, or leave the month blank`); ok = false; }
          if (!isNum(r.cost) || r.cost < 0 || r.cost > 1e7) { err(`${rt}.cost`, 'Enter the cost for this month, or leave the month blank'); ok = false; }
          if (ok) cleanRows.push({ month: r.month, usage: r.usage, cost: r.cost });
        });
        cleanRows.sort((x, y) => (x.month < y.month ? -1 : 1));
        const spend = cleanRows.reduce((s, r) => s + r.cost, 0);
        if (a.fuel === 'electric') { totals.electricSpend += spend; cleanRows.forEach(r => electricMonths.add(r.month)); }
        else if (a.fuel === 'gas') totals.gasSpend += spend;
        totals.totalCost += spend;
        accounts.push({ label: String(a.label || '').trim(), fuel: a.fuel, unit: a.unit, rows: cleanRows });
      });
      totals.electricMonths = electricMonths.size;
      if (electricMonths.size < MIN_ELECTRIC_MONTHS && !errors.some(e => e.field.startsWith('accounts'))) {
        err('accounts', `Enter at least ${MIN_ELECTRIC_MONTHS} months of electric figures`);
      }
    }
  } else if (p.mode === 'annual') {
    const a = p.annual && typeof p.annual === 'object' ? p.annual : {};
    const ok = v => v === undefined || v === null || (isNum(v) && v >= 0 && v <= 1e8);
    if (!ok(a.electric_cost)) err('annual.electric_cost', 'Enter your yearly electric cost as a number');
    if (!ok(a.gas_cost)) err('annual.gas_cost', 'Enter your yearly gas cost as a number');
    if (!(a.electric_cost > 0) && !(a.gas_cost > 0)) err('annual.electric_cost', 'Enter your yearly electric cost');
    annual = { electric_cost: a.electric_cost || 0, gas_cost: a.gas_cost || 0 };
    totals.electricSpend = annual.electric_cost; totals.gasSpend = annual.gas_cost;
    totals.totalCost = annual.electric_cost + annual.gas_cost;
  }

  if (errors.length) return { ok: false, errors };

  const clean = {
    submission_id: p.submission_id.toLowerCase(),
    mode: p.mode,
    building: { account_id: b.account_id, building_id: b.building_id, name: b.name.trim(), address: (b.address || '').trim(), zip: b.zip },
    facts: {
      sqft_total: f.sqft_total,
      sqft_county: isNum(f.sqft_county) ? f.sqft_county : null,
      sqft_confirmed_county: !!f.sqft_confirmed_county,
      building_type: f.building_type,
      heating_fuel: f.heating_fuel,
      reasons: [...new Set(reasons)],
      shared_meter_note: (f.shared_meter_note || '').trim(),
    },
    contact: { name: c.name.trim(), email: c.email.trim(), phone: (c.phone || '').trim() },
    consent: true,
    website: '',
  };
  if (p.mode === 'monthly') clean.accounts = accounts; else clean.annual = annual;
  return { ok: true, errors: [], clean, totals };
}

module.exports = { validate, MIN_ELECTRIC_MONTHS, MAX_ACCOUNTS, MAX_ROWS };
