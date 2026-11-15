// Vercel function: takes a message from the form on the site and forwards it by email through Resend.
// Settings (Vercel → Project → Settings → Environment Variables):
//   RESEND_API_KEY — API key from resend.com
//   CONTACT_TO     — where to deliver messages (the email of the Resend account owner)
//   CONTACT_FROM   — optional sender, e.g. "nullpoint <hello@1728.win>" once a domain is verified in Resend

const ALLOWED_ORIGINS = [/^https:\/\/nullpoint\.1728\.win$/, /^https:\/\/nullpoint-[a-z0-9-]+-kyomor1s-projects\.vercel\.app$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
const KINDS = { bug: 'Баг', idea: 'Идея', other: 'Другое' };
const LIMIT = { count: 5, windowMs: 10 * 60 * 1000 };
const hits = new Map(); // best-effort per-instance rate limit

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') return Promise.resolve(JSON.parse(req.body || '{}'));
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 20000) { reject(new Error('too_large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < LIMIT.windowMs);
  list.push(now);
  hits.set(ip, list);
  return list.length > LIMIT.count;
}

const clean = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const oneLine = v => v.replace(/\s+/g, ' ');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { error: 'method' }); }

  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.some(re => re.test(origin))) return json(res, 403, { error: 'origin' });

  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: 'body' }); }

  // Honeypot: real people never see this field, bots tend to fill it. Pretend success.
  if (clean(body.website, 200)) return json(res, 200, { ok: true });

  const message = clean(body.message, 4000);
  const app = oneLine(clean(body.app, 60)) || 'Не указано';
  const kind = KINDS[body.kind] || KINDS.other;
  const email = oneLine(clean(body.email, 200));
  const lang = body.lang === 'en' ? 'en' : 'ru';

  if (message.length < 10) return json(res, 400, { error: 'short' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json(res, 400, { error: 'email' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return json(res, 429, { error: 'rate' });

  const key = process.env.RESEND_API_KEY, to = process.env.CONTACT_TO;
  if (!key || !to) return json(res, 503, { error: 'not_configured' });

  const text = [
    `${kind} · ${app}`,
    `Язык сайта: ${lang.toUpperCase()}`,
    `Ответить: ${email || 'адрес не оставили'}`,
    '',
    message
  ].join('\n');

  const payload = {
    from: process.env.CONTACT_FROM || 'nullpoint <onboarding@resend.dev>',
    to: [to],
    subject: `[nullpoint] ${kind}: ${app}`,
    text
  };
  if (email) payload.reply_to = email;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) { console.error('resend', r.status, await r.text()); return json(res, 502, { error: 'send' }); }
  } catch (e) {
    console.error('resend', e);
    return json(res, 502, { error: 'send' });
  }
  return json(res, 200, { ok: true });
};
