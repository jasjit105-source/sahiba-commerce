const { neon } = require('@neondatabase/serverless');

let _sql = null;
function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL not set');
    _sql = neon(url);
  }
  return _sql;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function preflight() {
  return { statusCode: 200, headers: CORS, body: '' };
}

function json(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

function ok(body) { return json(200, body); }
function badRequest(msg) { return json(400, { error: msg }); }
function serverError(err) {
  console.error('Function error:', err);
  return json(500, { error: err.message || String(err) });
}

function parseBody(event) {
  if (!event.body) return {};
  try { return JSON.parse(event.body); } catch { return {}; }
}

async function getMLToken(sql) {
  const rows = await sql`
    SELECT access_token, refresh_token, expires_at, user_id
    FROM commerce_tokens
    WHERE platform = 'meli'
    ORDER BY id DESC LIMIT 1
  `;
  if (!rows.length) return null;
  const tok = rows[0];

  if (new Date(tok.expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    const refreshed = await refreshMLToken(sql, tok.refresh_token);
    return refreshed;
  }
  return tok;
}

async function refreshMLToken(sql, refreshToken) {
  const res = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: process.env.ML_CLIENT_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ML token refresh failed: ${res.status} ${err}`);
  }
  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  await sql`
    UPDATE commerce_tokens
    SET access_token = ${data.access_token},
        refresh_token = ${data.refresh_token},
        expires_at = ${expiresAt}
    WHERE platform = 'meli'
  `;

  const rows = await sql`
    SELECT access_token, refresh_token, expires_at, user_id
    FROM commerce_tokens WHERE platform = 'meli' LIMIT 1
  `;
  return rows[0];
}

async function mlFetch(token, path) {
  const url = `https://api.mercadolibre.com${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ML API ${res.status}: ${body}`);
  }
  return res.json();
}

module.exports = {
  db, CORS, preflight, json, ok, badRequest, serverError, parseBody,
  getMLToken, refreshMLToken, mlFetch,
};
