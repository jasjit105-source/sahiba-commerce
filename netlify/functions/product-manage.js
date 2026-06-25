const { db, ok, preflight, badRequest, serverError, parseBody, getMLToken } = require('./_shared');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return preflight();

  const path = (event.path || '')
    .replace('/.netlify/functions/product-manage', '')
    .replace('/api/product-manage', '') || '/';

  const sql = db();

  try {
    // --- Upload picture to ML ---
    if (path === '/upload-picture' && event.httpMethod === 'POST') {
      const { image_base64, content_type } = parseBody(event);
      if (!image_base64) return badRequest('image_base64 required');

      const tok = await getMLToken(sql);
      if (!tok) return badRequest('Not connected to Mercado Libre');

      const pic = await uploadPictureToML(tok.access_token, image_base64, content_type || 'image/jpeg');
      return ok(pic);
    }

    // --- Create product on ML + store in DB ---
    if (path === '/create-product' && event.httpMethod === 'POST') {
      const body = parseBody(event);
      if (!body.title || !body.price) return badRequest('title and price required');

      const tok = await getMLToken(sql);
      if (!tok) return badRequest('Not connected to Mercado Libre');

      let categoryId = body.category_id;
      if (!categoryId) {
        categoryId = await predictCategory(tok.access_token, body.title);
        if (!categoryId) {
          const fb = await sql`
            SELECT category_id, COUNT(*)::int as cnt FROM commerce_products
            WHERE platform = 'meli' AND category_id IS NOT NULL
            GROUP BY category_id ORDER BY cnt DESC LIMIT 1
          `;
          categoryId = fb[0]?.category_id || 'MLM1430';
        }
      }

      const item = await createMLItem(tok.access_token, {
        title: body.title,
        category_id: categoryId,
        price: Number(body.price),
        stock: Number(body.stock) || 1,
        description: body.description || '',
        pictures: body.pictures || [],
        listing_type: body.listing_type || 'gold_special',
      });

      await sql`
        INSERT INTO commerce_products
          (platform, external_id, title, price, currency, stock, status,
           permalink, thumbnail, category_id, condition, listing_type,
           style_number, description_text, images, raw)
        VALUES
          ('meli', ${item.id}, ${item.title}, ${item.price},
           ${item.currency_id || 'MXN'}, ${item.available_quantity || 0},
           ${item.status}, ${item.permalink}, ${item.thumbnail},
           ${item.category_id}, ${item.condition}, ${item.listing_type_id},
           ${body.style_number || null}, ${body.description || null},
           ${JSON.stringify(item.pictures || [])}, ${JSON.stringify(item)})
        ON CONFLICT (platform, external_id) DO UPDATE SET
          title = EXCLUDED.title, price = EXCLUDED.price, stock = EXCLUDED.stock,
          status = EXCLUDED.status, permalink = EXCLUDED.permalink,
          thumbnail = EXCLUDED.thumbnail, style_number = EXCLUDED.style_number,
          description_text = EXCLUDED.description_text, images = EXCLUDED.images,
          raw = EXCLUDED.raw, synced_at = NOW()
      `;

      return ok({ success: true, item_id: item.id, permalink: item.permalink });
    }

    // --- Update product on ML + DB ---
    if (path === '/update-product' && event.httpMethod === 'PUT') {
      const body = parseBody(event);
      if (!body.external_id) return badRequest('external_id required');

      const tok = await getMLToken(sql);
      if (!tok) return badRequest('Not connected to Mercado Libre');

      const mlUpdates = {};
      if (body.title) mlUpdates.title = body.title;
      if (body.price) mlUpdates.price = Number(body.price);
      if (body.stock !== undefined && body.stock !== '') mlUpdates.available_quantity = Number(body.stock);
      if (body.status) mlUpdates.status = body.status;
      if (body.pictures) mlUpdates.pictures = body.pictures;

      let descText = null;
      if (body.description) descText = body.description;

      await updateMLItem(tok.access_token, body.external_id, mlUpdates, descText);

      await sql`
        UPDATE commerce_products SET
          title = COALESCE(${body.title || null}, title),
          price = COALESCE(${body.price ? Number(body.price) : null}, price),
          stock = ${body.stock !== undefined && body.stock !== '' ? Number(body.stock) : null}::int,
          description_text = COALESCE(${body.description || null}, description_text),
          style_number = COALESCE(${body.style_number || null}, style_number),
          synced_at = NOW()
        WHERE platform = 'meli' AND external_id = ${body.external_id}
      `;

      return ok({ success: true });
    }

    // --- Bulk create (PDF import) ---
    if (path === '/bulk-create' && event.httpMethod === 'POST') {
      const { products } = parseBody(event);
      if (!products?.length) return badRequest('products array required');

      const tok = await getMLToken(sql);
      if (!tok) return badRequest('Not connected to Mercado Libre');

      const fb = await sql`
        SELECT category_id, COUNT(*)::int as cnt FROM commerce_products
        WHERE platform = 'meli' AND category_id IS NOT NULL
        GROUP BY category_id ORDER BY cnt DESC LIMIT 1
      `;
      const defaultCat = fb[0]?.category_id || 'MLM1430';

      const results = [];
      for (const p of products) {
        if (!p.title || !p.price) {
          results.push({ style: p.style_number, success: false, error: 'Missing title or price' });
          continue;
        }
        try {
          let catId = await predictCategory(tok.access_token, p.title);
          if (!catId) catId = defaultCat;

          const item = await createMLItem(tok.access_token, {
            title: p.title,
            category_id: catId,
            price: Number(p.price),
            stock: Number(p.stock) || 1,
            description: p.description || '',
            pictures: p.pictures || [],
            listing_type: p.listing_type || 'gold_special',
          });

          await sql`
            INSERT INTO commerce_products
              (platform, external_id, title, price, currency, stock, status,
               permalink, thumbnail, category_id, condition, listing_type,
               style_number, description_text, raw)
            VALUES
              ('meli', ${item.id}, ${item.title}, ${item.price},
               ${item.currency_id || 'MXN'}, ${item.available_quantity || 0},
               ${item.status}, ${item.permalink}, ${item.thumbnail},
               ${item.category_id}, ${item.condition}, ${item.listing_type_id},
               ${p.style_number || null}, ${p.description || null},
               ${JSON.stringify(item)})
            ON CONFLICT (platform, external_id) DO NOTHING
          `;
          results.push({ style: p.style_number, success: true, item_id: item.id });
        } catch (err) {
          results.push({ style: p.style_number, success: false, error: err.message });
        }
      }
      return ok({ results });
    }

    // --- Predict category ---
    if (path === '/predict-category' && event.httpMethod === 'POST') {
      const { title } = parseBody(event);
      const tok = await getMLToken(sql);
      if (!tok) return badRequest('Not connected to ML');
      const catId = await predictCategory(tok.access_token, title || '');
      return ok({ category_id: catId });
    }

    // --- Get single product with full detail ---
    if (path.startsWith('/product/') && event.httpMethod === 'GET') {
      const extId = path.replace('/product/', '');
      const rows = await sql`
        SELECT id, external_id, title, price, currency, stock, status,
               permalink, thumbnail, listing_type, style_number, description_text,
               images, category_id, raw, synced_at
        FROM commerce_products
        WHERE platform = 'meli' AND external_id = ${extId}
        LIMIT 1
      `;
      if (!rows.length) return badRequest('Product not found');
      return ok(rows[0]);
    }

    return badRequest('Unknown path: ' + path);
  } catch (err) {
    return serverError(err);
  }
};

// ── ML API Helpers ──

async function uploadPictureToML(token, base64Data, contentType) {
  const buffer = Buffer.from(base64Data, 'base64');
  const boundary = '----Boundary' + Date.now().toString(36);
  const ext = contentType === 'image/png' ? 'png' : 'jpg';

  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="product.${ext}"\r\nContent-Type: ${contentType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(header),
    buffer,
    Buffer.from(footer),
  ]);

  const res = await fetch('https://api.mercadolibre.com/pictures/items/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Picture upload failed: ${res.status} ${err}`);
  }
  return res.json();
}

async function createMLItem(token, product) {
  const itemData = {
    title: product.title,
    category_id: product.category_id,
    price: product.price,
    currency_id: 'MXN',
    available_quantity: product.stock || 1,
    buying_mode: 'buy_it_now',
    listing_type_id: product.listing_type || 'gold_special',
    condition: 'new',
    sale_terms: [
      { id: 'WARRANTY_TYPE', value_name: 'Garantia del vendedor' },
      { id: 'WARRANTY_TIME', value_name: '30 dias' },
    ],
  };
  if (product.description) {
    itemData.description = { plain_text: product.description };
  }
  if (product.pictures?.length) {
    itemData.pictures = product.pictures;
  }

  const res = await fetch('https://api.mercadolibre.com/items', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(itemData),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Item creation failed: ${res.status} ${err}`);
  }
  return res.json();
}

async function updateMLItem(token, itemId, updates, descText) {
  if (Object.keys(updates).length > 0) {
    const res = await fetch(`https://api.mercadolibre.com/items/${itemId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Item update failed: ${res.status} ${err}`);
    }
  }

  if (descText) {
    await fetch(`https://api.mercadolibre.com/items/${itemId}/description`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ plain_text: descText }),
    }).catch(() => {});
  }
}

async function predictCategory(token, title) {
  try {
    const res = await fetch(
      `https://api.mercadolibre.com/sites/MLM/category_predictor/predict?title=${encodeURIComponent(title)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.id || null;
  } catch {
    return null;
  }
}
