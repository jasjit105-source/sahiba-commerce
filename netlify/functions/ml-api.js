const { db, ok, preflight, badRequest, serverError, getMLToken, mlFetch } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  const path = (event.path || '')
    .replace('/.netlify/functions/ml-api', '')
    .replace('/api/ml-api', '') || '/';

  const sql = db();

  try {
    // --- Token status ---
    if (path === '/status') {
      const rows = await sql`
        SELECT user_id, expires_at, scope, updated_at
        FROM commerce_tokens WHERE platform = 'meli' LIMIT 1
      `;
      if (!rows.length) return ok({ connected: false });
      const t = rows[0];
      return ok({
        connected: true,
        user_id: t.user_id,
        expires_at: t.expires_at,
        scope: t.scope,
        updated_at: t.updated_at,
        token_valid: new Date(t.expires_at) > new Date(),
      });
    }

    // --- Sync products from ML ---
    if (path === '/sync-products' && event.httpMethod === 'POST') {
      const tok = await getMLToken(sql);
      if (!tok) return badRequest('Not connected to Mercado Libre');

      let allIds = [];
      let offset = 0;
      const limit = 50;
      while (true) {
        const search = await mlFetch(tok.access_token,
          `/users/${tok.user_id}/items/search?status=active&offset=${offset}&limit=${limit}`);
        allIds = allIds.concat(search.results || []);
        if (offset + limit >= (search.paging?.total || 0)) break;
        offset += limit;
        if (allIds.length >= 500) break;
      }

      let synced = 0;
      for (let i = 0; i < allIds.length; i += 20) {
        const batch = allIds.slice(i, i + 20);
        const items = await mlFetch(tok.access_token,
          `/items?ids=${batch.join(',')}`);

        for (const wrapper of items) {
          const item = wrapper.body;
          if (!item || wrapper.code !== 200) continue;

          await sql`
            INSERT INTO commerce_products
              (platform, external_id, title, price, currency, stock, status,
               permalink, thumbnail, category_id, condition, listing_type, raw)
            VALUES
              ('meli', ${item.id}, ${item.title}, ${item.price},
               ${item.currency_id || 'MXN'}, ${item.available_quantity || 0},
               ${item.status}, ${item.permalink}, ${item.thumbnail},
               ${item.category_id}, ${item.condition}, ${item.listing_type_id},
               ${JSON.stringify(item)})
            ON CONFLICT (platform, external_id) DO UPDATE SET
              title = EXCLUDED.title,
              price = EXCLUDED.price,
              currency = EXCLUDED.currency,
              stock = EXCLUDED.stock,
              status = EXCLUDED.status,
              permalink = EXCLUDED.permalink,
              thumbnail = EXCLUDED.thumbnail,
              category_id = EXCLUDED.category_id,
              condition = EXCLUDED.condition,
              listing_type = EXCLUDED.listing_type,
              raw = EXCLUDED.raw,
              synced_at = NOW()
          `;
          synced++;
        }
      }

      return ok({ synced, total_ids: allIds.length });
    }

    // --- Sync orders from ML ---
    if (path === '/sync-orders' && event.httpMethod === 'POST') {
      const tok = await getMLToken(sql);
      if (!tok) return badRequest('Not connected to Mercado Libre');

      let allOrders = [];
      let offset = 0;
      const limit = 50;
      while (true) {
        const search = await mlFetch(tok.access_token,
          `/orders/search?seller=${tok.user_id}&sort=date_desc&offset=${offset}&limit=${limit}`);
        allOrders = allOrders.concat(search.results || []);
        if (offset + limit >= (search.paging?.total || 0)) break;
        offset += limit;
        if (allOrders.length >= 500) break;
      }

      let synced = 0;
      for (const order of allOrders) {
        const items = (order.order_items || []).map(oi => ({
          id: oi.item?.id,
          title: oi.item?.title,
          qty: oi.quantity,
          price: oi.unit_price,
        }));

        await sql`
          INSERT INTO commerce_orders
            (platform, external_id, pack_id, buyer_id, buyer_nickname,
             status, total, currency, date_created, shipping_id, tags, items_json, raw)
          VALUES
            ('meli', ${String(order.id)}, ${order.pack_id ? String(order.pack_id) : null},
             ${String(order.buyer?.id || '')}, ${order.buyer?.nickname || ''},
             ${order.status}, ${order.total_amount}, ${order.currency_id || 'MXN'},
             ${order.date_created}, ${order.shipping?.id ? String(order.shipping.id) : null},
             ${JSON.stringify(order.tags || [])}, ${JSON.stringify(items)},
             ${JSON.stringify(order)})
          ON CONFLICT (platform, external_id) DO UPDATE SET
            status = EXCLUDED.status,
            total = EXCLUDED.total,
            tags = EXCLUDED.tags,
            items_json = EXCLUDED.items_json,
            raw = EXCLUDED.raw,
            synced_at = NOW()
        `;
        synced++;
      }

      return ok({ synced, total: allOrders.length });
    }

    // --- Read products from DB ---
    if (path === '/products' && event.httpMethod === 'GET') {
      const rows = await sql`
        SELECT id, external_id, title, price, currency, stock, status,
               permalink, thumbnail, listing_type, synced_at
        FROM commerce_products
        WHERE platform = 'meli'
        ORDER BY title
      `;
      return ok({ products: rows });
    }

    // --- Read orders from DB ---
    if (path === '/orders' && event.httpMethod === 'GET') {
      const rows = await sql`
        SELECT id, external_id, buyer_nickname, status, total, currency,
               date_created, shipping_id, tags, items_json, synced_at
        FROM commerce_orders
        WHERE platform = 'meli'
        ORDER BY date_created DESC
        LIMIT 200
      `;
      return ok({ orders: rows });
    }

    // --- Dashboard KPIs ---
    if (path === '/dashboard' && event.httpMethod === 'GET') {
      const prodCount = await sql`
        SELECT COUNT(*) as count FROM commerce_products
        WHERE platform = 'meli' AND status = 'active'
      `;
      const orderStats = await sql`
        SELECT COUNT(*) as count,
               COALESCE(SUM(total), 0) as revenue
        FROM commerce_orders
        WHERE platform = 'meli'
          AND date_created >= NOW() - INTERVAL '30 days'
      `;
      const recentOrders = await sql`
        SELECT date_created::date as day, COUNT(*) as orders, SUM(total) as revenue
        FROM commerce_orders
        WHERE platform = 'meli' AND date_created >= NOW() - INTERVAL '30 days'
        GROUP BY day ORDER BY day
      `;
      const topProducts = await sql`
        SELECT
          oi->>'title' as title,
          SUM((oi->>'qty')::int) as units,
          SUM((oi->>'price')::numeric * (oi->>'qty')::int) as revenue
        FROM commerce_orders,
             jsonb_array_elements(items_json) as oi
        WHERE platform = 'meli' AND date_created >= NOW() - INTERVAL '30 days'
        GROUP BY oi->>'title'
        ORDER BY units DESC LIMIT 10
      `;
      const lowStock = await sql`
        SELECT external_id, title, stock, price
        FROM commerce_products
        WHERE platform = 'meli' AND status = 'active' AND stock <= 3
        ORDER BY stock, title
        LIMIT 20
      `;
      const lastSync = await sql`
        SELECT MAX(synced_at) as products_sync FROM commerce_products WHERE platform = 'meli'
      `;
      const lastOrderSync = await sql`
        SELECT MAX(synced_at) as orders_sync FROM commerce_orders WHERE platform = 'meli'
      `;

      return ok({
        active_products: Number(prodCount[0]?.count || 0),
        orders_30d: Number(orderStats[0]?.count || 0),
        revenue_30d: Number(orderStats[0]?.revenue || 0),
        avg_order: orderStats[0]?.count > 0
          ? Number(orderStats[0].revenue) / Number(orderStats[0].count)
          : 0,
        daily: recentOrders,
        top_products: topProducts,
        low_stock: lowStock,
        last_products_sync: lastSync[0]?.products_sync,
        last_orders_sync: lastOrderSync[0]?.orders_sync,
      });
    }

    return badRequest('Unknown path: ' + path);
  } catch (err) {
    return serverError(err);
  }
};
