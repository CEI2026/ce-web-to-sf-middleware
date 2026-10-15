'use strict';
// ce-web-to-sf-middleware - routes/bills.js  (8.2.0, CR-S4)
// Verification and listing for a client who comes back to use bills uploaded earlier.
//
//   POST /bills/options      { building_id }                -> where a code may be sent (masked) or none
//   POST /bills/send-code    { building_id, option }        -> emails a 6-digit code (15 min, 5 tries)
//   POST /bills/verify       { challenge, code }            -> a 60-minute session + the reusable uploads
//   POST /bills/request-help { building_id, name?, email, phone?, message? }  -> a staff task
//
// Nothing about the bills (names, counts, dates) is returned before the code is verified, and file
// contents are never returned at all. Every endpoint answers {success:false, error} in plain words.
const bills = require('../lib/bills');
const { MailNotConfigured } = require('../lib/mailer');

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

function register(app, deps) {
  const { cfg, codes, mailer, log = console.log } = deps;
  const now = deps.now || (() => Date.now());
  const fail = (res, status, error, extra = {}) => res.status(status).json({ success: false, error, ...extra });

  // While the feature is off, the page asks once and hides itself: {enabled:false}.
  app.post('/bills/options', async (req, res) => {
    if (!cfg.enabled) return res.json({ success: true, enabled: false, options: [] });
    const buildingId = str(req.body && req.body.building_id, 18);
    if (!bills.isSfId(buildingId)) return fail(res, 400, 'Building is not valid.');
    try {
      const uploads = await bills.loadUploads(deps, buildingId, now());
      if (!uploads.length) return res.json({ success: true, enabled: true, options: [] });
      const building = await bills.loadBuilding(deps, buildingId);
      if (!building) return res.json({ success: true, enabled: true, options: [] });
      const options = bills.buildRecipients(cfg.secret, building, uploads).map(o => ({ id: o.id, label: o.label, masked: o.masked }));
      res.json({ success: true, enabled: true, options });
    } catch (err) {
      log('/bills/options error:', String(err && err.message || err));
      fail(res, 500, 'We could not check for earlier bills. Please upload them again.');
    }
  });

  app.post('/bills/send-code', async (req, res) => {
    if (!cfg.enabled) return fail(res, 404, 'Reusing bills is not available yet.');
    const buildingId = str(req.body && req.body.building_id, 18), optionId = str(req.body && req.body.option, 40);
    if (!bills.isSfId(buildingId)) return fail(res, 400, 'Building is not valid.');
    try {
      const uploads = await bills.loadUploads(deps, buildingId, now());
      const building = uploads.length ? await bills.loadBuilding(deps, buildingId) : null;
      if (!building) return fail(res, 404, 'We do not have bills on file for this building.');
      const pick = bills.buildRecipients(cfg.secret, building, uploads).find(o => o.id === optionId);
      if (!pick) return fail(res, 400, 'Please choose where to send the code.');
      const { challenge, code } = codes.create(buildingId, pick.email);
      try {
        await mailer.send({
          to: pick.email,
          subject: 'Your Catholic Energies verification code',
          text: `Your verification code is ${code}\n\n`
            + `Use it within 15 minutes to use the bills you uploaded earlier for ${building.name || 'your building'}. `
            + 'If you did not ask for this, you can ignore this message.\n\nCatholic Energies',
        });
      } catch (err) {
        codes.items.delete(challenge);
        log('/bills/send-code mail error:', String(err && err.message || err));
        const notSet = err instanceof MailNotConfigured;
        return fail(res, notSet ? 503 : 502, 'We could not send the code. Please try again, or ask for staff help.');
      }
      log(`[bills] code sent for ${buildingId} to ${pick.masked}`);
      res.json({ success: true, challenge, masked: pick.masked, expires_in_s: Math.round(cfg.codeTtlMs / 1000) });
    } catch (err) {
      if (err instanceof bills.BillsError) return fail(res, err.status, err.message);
      log('/bills/send-code error:', String(err && err.message || err));
      fail(res, 500, 'We could not send the code. Please try again, or ask for staff help.');
    }
  });

  app.post('/bills/verify', async (req, res) => {
    if (!cfg.enabled) return fail(res, 404, 'Reusing bills is not available yet.');
    const body = req.body || {};
    const r = codes.check(str(body.challenge, 64), str(body.code, 12));
    if (!r.ok) {
      if (r.reason === 'bad') return fail(res, 400, 'That code is not right.', { attempts_left: r.attemptsLeft });
      return fail(res, 400, r.reason === 'locked' ? 'Too many wrong codes. Please ask for a new code.'
        : 'That code has expired. Please ask for a new code.', { expired: true });
    }
    try {
      const expMs = now() + cfg.sessionTtlMs;
      const session = bills.signSession(cfg.secret, r.rec.buildingId, r.rec.email, expMs);
      const uploads = await bills.loadUploads(deps, r.rec.buildingId, now());
      log(`[bills] verified for ${r.rec.buildingId} via ${bills.maskEmail(r.rec.email)}`);
      res.json({ success: true, session, building_id: r.rec.buildingId, expires_in_s: Math.round(cfg.sessionTtlMs / 1000),
        uploads: uploads.map(bills.publicUpload) });
    } catch (err) {
      log('/bills/verify error:', String(err && err.message || err));
      fail(res, 500, 'We could not load your earlier bills. Please upload them again.');
    }
  });

  // For a client who has no access to either address: a task for CE staff, who decide what to release.
  app.post('/bills/request-help', async (req, res) => {
    if (!cfg.enabled) return fail(res, 404, 'Reusing bills is not available yet.');
    const b = req.body || {};
    const buildingId = str(b.building_id, 18), email = str(b.email, 120);
    if (!bills.isSfId(buildingId)) return fail(res, 400, 'Building is not valid.');
    if (!bills.EMAIL.test(email)) return fail(res, 400, 'Please enter an email address we can reach you at.');
    const lines = [
      `Building: ${buildingId}`, `Name: ${str(b.name, 120)}`, `Email: ${email}`, `Phone: ${str(b.phone, 40)}`,
      `Message: ${str(b.message, 500)}`,
      'The client could not use the code sent to the contact on record or to the person who uploaded the bills.',
    ];
    try {
      const { access_token, instance_url } = await deps.getSFToken();
      const task = {
        Subject: 'Bill reuse help requested', Status: 'Not Started', Priority: 'Normal',
        ActivityDate: bills.isoDate(now()), Description: lines.join('\n'),
        ...(cfg.staffTaskOwnerId ? { OwnerId: cfg.staffTaskOwnerId } : {}),
      };
      try { await deps.sfPost(instance_url, access_token, 'Task', { ...task, WhatId: buildingId }); }
      catch (e) {                         // activities may not be enabled on Buildings: keep the request, without the link
        log('/bills/request-help: task with building link failed, retrying without:', String(e && e.message || e));
        await deps.sfPost(instance_url, access_token, 'Task', task);
      }
      res.json({ success: true });
    } catch (err) {
      log('/bills/request-help error:', String(err && err.message || err));
      fail(res, 500, 'We could not send your request. Please email us and we will help.');
    }
  });
}

module.exports = { register };
