const { db, serverError } = require('./_shared');

exports.handler = async (event) => {
  const code = event.queryStringParameters?.code;
  if (!code) {
    return {
      statusCode: 302,
      headers: { Location: (process.env.APP_BASE_URL || '') + '/?error=no_code' },
      body: '',
    };
  }

  try {
    const res = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: process.env.ML_CLIENT_ID,
        client_secret: process.env.ML_CLIENT_SECRET,
        code,
        redirect_uri: process.env.ML_REDIRECT_URI,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Token exchange failed:', res.status, err);
      console.error('Request body was:', JSON.stringify({
        grant_type: 'authorization_code',
        client_id: process.env.ML_CLIENT_ID,
        client_secret: process.env.ML_CLIENT_SECRET ? '***set(' + process.env.ML_CLIENT_SECRET.length + ')' : '***MISSING',
        code: code ? code.substring(0, 8) + '...' : 'MISSING',
        redirect_uri: process.env.ML_REDIRECT_URI,
      }));
      return {
        statusCode: 302,
        headers: { Location: (process.env.APP_BASE_URL || '') + '/?error=token_exchange&detail=' + encodeURIComponent(err.substring(0, 200)) },
        body: '',
      };
    }

    const data = await res.json();
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

    const userRes = await fetch('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    const user = userRes.ok ? await userRes.json() : {};
    const userId = String(user.id || data.user_id || '');

    const sql = db();
    await sql`
      INSERT INTO commerce_tokens (platform, user_id, access_token, refresh_token, expires_at, scope)
      VALUES ('meli', ${userId}, ${data.access_token}, ${data.refresh_token}, ${expiresAt}, ${data.scope || ''})
      ON CONFLICT (platform)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        expires_at = EXCLUDED.expires_at,
        scope = EXCLUDED.scope,
        updated_at = NOW()
    `;

    return {
      statusCode: 302,
      headers: { Location: (process.env.APP_BASE_URL || '') + '/?connected=meli&user=' + userId },
      body: '',
    };
  } catch (err) {
    console.error('OAuth callback error:', err);
    return {
      statusCode: 302,
      headers: { Location: (process.env.APP_BASE_URL || '') + '/?error=callback_error' },
      body: '',
    };
  }
};
