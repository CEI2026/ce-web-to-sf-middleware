'use strict';
// ============================================================
//  Per-connection rate limits for the ported public endpoints (added in 8.1.0).
//
//  Instant Audit has its own limits (routes/instant-audit.js). These cover the rest, which came
//  over from ce-solar-middleware with no limits at all: the lookups, the Solar Assessment submit,
//  and the Desk Audit request / file / complete calls. Each endpoint has its own counter, per
//  client address (Heroku: the real address comes from X-Forwarded-For, see trust proxy in server.js).
//
//  Defaults are generous for real people (a parish office sharing one address can still work) and
//  hostile to floods and scrapers. Change them in Heroku Config Vars; 0 turns a limit off:
//    LOOKUP_RATE_PER_HOUR    GET  /accounts, /buildings, /institutions   default 120 each
//    SUBMIT_RATE_PER_HOUR    POST /submit, /screening-request, /screening-complete   default 20 each
//    FILE_RATE_PER_HOUR      POST /screening-file (one request per bill)  default 300
//    REGISTER_RATE_PER_HOUR  POST /accounts (registering a new institution)  default 5
// ============================================================
const rateLimit = require('express-rate-limit');

const num = (v, d) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d; };

function getLimits(env = process.env) {
  return {
    lookupPerHour: num(env.LOOKUP_RATE_PER_HOUR, 120),
    submitPerHour: num(env.SUBMIT_RATE_PER_HOUR, 20),
    filePerHour: num(env.FILE_RATE_PER_HOUR, 300),
    registerPerHour: num(env.REGISTER_RATE_PER_HOUR, 5),
  };
}

const TOO_MANY = 'Too many requests from this connection. Try again in a few minutes.';

function createRouteLimits(limits, log = () => {}) {
  const make = (name, perHour) => {
    if (!perHour) return null;                                       // 0 = no limit
    return rateLimit({
      windowMs: 3600 * 1000, limit: perHour, standardHeaders: 'draft-7', legacyHeaders: false,
      handler: (req, res) => {
        log(`rate limit: ${name} refused ${req.ip}`);
        // success:false and ok:false so every form's existing error handling treats it as a failure
        res.status(429).json({ success: false, ok: false, error: TOO_MANY });
      },
    });
  };
  const rules = {
    'GET /accounts': make('lookup /accounts', limits.lookupPerHour),
    'GET /buildings': make('lookup /buildings', limits.lookupPerHour),
    'GET /institutions': make('lookup /institutions', limits.lookupPerHour),
    'POST /accounts': make('register /accounts', limits.registerPerHour),
    'POST /submit': make('submit /submit', limits.submitPerHour),
    'POST /screening-request': make('submit /screening-request', limits.submitPerHour),
    'POST /screening-complete': make('submit /screening-complete', limits.submitPerHour),
    'POST /screening-file': make('file /screening-file', limits.filePerHour),
  };
  // Runs before the body is parsed, so a flood of large posts is refused cheaply.
  return function routeLimits(req, res, next) {
    const limiter = rules[`${req.method} ${req.path.replace(/\/+$/, '') || '/'}`];
    return limiter ? limiter(req, res, next) : next();
  };
}

module.exports = { getLimits, createRouteLimits, TOO_MANY };
