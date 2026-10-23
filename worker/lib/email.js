// worker/lib/email.js
// The Worker's emails in the same look as db/email_kit.py (digests, alerts,
// welcome, lifecycle): white card on grey, gradient bar, "Seli" wordmark,
// plain paragraphs, one button. Tables and inline styles, so Gmail and
// Outlook render it. Keep the colors in step with email_kit.py.

const C = {
  accent: '#5A4FE8', accentStr: '#4338C9', aqua: '#3FBFA0',
  text: '#111827', text2: '#374151', muted: '#6B7280', faint: '#9CA3AF',
  border: '#E5E7EB', bg: '#FFFFFF', page: '#F3F4F6', soft: '#F9FAFB', green: '#15803D',
};
const FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

export const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function p(html, { size = 15, color = C.text2, margin = '0 0 14px', weight = 400 } = {}) {
  return `<p style="margin:${margin};font-family:${FONT};font-size:${size}px;line-height:1.6;color:${color};font-weight:${weight};">${html}</p>`;
}

export function a(href, label, color = C.accent) {
  return `<a href="${esc(href)}" style="font-family:${FONT};color:${color};font-weight:600;text-decoration:none;">${label}</a>`;
}

export function button(label, href) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 18px;"><tr><td style="border-radius:8px;background:${C.accent};">`
    + `<a href="${esc(href)}" style="display:inline-block;font-family:${FONT};font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;">${esc(label)}</a></td></tr></table>`;
}

// A short list with check marks.
export function checks(items) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">${items.map(i =>
    `<tr><td style="width:22px;vertical-align:top;padding:3px 0;font-family:${FONT};font-size:14px;color:${C.green};font-weight:700;">&#10003;</td>`
    + `<td style="padding:3px 0;font-family:${FONT};font-size:15px;line-height:1.5;color:${C.text2};">${i}</td></tr>`).join('')}</table>`;
}

// Label/value rows in a soft box (order details and the like).
export function details(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.soft};border:1px solid ${C.border};border-radius:10px;margin:0 0 18px;"><tr><td style="padding:12px 16px;">`
    + rows.map(([k, v, mono]) => `<p style="margin:4px 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted};">${esc(k)}: `
      + `<span style="color:${C.text};font-weight:600;${mono ? `font-family:${MONO};font-size:12px;` : ''}">${esc(v)}</span></p>`).join('')
    + `</td></tr></table>`;
}

export function signOff(name = 'Kevin') {
  return p(esc(name), { margin: '4px 0 0', weight: 600, color: C.text });
}

const DISCLAIMER = "Seli summarizes public SEC Form 4 and STOCK Act filings. It's information, not investment advice, and past insider trades don't predict how a stock will do.";

export function shell({ title, preheader = '', label = '', body, reason = '', appUrl = 'https://seli.app', address = '' }) {
  const pad = '&nbsp;&zwnj;'.repeat(90);
  const settings = `${appUrl}/account#emails`;
  const footer = `<div style="height:1px;background:${C.border};margin:0 0 16px;line-height:1px;font-size:1px;">&nbsp;</div>`
    + p(`${esc(reason)} ${DISCLAIMER}`.trim(), { size: 11, color: C.faint, margin: '0 0 8px' })
    + p(a(settings, 'Email settings', C.muted), { size: 11, color: C.faint, margin: '0' })
    + (address ? p(esc(address).replace(/ /g, ' &#8203;'), { size: 11, color: C.faint, margin: '6px 0 0' }) : '');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${esc(title)}</title>
<style>@media (max-width:520px){ .px{padding-left:18px!important;padding-right:18px!important} } a{color:${C.accent}}</style></head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(preheader)}${pad}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};"><tr><td align="center" style="padding:24px 10px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.bg};border-radius:14px;overflow:hidden;">
  <tr><td style="height:4px;line-height:4px;font-size:4px;background:${C.accent};background-image:linear-gradient(90deg,${C.accent} 0%,${C.accentStr} 60%,${C.aqua} 100%);">&nbsp;</td></tr>
  <tr><td class="px" style="padding:20px 28px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td><a href="${esc(appUrl)}" style="font-family:${FONT};font-size:20px;font-weight:800;color:${C.text};text-decoration:none;letter-spacing:-.4px;">Seli</a></td>
    <td style="text-align:right;font-family:${FONT};font-size:12px;font-weight:600;color:${C.muted};">${esc(label)}</td>
  </tr></table></td></tr>
  <tr><td class="px" style="padding:22px 28px 0;">${body}</td></tr>
  <tr><td class="px" style="padding:30px 28px 26px;">${footer}</td></tr>
</table></td></tr></table>
</body></html>`;
}

// Plain-text version from the HTML (multipart helps deliverability).
export function toText(html) {
  return String(html)
    .replace(/<(head|style|script)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<div style="display:none[\s\S]*?<\/div>/i, '')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => `${label.replace(/<[^>]+>/g, '').trim()} (${href.replace(/&amp;/g, '&')})`)
    .replace(/<\/(p|div|tr|h\d|li|table)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&zwnj;|&#8203;/g, ' ').replace(/&#10003;/g, '- ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter((l, i, arr) => l || (arr[i - 1] && arr[i - 1].trim()))
    .join('\n').trim() + '\n';
}

export async function sendEmail(env, { to, subject, html, fromName = 'Seli', fromEmail, replyTo, tag }) {
  const from = `"${fromName}" <${fromEmail || env.ALERTS_FROM_EMAIL || 'alerts@mail.seli.app'}>`;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: Array.isArray(to) ? to : [to], subject, html, text: toText(html),
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(tag ? { tags: [{ name: 'kind', value: tag }] } : {}),
    }),
  });
  if (!resp.ok) throw new Error(`Resend ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
  return true;
}

// ── The emails ───────────────────────────────────────────────────────────────

export function dataExportEmail({ orderId, email, through, downloadUrl, appUrl = 'https://seli.app', address = '' }) {
  const subject = 'Your Seli dataset is ready';
  const body = p('Thanks for buying the Seli dataset. Your download is ready now.')
    + details([['Order number', orderId, true], ['Email', email], ['Data through', through]])
    + button('Download your dataset', downloadUrl || `${appUrl}/redownload`)
    + p(`<b style="color:${C.text};">Keep this email.</b> You can download the same file again any time, at no charge, at ${a(`${appUrl}/redownload`, 'seli.app/redownload')} with your order number and email.`)
    + p(`It's a one-time purchase, a snapshot through ${esc(through)}. Buy again later for a fresh pull with newer filings.`, { size: 13, color: C.muted, margin: '0 0 6px' });
  return { subject, html: shell({ title: subject, preheader: `Order ${orderId}. Download it any time at seli.app/redownload.`, label: 'Receipt', body,
    reason: "You're getting this because you bought the Seli dataset.", appUrl, address }) };
}

export function proWelcomeEmail({ firstName, priceLabel, renews, since, appUrl = 'https://seli.app', address = '' }) {
  const subject = "You're on Seli Pro";
  // Tags go before the #section ("/account?utm_...#emails"), or the page can't find the section.
  const track = (path, c) => { const [base, hash] = path.split('#'); return `${appUrl}${base}${base.includes('?') ? '&' : '?'}utm_source=email&utm_medium=transactional&utm_content=${c}${hash ? `#${hash}` : ''}`; };
  const body = p(`Hey ${esc(firstName || 'there')},`)
    + p('Thanks for going Pro. It genuinely helps keep Seli running. Here\'s what just turned on:')
    + checks([
      'Watch as many stocks and people as you like',
      '<b>Same-day email alerts</b> when someone you watch files a trade',
      'A daily brief on weekday mornings',
      `Full history${since ? ` back to ${esc(since)}` : ''} and the full leaderboard`,
    ])
    + p("Take a minute to check your alert settings, so the stocks and people you care about most email you the same day:", { margin: '0 0 6px' })
    + button('Set up my alerts', track('/account#emails', 'pro_welcome_alerts'))
    + p(`You're on ${esc(priceLabel)}${renews ? `, renewing ${esc(renews)}` : ''}. Receipts and your card are in ${a(track('/account#billing', 'pro_welcome_billing'), 'Settings, under Billing')}, and you can cancel there any time.`)
    + p("If anything's off or missing, just reply. It comes straight to me.", { margin: '0 0 18px' })
    + signOff();
  return { subject, html: shell({ title: subject, preheader: 'Same-day alerts, unlimited watching, full history. Set up your alerts.', label: 'Seli Pro', body,
    reason: "You're getting this because you subscribed to Seli Pro.", appUrl, address }) };
}

export function testEmail({ appUrl = 'https://seli.app', address = '' }) {
  const subject = 'Seli test email';
  const body = p("This is a test email from Seli. If you're reading it, email delivery to you works.")
    + p('Real digests and alerts look like this, filled in with the insider trades that match your settings.', { color: C.muted, size: 14 })
    + button('Open Seli', appUrl);
  return { subject, html: shell({ title: subject, preheader: 'Your Seli emails are reaching you.', label: 'Test', body,
    reason: 'You asked for this test from your Seli settings.', appUrl, address }) };
}
