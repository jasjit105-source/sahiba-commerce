const { db, ok, preflight, serverError } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  try {
    const sql = db();
    const statements = [
      `CREATE TABLE IF NOT EXISTS commerce_tokens (
        id SERIAL PRIMARY KEY,
        platform TEXT NOT NULL DEFAULT 'meli',
        user_id TEXT,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at TIMESTAMP,
        scope TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_tokens_platform
       ON commerce_tokens(platform)`,

      `CREATE TABLE IF NOT EXISTS commerce_products (
        id SERIAL PRIMARY KEY,
        platform TEXT NOT NULL DEFAULT 'meli',
        external_id TEXT NOT NULL,
        title TEXT,
        price DOUBLE PRECISION,
        currency TEXT DEFAULT 'MXN',
        stock INTEGER DEFAULT 0,
        status TEXT,
        permalink TEXT,
        thumbnail TEXT,
        category_id TEXT,
        condition TEXT,
        listing_type TEXT,
        raw JSONB,
        synced_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(platform, external_id)
      )`,

      `CREATE TABLE IF NOT EXISTS commerce_orders (
        id SERIAL PRIMARY KEY,
        platform TEXT NOT NULL DEFAULT 'meli',
        external_id TEXT NOT NULL,
        pack_id TEXT,
        buyer_id TEXT,
        buyer_nickname TEXT,
        status TEXT,
        total DOUBLE PRECISION,
        currency TEXT DEFAULT 'MXN',
        date_created TIMESTAMP,
        shipping_id TEXT,
        tags TEXT DEFAULT '[]',
        items_json JSONB,
        raw JSONB,
        synced_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(platform, external_id)
      )`,

      `CREATE TABLE IF NOT EXISTS commerce_shipments (
        id SERIAL PRIMARY KEY,
        platform TEXT NOT NULL DEFAULT 'meli',
        external_id TEXT NOT NULL,
        order_id TEXT,
        status TEXT,
        logistic_type TEXT,
        mode TEXT,
        tracking_number TEXT,
        raw JSONB,
        synced_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(platform, external_id)
      )`,

      `CREATE TABLE IF NOT EXISTS commerce_ad_campaigns (
        id SERIAL PRIMARY KEY,
        platform TEXT NOT NULL DEFAULT 'meli',
        external_id TEXT NOT NULL,
        advertiser_id TEXT,
        name TEXT,
        status TEXT,
        budget DOUBLE PRECISION,
        strategy TEXT,
        acos_target DOUBLE PRECISION,
        raw JSONB,
        synced_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(platform, external_id)
      )`,

      `CREATE TABLE IF NOT EXISTS commerce_ad_metrics (
        id SERIAL PRIMARY KEY,
        platform TEXT NOT NULL DEFAULT 'meli',
        entity_type TEXT,
        entity_id TEXT,
        date DATE,
        clicks INTEGER DEFAULT 0,
        prints INTEGER DEFAULT 0,
        cost DOUBLE PRECISION DEFAULT 0,
        cpc DOUBLE PRECISION DEFAULT 0,
        acos DOUBLE PRECISION DEFAULT 0,
        roas DOUBLE PRECISION DEFAULT 0,
        units INTEGER DEFAULT 0,
        amount DOUBLE PRECISION DEFAULT 0,
        UNIQUE(platform, entity_type, entity_id, date)
      )`,

      `CREATE TABLE IF NOT EXISTS commerce_webhook_events (
        id SERIAL PRIMARY KEY,
        platform TEXT NOT NULL DEFAULT 'meli',
        topic TEXT,
        resource TEXT,
        received_at TIMESTAMP DEFAULT NOW(),
        processed INTEGER DEFAULT 0,
        raw JSONB
      )`,

      `CREATE INDEX IF NOT EXISTS idx_commerce_products_platform ON commerce_products(platform)`,
      `CREATE INDEX IF NOT EXISTS idx_commerce_orders_platform ON commerce_orders(platform)`,
      `CREATE INDEX IF NOT EXISTS idx_commerce_orders_status ON commerce_orders(status)`,
      `CREATE INDEX IF NOT EXISTS idx_commerce_orders_date ON commerce_orders(date_created)`,
    ];

    for (const stmt of statements) {
      await sql(stmt);
    }

    return ok({ success: true, tables: 7 });
  } catch (err) {
    return serverError(err);
  }
};
