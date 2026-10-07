'use strict';
// ce-web-to-sf-middleware - lib/instant/signing.js
// Freddie's requests: X-CE-Timestamp (Unix seconds, within 5 minutes) and
// X-CE-Signature = hex HMAC-SHA256 of  timestamp \n METHOD \n path \n body
// where "path" is the URL path WITHOUT the query string, and body is the raw
// request body text (empty for GET).
const crypto = require('crypto');

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

function safeEqual(a, b) {
  const A = Buffer.from(String(a)); const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function freddieSignature(secret, ts, method, path, body) {
  return hmac(secret, `${ts}\n${String(method).toUpperCase()}\n${path}\n${body || ''}`);
}

// returns { ok: true } or { ok: false, reason }
function verifyFreddie(req, secret, nowMs = Date.now(), skewSec = 300) {
  if (!secret) return { ok: false, reason: 'not_configured' };
  const ts = req.get('x-ce-timestamp');
  const sig = req.get('x-ce-signature');
  if (!ts || !sig) return { ok: false, reason: 'missing' };
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(nowMs / 1000 - t) > skewSec) return { ok: false, reason: 'stale' };
  const path = req.originalUrl.split('?')[0];
  const body = req.rawBody ? req.rawBody.toString('utf8') : '';
  return safeEqual(sig, freddieSignature(secret, ts, req.method, path, body))
    ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

// ---- report download links: "<expiry>.<signature>"
function signReport(secret, submissionId, expSec) {
  return `${expSec}.${hmac(secret, `report\n${submissionId}\n${expSec}`)}`;
}

function verifyReport(secret, submissionId, token, nowMs = Date.now()) {
  if (!secret || !token) return { ok: false, reason: 'missing' };
  const [exp, sig] = String(token).split('.');
  const e = Number(exp);
  if (!Number.isFinite(e) || !sig) return { ok: false, reason: 'bad_token' };
  if (!safeEqual(sig, hmac(secret, `report\n${submissionId}\n${e}`))) return { ok: false, reason: 'bad_token' };
  if (e * 1000 < nowMs) return { ok: false, reason: 'expired' };
  return { ok: true };
}

module.exports = { freddieSignature, verifyFreddie, signReport, verifyReport };
