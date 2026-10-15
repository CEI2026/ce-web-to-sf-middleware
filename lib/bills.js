'use strict';
// ce-web-to-sf-middleware - lib/bills.js  (8.2.0, CR-S4)
// Bill sets: a client uploads energy bills once and uses them for Desk Audit, Solar Assessment,
// or both, including weeks later. Each upload is one Bill_Upload__c record in Salesforce; the
// files are linked to it as well as to the building. A returning client proves they are connected
// to the building with a one-time code sent by email before anything about the bills is shown.
//
// Everything here is behind BILL_SETS_ENABLED. With it off nothing in this file runs and the
// website behaves exactly as it did in 8.1.3.
const crypto = require('crypto');

const SF_ID = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;
const isSfId = v => typeof v === 'string' && SF_ID.test(v);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class BillsError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

function getBillsConfig(env = process.env) {
  const bool = v => String(v || '').toLowerCase() === 'true';
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    enabled: bool(env.BILL_SETS_ENABLED),
    reuseDays: num(env.BILLS_REUSE_DAYS, 395),                 // about 13 months
    codeTtlMs: 15 * 60 * 1000,
    maxAttempts: 5,
    maxCodesPer15Min: 3,
    sessionTtlMs: 60 * 60 * 1000,
    // signs verification sessions; a fresh random secret (sessions end on restart) when none is set
    secret: env.BILLS_SESSION_SECRET || env.SCREENING_UPLOAD_SECRET || env.SF_CLIENT_SECRET
      || crypto.randomBytes(32).toString('hex'),
    mail: {
      provider: env.MAIL_PROVIDER || '', apiKey: env.MAIL_API_KEY || '',
      from: env.MAIL_FROM || '', fromName: env.MAIL_FROM_NAME || 'Catholic Energies',
    },
    staffTaskOwnerId: isSfId(env.BILLS_STAFF_TASK_OWNER_ID || '') ? env.BILLS_STAFF_TASK_OWNER_ID : '',
  };
}

// ---- small helpers ----------------------------------------------------------------------------
const lower = e => String(e || '').trim().toLowerCase();
const hmac = (secret, s) => crypto.createHmac('sha256', secret).update(s).digest('hex');

function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${local.slice(0, 1)}***@${domain}`;
}

function isoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }
function expiryDate(nowMs, days) { return isoDate(nowMs + days * 86400000); }
const splitLines = s => String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);

// ---- one-time codes (in memory; a restart only means "ask for a new code") --------------------
class CodeStore {
  constructor({ secret, ttlMs, maxAttempts, maxSends = 3, now = () => Date.now() }) {
    Object.assign(this, { secret, ttlMs, maxAttempts, maxSends, now });
    this.items = new Map();           // challenge -> record
    this.sends = new Map();           // building|email -> [timestamps]
  }
  create(buildingId, email) {
    const t = this.now(), key = `${buildingId}|${lower(email)}`;
    const recent = (this.sends.get(key) || []).filter(x => t - x < this.ttlMs);
    if (recent.length >= this.maxSends) throw new BillsError(429, 'Too many codes were requested. Please wait a few minutes and try again.');
    recent.push(t); this.sends.set(key, recent);
    const challenge = crypto.randomBytes(16).toString('hex');
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    this.items.set(challenge, { buildingId, email: lower(email), hash: hmac(this.secret, `${challenge}|${code}`), exp: t + this.ttlMs, attempts: 0 });
    return { challenge, code };
  }
  check(challenge, code) {
    const rec = this.items.get(String(challenge || ''));
    if (!rec) return { ok: false, reason: 'expired' };
    if (this.now() > rec.exp) { this.items.delete(challenge); return { ok: false, reason: 'expired' }; }
    const want = Buffer.from(rec.hash, 'hex');
    const got = Buffer.from(hmac(this.secret, `${challenge}|${String(code || '').replace(/\s+/g, '')}`), 'hex');
    if (want.length === got.length && crypto.timingSafeEqual(want, got)) { this.items.delete(challenge); return { ok: true, rec }; }
    rec.attempts += 1;
    if (rec.attempts >= this.maxAttempts) { this.items.delete(challenge); return { ok: false, reason: 'locked' }; }
    return { ok: false, reason: 'bad', attemptsLeft: this.maxAttempts - rec.attempts };
  }
  purge() {
    const t = this.now();
    for (const [k, v] of this.items) if (t > v.exp) this.items.delete(k);
    for (const [k, v] of this.sends) { const keep = v.filter(x => t - x < this.ttlMs); keep.length ? this.sends.set(k, keep) : this.sends.delete(k); }
  }
}

// ---- verification sessions: signed, stateless, bound to one building --------------------------
function signSession(secret, buildingId, email, expMs) {
  const ek = hmac(secret, `email|${lower(email)}`).slice(0, 16);
  return `${expMs}.${ek}.${hmac(secret, `${buildingId}|${ek}|${expMs}`)}`;
}
function checkSession(secret, buildingId, token, nowMs) {
  const m = /^(\d{10,16})\.([0-9a-f]{16})\.([0-9a-f]{64})$/.exec(String(token || ''));
  if (!m || Number(m[1]) < nowMs) return false;
  const want = Buffer.from(hmac(secret, `${buildingId}|${m[2]}|${m[1]}`), 'hex');
  return crypto.timingSafeEqual(want, Buffer.from(m[3], 'hex'));
}

// ---- Salesforce reads -------------------------------------------------------------------------
const UPLOAD_FIELDS = 'Id, Name, Submission_ID__c, Uploader_Email__c, Uploader_Name__c, Uploaded_At__c, Bill_Count__c, '
  + 'Bill_Filenames__c, Purpose__c, Reuse_Expires_On__c, Reuse_Count__c, Status__c';

function shapeUpload(r) {
  return {
    id: r.Id, name: r.Name, submissionId: r.Submission_ID__c || '', uploaderEmail: r.Uploader_Email__c || '',
    uploaderName: r.Uploader_Name__c || '', uploadedAt: r.Uploaded_At__c || '', count: Number(r.Bill_Count__c) || 0,
    names: splitLines(r.Bill_Filenames__c), expiresOn: r.Reuse_Expires_On__c || '',
    timesUsed: Number(r.Reuse_Count__c) || 0, purpose: String(r.Purpose__c || '').split(';').filter(Boolean),
    status: r.Status__c || '',
  };
}

// Complete, unexpired uploads for a building, newest first.
async function loadUploads(deps, buildingId, nowMs) {
  if (!isSfId(buildingId)) return [];
  const { access_token, instance_url } = await deps.getSFToken();
  const rows = await deps.sfQuery(instance_url, access_token,
    `SELECT ${UPLOAD_FIELDS} FROM Bill_Upload__c WHERE Building__c = '${buildingId}' AND Status__c = 'Complete' `
    + 'ORDER BY Uploaded_At__c DESC LIMIT 25');
  const today = isoDate(nowMs);
  return (rows || []).map(shapeUpload).filter(u => u.count > 0 && u.expiresOn && u.expiresOn >= today);
}

async function loadBuilding(deps, buildingId) {
  if (!isSfId(buildingId)) return null;
  const { access_token, instance_url } = await deps.getSFToken();
  const rows = await deps.sfQuery(instance_url, access_token,
    `SELECT Id, Name, Building_Contact__r.Email FROM Buildings__c WHERE Id = '${buildingId}' AND IsDeleted = false LIMIT 1`);
  const r = rows && rows[0];
  if (!r) return null;
  return { id: r.Id, name: r.Name || '', contactEmail: (r.Building_Contact__r && r.Building_Contact__r.Email) || '' };
}

// Where a code may be sent: the contact on record for the building, and whoever uploaded the
// reusable bills. One entry per distinct address; the id is opaque and stable.
function buildRecipients(secret, building, uploads) {
  const byEmail = new Map();
  const add = (email, kind, uploadedAt) => {
    const k = lower(email);
    if (!EMAIL.test(k)) return;
    const e = byEmail.get(k) || { email: email.trim(), kinds: new Set(), uploadedAt: '' };
    e.kinds.add(kind); if (uploadedAt && !e.uploadedAt) e.uploadedAt = uploadedAt;
    byEmail.set(k, e);
  };
  if (building && building.contactEmail) add(building.contactEmail, 'contact');
  for (const u of uploads) add(u.uploaderEmail, 'uploader', u.uploadedAt);
  return [...byEmail.values()].slice(0, 4).map(e => {
    const contact = e.kinds.has('contact'), up = e.kinds.has('uploader');
    const label = contact && up ? 'Contact on record, and the person who uploaded the bills'
      : contact ? 'Contact on record for this building' : 'Person who uploaded the bills';
    return { id: hmac(secret, `${building.id}|${lower(e.email)}`).slice(0, 12), email: e.email, masked: maskEmail(e.email), label };
  });
}

function publicUpload(u) {
  return { id: u.id, uploaded_at: u.uploadedAt, count: u.count, names: u.names.slice(0, 36), expires_on: u.expiresOn,
    times_used: u.timesUsed, purpose: u.purpose };
}

// A reuse request is allowed only with a valid verification session for THIS building and an
// upload that is still Complete and unexpired. Throws BillsError otherwise.
async function resolveReuse(deps, cfg, { session, buildingId, uploadId, nowMs }) {
  if (!cfg.enabled) throw new BillsError(503, 'Reusing bills is not available yet.');
  if (!checkSession(cfg.secret, buildingId, session, nowMs))
    throw new BillsError(403, 'Your verification has expired. Please verify again to use your earlier bills.', { verifyAgain: true });
  const ups = await loadUploads(deps, buildingId, nowMs);
  const up = ups.find(u => u.id === uploadId);
  if (!up) throw new BillsError(409, 'Those bills are no longer available to reuse. Please upload current bills.');
  return up;
}

// ---- Salesforce writes ------------------------------------------------------------------------
const _sidCache = new Map();    // submission id -> Bill_Upload__c id (short-lived; a miss falls back to a query)
function cacheSid(sid, id, nowMs) {
  _sidCache.set(sid, { id, exp: nowMs + 3 * 3600 * 1000 });
  for (const [k, v] of _sidCache) if (v.exp < nowMs) _sidCache.delete(k);
}

async function createUpload(deps, cfg, o) {
  const { access_token, instance_url } = await deps.getSFToken();
  const rec = await deps.sfPost(instance_url, access_token, 'Bill_Upload__c', {
    Building__c: o.buildingId, Submission_ID__c: o.sid, Status__c: 'Uploading',
    Uploader_Email__c: o.email, Uploader_Name__c: o.name, ...(o.contactId ? { Uploader_Contact__c: o.contactId } : {}),
    Uploaded_At__c: o.nowIso, Bill_Count__c: 0, Purpose__c: o.purposes.join(';'),
    Reuse_Expires_On__c: expiryDate(Date.parse(o.nowIso), cfg.reuseDays),
    ...(o.consentVersion ? { Consent_Text_Version__c: o.consentVersion } : {}),
  });
  cacheSid(o.sid, rec.id, Date.parse(o.nowIso));
  return rec.id;
}

async function findUploadId(deps, buildingId, sid, nowMs) {
  const hit = _sidCache.get(sid);
  if (hit && hit.exp > nowMs) return hit.id;
  const { access_token, instance_url } = await deps.getSFToken();
  const safeSid = String(sid).replace(/[^A-Za-z0-9-]/g, '');
  const rows = await deps.sfQuery(instance_url, access_token,
    `SELECT Id FROM Bill_Upload__c WHERE Submission_ID__c = '${safeSid}' AND Building__c = '${buildingId}' LIMIT 1`);
  const id = rows && rows[0] && rows[0].Id;
  if (id) cacheSid(sid, id, nowMs);
  return id || null;
}

// After the last file: how many files really reached Salesforce, and their names.
async function countFiles(deps, uploadId) {
  const { access_token, instance_url } = await deps.getSFToken();
  const links = await deps.sfQuery(instance_url, access_token,
    `SELECT ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId = '${uploadId}'`);
  const docIds = (links || []).map(l => l.ContentDocumentId).filter(isSfId);
  if (!docIds.length) return { count: 0, names: [] };
  const versions = await deps.sfQuery(instance_url, access_token,
    `SELECT Title FROM ContentVersion WHERE ContentDocumentId IN (${docIds.map(d => `'${d}'`).join(', ')}) `
    + 'AND IsLatest = true ORDER BY CreatedDate');
  return { count: docIds.length, names: (versions || []).map(v => v.Title).filter(Boolean) };
}

async function finalizeUpload(deps, uploadId, failedCount) {
  const { count, names } = await countFiles(deps, uploadId);
  const status = failedCount === 0 && count > 0 ? 'Complete' : 'Incomplete';
  const { access_token, instance_url } = await deps.getSFToken();
  await deps.sfPatch(instance_url, access_token, 'Bill_Upload__c', uploadId, {
    Status__c: status, Bill_Count__c: count, Bill_Filenames__c: names.join('\n').slice(0, 32000) });
  return { status, count, names };
}

async function markReused(deps, up, wants, nowIso) {
  const { access_token, instance_url } = await deps.getSFToken();
  const purposes = new Set(up.purpose);
  if (wants.desk) purposes.add('Desk Audit');
  if (wants.solar) purposes.add('Solar Assessment');
  await deps.sfPatch(instance_url, access_token, 'Bill_Upload__c', up.id, {
    Last_Reused_At__c: nowIso, Reuse_Count__c: up.timesUsed + 1, Purpose__c: [...purposes].join(';') });
}

module.exports = {
  isSfId, EMAIL, BillsError, getBillsConfig, lower, maskEmail, isoDate, expiryDate, splitLines,
  CodeStore, signSession, checkSession, loadUploads, loadBuilding, buildRecipients, publicUpload,
  resolveReuse, createUpload, findUploadId, countFiles, finalizeUpload, markReused, shapeUpload,
};
