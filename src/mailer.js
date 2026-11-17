// Email through Resend (resend.com). Set RESEND_API_KEY and MAIL_FROM (e.g. "VaayuTrip <noreply@vaayutrip.com>", on a
// domain verified in Resend). Without them nothing is sent and everything else works as before.
// Every in-app notification is also emailed: an agency's to its active owners, VaayuTrip's to the support email
// in Admin → Settings.
const env = process.env;
const enabled = () => Boolean(env.RESEND_API_KEY && env.MAIL_FROM);

// Links in emails need the public address of the site.
const siteUrl = () => (env.PUBLIC_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000')).replace(/\/$/, '');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A plain, branded email: heading, text, optional button. */
function layout({ heading, text, button, footer }) {
  return `<!doctype html><html><body style="margin:0;background:#f4f6f9;font-family:Segoe UI,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;border:1px solid #e2e8f0">
<tr><td style="padding:22px 28px;border-bottom:3px solid #0077c0"><img src="${siteUrl()}/img/vaayutrip-logo-sm.png" alt="VaayuTrip" height="40" style="display:block"></td></tr>
<tr><td style="padding:26px 28px">
<h1 style="margin:0 0 12px;font-size:20px">${esc(heading)}</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#334155">${esc(text).replace(/\n/g, '<br>')}</p>
${button ? `<a href="${esc(button.href)}" style="display:inline-block;background:#0077c0;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">${esc(button.label)}</a>` : ''}
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b">${esc(footer || 'VaayuTrip partner portal. You get this email because of activity on your account.')}</td></tr>
</table></td></tr></table></body></html>`;
}

/** Sends one email. Returns true when Resend accepted it; never throws (email must not break the action). */
async function send({ to, subject, heading, text, button, footer }) {
  const recipients = [].concat(to).filter(Boolean);
  if (!enabled() || !recipients.length) return false;
  try {
    const r = await fetch(`${env.RESEND_API_URL || 'https://api.resend.com'}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM, to: recipients, subject,
        html: layout({ heading: heading || subject, text, button, footer }),
        text: `${heading || subject}\n\n${text}${button ? `\n\n${button.label}: ${button.href}` : ''}`,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) console.error('email', r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) {
    console.error('email', e.message);
    return false;
  }
}

/** Emails an in-app notification to whoever should see it. */
async function emailNotification(agencyId, title, body, link) {
  if (!enabled()) return false;
  const { all, getSettings } = require('./db');
  const to = agencyId
    ? (await all("SELECT email FROM users WHERE agency_id = ? AND is_active = 1 AND agency_role = 'owner'", agencyId)).map((u) => u.email)
    : [(await getSettings()).email];
  return send({ to, subject: title, text: body || title, button: link ? { href: `${siteUrl()}${link}`, label: 'Open in VaayuTrip' } : null });
}

module.exports = { enabled, send, emailNotification, siteUrl };
