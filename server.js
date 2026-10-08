'use strict';
// ============================================================
//  Catholic Energies Web-to-Salesforce Middleware  v8.0.1
//
//  Successor to ce-solar-middleware (v7.6). One app for the public forms that write
//  to Salesforce. Moved here UNCHANGED (code ported line for line, behavior proven
//  identical by test): GET /accounts, GET /buildings, GET /institutions,
//  POST /accounts, POST /submit (Solar Assessment), POST /screening-request,
//  POST /screening-file, POST /screening-complete (Desk Audit).
//  New: Instant Audit (POST /instant-audit and the Freddie job relay), and a
//  Procurement stub (501 "coming soon").
//  Still on ce-solar-middleware for now: POST /lead-submit (Lead and Community forms).
// ============================================================
const express = require('express');
const cors = require('cors');
const config = require('./lib/config');
const sf = require('./lib/sf');
const { getInstantConfig } = require('./lib/instant/config');
const { JobQueue, SubmissionStore } = require('./lib/instant/queue');
const { recoverPending } = require('./lib/instant/recover');
const { createInstantRouter } = require('./routes/instant-audit');
const { createProcurementRouter } = require('./routes/procurement');
const { getLimits, createRouteLimits } = require('./lib/limits');

const VERSION = '8.1.3';

function createApp(opts = {}) {
  const env = opts.env || process.env;
  const cfg = opts.instantConfig || getInstantConfig(env);
  const sfApi = opts.sf || sf;
  const log = opts.log || console.log;
  const queue = opts.queue || new JobQueue({ claimTimeoutMs: cfg.claimTimeoutMs });
  const store = opts.store || new SubmissionStore();
  const now = opts.now || (() => Date.now());

  const app = express();
  app.set('trust proxy', 1);                     // Heroku: the real client address is in X-Forwarded-For
  Object.assign(app.locals, { queue, store, cfg, sf: sfApi, log });

  // New endpoints first: they set their own body limits and CORS rules.
  app.use(createInstantRouter({ sf: sfApi, cfg, queue, store, log, now }));
  app.use(createProcurementRouter());

  // Ported endpoints: same settings as ce-solar-middleware v7.6, plus per-connection rate limits (8.1.0).
  // CORS first so a refusal (429) can still be read by the browser; limits before the body is parsed.
  const limits = getLimits(env);
  app.locals.limits = limits;
  app.use(cors());
  app.use(createRouteLimits(limits, log));
  app.use(express.json({ limit: '50mb' }));

  app.get('/', (req, res) => {
    const st = queue.stats();
    res.json({
      status: 'ok',
      service: 'Catholic Energies Web-to-Salesforce Middleware',
      version: VERSION,
      newAccounts: (config.NEW_ACCOUNTS_ENABLED || config.DEMO_MODE) ? 'enabled' : 'disabled',
      demoMode: config.DEMO_MODE,
      instantAudit: {
        mode: cfg.mock ? 'mock' : 'live',
        salesforceWrites: cfg.sfWrite,
        freddie: {
          lastPollSecondsAgo: st.lastPollAt ? Math.round((now() - st.lastPollAt) / 1000) : null,
          queued: st.queued, claimed: st.claimed, gaveUp: st.failed,
        },
      },
      procurement: 'stub',
      endpoints: [
        'GET  /accounts?zip=XXXXX', 'GET  /buildings?accountId=XXXXX', 'GET  /institutions', 'POST /accounts',
        'POST /submit',
        'POST /screening-request', 'POST /screening-file', 'POST /screening-complete',
        'POST /instant-audit', 'GET  /instant-audit/:id', 'GET  /instant-audit/:id/report',
        'GET  /instant-audit/jobs/next (Freddie)', 'POST /instant-audit/jobs/:jobId/result (Freddie)', 'POST /instant-audit/jobs/:jobId/report (Freddie)',
        'GET  /procurement (stub)', 'POST /procurement-request (stub, 501)',
      ],
    });
  });

  const common = {
    getSFToken: sfApi.getSFToken, sfQuery: sfApi.sfQuery, sfPost: sfApi.sfPost, sfPatch: sfApi.sfPatch,
    sfGetFields: sfApi.sfGetFields, generateSubmissionId: sfApi.generateSubmissionId,
    findOrCreateContact: sfApi.findOrCreateContact, findExistingBuilding: sfApi.findExistingBuilding,
    uploadFilesToSF: sfApi.uploadFilesToSF, uploadOneFileToSF: sfApi.uploadOneFileToSF,
  };
  require('./routes/lookups')(app, { ...common, config });
  require('./routes/saf')(app, { ...common, config });
  require('./routes/screening').register(app, {
    ...common,
    // Upload tokens are signed with SCREENING_UPLOAD_SECRET when set, otherwise with the
    // Salesforce client secret (never sent to clients).
    uploadSecret: env.SCREENING_UPLOAD_SECRET || env.SF_CLIENT_SECRET || 'dev-only-secret',
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  const { cfg, store, queue, sf: sfApi } = app.locals;
  app.listen(config.PORT, () => {
    console.log(`Catholic Energies web-to-Salesforce middleware v${VERSION} on port ${config.PORT}`);
    console.log(`SF Login: ${config.SF_LOGIN_URL}`);
    console.log(`New accounts: ${config.NEW_ACCOUNTS_ENABLED ? 'ENABLED' : 'disabled (flag off)'}`);
    if (config.DEMO_MODE) console.log('\u26a0\u26a0\u26a0 DEMO MODE ACTIVE \u2014 registration & demo submissions are SIMULATED (no SF writes) \u26a0\u26a0\u26a0');
    console.log(`Instant Audit: ${cfg.mock ? 'MOCK (canned answers, no Freddie)' : 'live'}; Salesforce writes ${cfg.sfWrite ? 'ON' : 'OFF (dry run)'}`);
    if (!cfg.mock && !cfg.freddieSecret) console.log('WARNING: FREDDIE_JOB_SECRET is not set. Every Freddie request will be refused.');
    if (!cfg.allowedOrigins.length) console.log('Note: INSTANT_AUDIT_ALLOWED_ORIGINS is empty, so any website can call Instant Audit.');
  });
  setInterval(() => store.purge(), 3600 * 1000).unref();
  if (cfg.sfWrite && !cfg.mock) {
    const recover = () => recoverPending({ sf: sfApi, store, queue }).catch(e => console.error('recovery failed:', e.message));
    setTimeout(recover, 30 * 1000).unref();
    setInterval(recover, 5 * 60 * 1000).unref();
  }
}

module.exports = { createApp, VERSION };
