'use strict';
// ce-web-to-sf-middleware - routes/instant-audit.js
// Instant Audit (spec: UI_and_Middleware_Build_Spec.md, section 7).
//   Browser:  POST /instant-audit   GET /instant-audit/:id   GET /instant-audit/:id/report
//   Freddie:  GET /instant-audit/jobs/next   POST /instant-audit/jobs/:jobId/result|report
// The middleware never scores. Freddie (the only engine) fetches work and returns results.
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { validate } = require('../lib/instant/validate');
const { verifyFreddie, signReport, verifyReport } = require('../lib/instant/signing');
const { LIGHTS } = require('../lib/instant/schema');
const sfwrite = require('../lib/instant/sfwrite');

const QUEUED_MESSAGE = "We've saved your numbers and we'll get back to you soon with the results.";
const SAVE_FAILED = "Something went wrong and your numbers weren't saved. Try again.";
const ID = '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})';
const MAX_PDF_BYTES = 3 * 1024 * 1024;
const MOCK_PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

function loadMockResults() {
  const dir = path.join(__dirname, '..', 'fixtures');
  const read = n => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
  return {
    green: read('response_complete_green.json'),
    yellow: read('response_complete_yellow.json'),
    red: read('response_complete_red.json'),
  };
}

function validResult(r) {
  return r && typeof r === 'object' && LIGHTS[r.light] && typeof r.headline === 'string' &&
    typeof r.annual_spend === 'number' && Number.isFinite(r.annual_spend) &&
    r.summary && Array.isArray(r.summary.used) && typeof r.summary.means === 'string' &&
    typeof r.summary.next === 'string';
}

function createInstantRouter({ sf, cfg, queue, store, log = console.log, now = () => Date.now() }) {
  const router = express.Router();
  const mockResults = cfg.mock ? loadMockResults() : null;
  const baseUrl = req => cfg.publicBaseUrl || `${req.protocol}://${req.get('host')}`;

  // ---- browser-facing guards
  const originGuard = (req, res, next) => {
    const o = req.get('origin');
    if (o && cfg.allowedOrigins.length && !cfg.allowedOrigins.includes(o)) {
      return res.status(403).json({ ok: false, error: 'This website is not allowed to use Instant Audit.' });
    }
    next();
  };
  const hourly = rateLimit({
    windowMs: 3600 * 1000, limit: cfg.ratePerHour, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ ok: false, error: 'Too many requests from this connection. Try again in a few minutes.' }),
  });
  const perBuilding = new Map();     // building id -> timestamps (last 24 h)
  const buildingAllowed = id => {
    const t = now(); const list = (perBuilding.get(id) || []).filter(x => t - x < 86400000);
    if (list.length >= cfg.ratePerBuildingDay) { perBuilding.set(id, list); return false; }
    list.push(t); perBuilding.set(id, list); return true;
  };

  const reportBlock = (rec, req) => {
    if (rec.report.state === 'ready') {
      const exp = Math.floor(now() / 1000) + cfg.reportLinkDays * 86400;
      const token = signReport(cfg.reportSecret, rec.submission_id, exp);
      return { state: 'ready', url: `${baseUrl(req)}/instant-audit/${rec.submission_id}/report?t=${token}`, filename: rec.report.filename };
    }
    if (rec.report.state === 'unavailable' || (rec.resultAt && now() - rec.resultAt > cfg.reportGraceMs)) {
      return { state: 'unavailable', url: null, filename: null };
    }
    return { state: 'preparing', url: null, filename: null };
  };
  const envelope = (rec, req) => rec.status === 'complete'
    ? { ok: true, status: 'complete', submission_id: rec.submission_id, result: rec.result, report: reportBlock(rec, req) }
    : { ok: true, status: 'queued', submission_id: rec.submission_id, result: null, report: null, message: QUEUED_MESSAGE };

  // ================= browser =================
  router.use('/instant-audit', cors({ origin: (o, cb) => cb(null, !o || !cfg.allowedOrigins.length || cfg.allowedOrigins.includes(o)) }));

  router.post('/instant-audit', originGuard, hourly, express.json({ limit: cfg.maxBodyBytes }), async (req, res) => {
    const v = validate(req.body);
    if (!v.ok) return res.status(400).json({ ok: false, errors: v.errors });
    const clean = v.clean; const id = clean.submission_id;

    const existing = store.get(id);                       // a retry or double click
    if (existing) return res.json(envelope(existing, req));
    if (!buildingAllowed(clean.building.building_id)) {
      return res.status(429).json({ ok: false, error: 'This building has been submitted several times today. Try again tomorrow, or contact Catholic Energies.' });
    }

    if (cfg.mock) return mockAnswer(clean, v.totals, req, res);

    const rec = store.create(id, { payload: clean });
    try {
      await sfwrite.saveSubmission({ sf, clean, totals: v.totals, nowIso: new Date(now()).toISOString(), dryRun: !cfg.sfWrite, log });
    } catch (e) {
      store.map.delete(id);
      log('POST /instant-audit save failed:', e.message);
      return res.status(500).json({ ok: false, error: SAVE_FAILED });
    }
    rec.jobId = queue.enqueue(id, clean).job_id;
    const done = await store.waitComplete(id, cfg.waitMs);
    return res.json(envelope(done || rec, req));
  });

  function mockAnswer(clean, totals, req, res) {
    const force = req.query.force;
    if (force === 'error') return res.status(500).json({ ok: false, error: SAVE_FAILED });
    // Picks a canned result by the entered total cost. It does no scoring of its own.
    const total = totals.totalCost;
    const key = total >= 25000 ? 'green' : total >= 8000 ? 'yellow' : 'red';
    const canned = mockResults[key];
    const rec = store.create(clean.submission_id, { payload: clean });
    const finish = () => {
      store.setResult(rec.submission_id, canned.result);
      if (canned.report.state === 'unavailable') rec.report.state = 'unavailable';
      else store.setReport(rec.submission_id, { filename: 'Instant_Audit_Report.pdf', pdf: MOCK_PDF });
    };
    if (force === 'queued') {
      const t = setTimeout(finish, 5000); t.unref();      // so the polling path can be tested
      return res.json(envelope(rec, req));
    }
    finish();
    return res.json(envelope(rec, req));
  }

  router.get(`/instant-audit/:id${ID}`, originGuard, (req, res) => {
    const rec = store.get(req.params.id.toLowerCase());
    if (!rec) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json(envelope(rec, req));
  });

  router.get(`/instant-audit/:id${ID}/report`, (req, res) => {
    const id = req.params.id.toLowerCase();
    const t = verifyReport(cfg.reportSecret, id, req.query.t, now());
    if (!t.ok) return res.status(t.reason === 'expired' ? 410 : 403).json({ ok: false, error: t.reason === 'expired' ? 'This report link has expired.' : 'This report link is not valid.' });
    const rec = store.get(id);
    if (!rec) return res.status(404).json({ ok: false, error: 'Not found' });
    if (rec.report.state !== 'ready') return res.status(202).json({ ok: false, status: rec.report.state });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${rec.report.filename}"`, 'Cache-Control': 'private, max-age=0' });
    res.send(rec.report.pdf);
  });

  // ================= Freddie (signed requests only) =================
  const freddieJson = express.json({ limit: '6mb', verify: (req, res, buf) => { req.rawBody = buf; } });
  const freddieAuth = (req, res, next) => {
    const a = verifyFreddie(req, cfg.freddieSecret, now());
    if (!a.ok) { log(`Freddie request refused (${a.reason}): ${req.method} ${req.path}`); return res.status(401).json({ ok: false, error: 'unauthorized' }); }
    next();
  };

  router.get('/instant-audit/jobs/next', freddieAuth, async (req, res) => {
    const waitSec = Math.min(Math.max(Number(req.query.wait) || 25, 0), 25);
    const job = await queue.claim(waitSec * 1000);
    if (!job) return res.status(204).end();
    res.json(job);
  });

  router.post('/instant-audit/jobs/:jobId/result', freddieJson, freddieAuth, (req, res) => {
    const { submission_id: sid, result, error } = req.body || {};
    const rec = store.get(String(sid || '').toLowerCase());
    if (!rec) return res.status(404).json({ ok: false, error: 'Unknown submission' });
    if (error) { log(`Freddie reported an error for ${rec.submission_id}: ${error}`); queue.release(req.params.jobId); return res.json({ ok: true, requeued: true }); }
    if (!validResult(result)) return res.status(400).json({ ok: false, error: 'Result is not in the expected shape' });
    if (rec.status === 'complete') return res.json({ ok: true, duplicate: true });
    store.setResult(rec.submission_id, result);
    queue.complete(req.params.jobId);
    sfwrite.saveResult({ sf, buildingId: rec.building_id, result, nowIso: new Date(now()).toISOString(), dryRun: !cfg.sfWrite, log })
      .catch(e => log('saving the result to Salesforce failed:', e.message));
    res.json({ ok: true });
  });

  router.post('/instant-audit/jobs/:jobId/report', freddieJson, freddieAuth, (req, res) => {
    const { submission_id: sid, filename, pdf_base64: b64 } = req.body || {};
    const rec = store.get(String(sid || '').toLowerCase());
    if (!rec) return res.status(404).json({ ok: false, error: 'Unknown submission' });
    const pdf = Buffer.from(String(b64 || ''), 'base64');
    if (!pdf.length || pdf.length > MAX_PDF_BYTES || pdf.slice(0, 4).toString() !== '%PDF') {
      return res.status(400).json({ ok: false, error: 'The report must be a PDF of up to 3 MB' });
    }
    let name = String(filename || 'Instant_Audit_Report.pdf').replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120);
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    store.setReport(rec.submission_id, { filename: name, pdf });
    sfwrite.saveReport({ sf, buildingId: rec.building_id, filename: name, pdf, dryRun: !cfg.sfWrite, log })
      .catch(e => log('filing the report in Salesforce failed:', e.message));
    res.json({ ok: true });
  });

  // JSON errors instead of HTML for bad bodies
  router.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'That submission is too large.' });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, errors: [{ field: '', message: 'Send the form as JSON' }] });
    next(err);
  });

  return router;
}

module.exports = { createInstantRouter, QUEUED_MESSAGE, SAVE_FAILED, validResult };
