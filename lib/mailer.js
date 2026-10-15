'use strict';
// ce-web-to-sf-middleware - lib/mailer.js
// Sends the one-time verification code. Two providers are supported through their plain web
// APIs (no extra package): Postmark and SendGrid. MAIL_PROVIDER=log only writes the message to
// the log (development and tests; the code is visible in the log, so never use it in production).
// With no provider set, sending is refused and the website says so; nothing is silently dropped.
const nodeFetch = require('node-fetch');

class MailNotConfigured extends Error {}

function createMailer(mailCfg = {}, fetchImpl = nodeFetch, log = () => {}) {
  const provider = (mailCfg.provider || '').toLowerCase();
  const from = mailCfg.from || '';
  const fromName = mailCfg.fromName || 'Catholic Energies';

  async function send({ to, subject, text }) {
    if (!provider) throw new MailNotConfigured('MAIL_PROVIDER is not set');
    if (provider === 'log') { log(`[mail:log] to=${to} subject=${subject}\n${text}`); return { ok: true }; }
    if (!mailCfg.apiKey || !from) throw new MailNotConfigured('MAIL_API_KEY and MAIL_FROM are required');
    if (provider === 'postmark') {
      const r = await fetchImpl('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': mailCfg.apiKey },
        body: JSON.stringify({ From: `${fromName} <${from}>`, To: to, Subject: subject, TextBody: text, MessageStream: 'outbound' }),
      });
      if (!r.ok) throw new Error(`Postmark refused the message (${r.status})`);
      return { ok: true };
    }
    if (provider === 'sendgrid') {
      const r = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${mailCfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }], from: { email: from, name: fromName },
          subject, content: [{ type: 'text/plain', value: text }],
        }),
      });
      if (!r.ok) throw new Error(`SendGrid refused the message (${r.status})`);
      return { ok: true };
    }
    throw new MailNotConfigured(`unknown MAIL_PROVIDER "${provider}"`);
  }

  return { send, configured: !!provider };
}

module.exports = { createMailer, MailNotConfigured };
