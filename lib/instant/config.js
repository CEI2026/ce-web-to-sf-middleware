'use strict';
// ce-web-to-sf-middleware - lib/instant/config.js
// Instant Audit settings. Read from the environment each time createApp() runs,
// so tests can pass their own values.

function getInstantConfig(env = process.env) {
  const bool = v => String(v || '').toLowerCase() === 'true';
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    // true: answer from fixtures, no Freddie, no scoring (UI development)
    mock: bool(env.INSTANT_AUDIT_MOCK),
    // false: log what would be written to Salesforce and skip the calls (until CR-S3 is live)
    sfWrite: bool(env.INSTANT_AUDIT_SF_WRITE),
    // how long the browser request waits for Freddie before answering "queued"
    waitMs: num(env.INSTANT_AUDIT_WAIT_MS, 12000),
    // shared secret for Freddie's signed requests
    freddieSecret: env.FREDDIE_JOB_SECRET || '',
    // signs report download links (falls back to the Freddie secret)
    // if neither secret is set, a random one is used (links then stop working on restart)
    reportSecret: env.REPORT_LINK_SECRET || env.FREDDIE_JOB_SECRET || require('crypto').randomBytes(32).toString('hex'),
    // comma-separated list of website origins allowed to call Instant Audit; empty = any
    allowedOrigins: (env.INSTANT_AUDIT_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    // used to build report links, e.g. https://ce-web-to-sf-middleware.herokuapp.com
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    ratePerHour: num(env.INSTANT_AUDIT_RATE_PER_HOUR, 10),
    ratePerBuildingDay: num(env.INSTANT_AUDIT_RATE_PER_BUILDING_DAY, 5),
    // a job claimed by Freddie but not finished within this time goes back in the queue
    claimTimeoutMs: num(env.INSTANT_AUDIT_CLAIM_TIMEOUT_MS, 120000),
    // after a result, how long to keep saying "preparing" before reporting no report
    reportGraceMs: num(env.INSTANT_AUDIT_REPORT_GRACE_MS, 120000),
    reportLinkDays: 7,
    maxBodyBytes: 32 * 1024,
  };
}

module.exports = { getInstantConfig };
