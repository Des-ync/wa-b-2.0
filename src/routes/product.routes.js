const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { tenantBlocksBusinessId } = require('../middleware/tenantAccess');
const { toCsv, parseCsv } = require('../utils/csv');
const orderService = require('../services/order.service');
const automations = require('../services/automations');

const router = express.Router();

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

// Same auth model as orders: admin keys see everything, tenant keys are
// pinned to their own business_id.
router.use(requireAuth('any'));

function validateProductBody(body, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 200) errors.push('name is required (max 200 chars)');
    out.name = name;
  }
  if (!partial || body.price_ghs !== undefined) {
    const price = Number(body.price_ghs);
    if (!Number.isFinite(price) || price < 0) errors.push('price_ghs must be a non-negative number');
    out.price_ghs = Math.round(price * 100) / 100;
  }
  if (body.description !== undefined) {
    out.description = body.description == null ? null : String(body.description).slice(0, 1000);
  }
  if (body.category !== undefined) {
    out.category = String(body.category || 'general').trim().toLowerCase().slice(0, 60) || 'general';
  }
  if (body.in_stock !== undefined) {
    out.in_stock = !!body.in_stock;
  }
  if (body.image_url !== undefined) {
    out.image_url = body.image_url == null ? null : String(body.image_url).slice(0, 500);
  }
  if (body.stock_qty !== undefined) {
    if (body.stock_qty === null || body.stock_qty === '') {
      out.stock_qty = null; // untracked/unlimited
    } else {
      const qty = Number(body.stock_qty);
      if (!Number.isInteger(qty) || qty < 0) errors.push('stock_qty must be a non-negative integer, or empty for untracked');
      out.stock_qty = qty;
      // A merchant setting real stock back above zero clearly means "in stock"
      // and clears any stale low-stock nudge state — keep both in sync here
      // rather than making the merchant flip in_stock separately.
      if (qty > 0 && body.in_stock === undefined) out.in_stock = true;
      if (qty === 0 && body.in_stock === undefined) out.in_stock = false;
      // A merchant manually setting stock back up means they've restocked —
      // clear the nudge flag so a future dip notifies again.
      if (qty > 0) out.low_stock_notified = false;
    }
  }
  if (body.low_stock_threshold !== undefined) {
    const n = Number(body.low_stock_threshold);
    if (!Number.isInteger(n) || n < 0) errors.push('low_stock_threshold must be a non-negative integer');
    out.low_stock_threshold = n;
  }
  if (body.cost_price_ghs !== undefined) {
    if (body.cost_price_ghs === null || body.cost_price_ghs === '') {
      out.cost_price_ghs = null;
    } else {
      const n = Number(body.cost_price_ghs);
      if (!Number.isFinite(n) || n < 0) errors.push('cost_price_ghs must be a non-negative number, or empty to clear it');
      out.cost_price_ghs = Math.round(n * 100) / 100;
    }
  }
  if (body.supplier_id !== undefined) {
    out.supplier_id = body.supplier_id || null;
  }
  if (body.featured !== undefined) out.featured = !!body.featured;
  if (body.hidden !== undefined) out.hidden = !!body.hidden;
  if (body.sort_order !== undefined) {
    const n = Number(body.sort_order);
    if (!Number.isInteger(n)) errors.push('sort_order must be an integer');
    out.sort_order = n;
  }
  for (const col of ['available_from', 'available_to']) {
    if (body[col] !== undefined) {
      const v = String(body[col] || '').trim();
      if (v && !TIME_RE.test(v)) errors.push(`${col} must be HH:MM (24h)`);
      out[col] = v || null;
    }
  }
  return { errors, out };
}

function validateVariantBody(body, { partial = false } = {}) {
  const errors = [];
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 100) errors.push('name is required (max 100 chars)');
    out.name = name;
  }
  if (body.price_delta_ghs !== undefined) {
    const n = Number(body.price_delta_ghs);
    if (!Number.isFinite(n)) errors.push('price_delta_ghs must be a number');
    out.price_delta_ghs = Math.round(n * 100) / 100;
  }
  if (body.stock_qty !== undefined) {
    if (body.stock_qty === null || body.stock_qty === '') {
      out.stock_qty = null;
    } else {
      const n = Number(body.stock_qty);
      if (!Number.isInteger(n) || n < 0) errors.push('stock_qty must be a non-negative integer, or empty for untracked');
      out.stock_qty = n;
    }
  }
  if (body.sort_order !== undefined) {
    const n = Number(body.sort_order);
    if (!Number.isInteger(n)) errors.push('sort_order must be an integer');
    out.sort_order = n;
  }
  return { errors, out };
}

function validateAddonBody(body, { partial = false } = {}) {
  const errors = [];
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 100) errors.push('name is required (max 100 chars)');
    out.name = name;
  }
  if (!partial || body.price_ghs !== undefined) {
    const n = Number(body.price_ghs);
    if (!Number.isFinite(n) || n < 0) errors.push('price_ghs must be a non-negative number');
    out.price_ghs = Math.round(n * 100) / 100;
  }
  if (body.sort_order !== undefined) {
    const n = Number(body.sort_order);
    if (!Number.isInteger(n)) errors.push('sort_order must be an integer');
    out.sort_order = n;
  }
  return { errors, out };
}

/** GET /api/products?business_id= — list a business's products. */
router.get('/', async (req, res) => {
  try {
    const businessId = req.query.business_id || req.auth?.businessId;
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const result = await query(
      `SELECT * FROM products WHERE business_id = $1 ORDER BY sort_order ASC, category ASC, name ASC`,
      [businessId]
    );
    res.json({ success: true, products: result.rows });
  } catch (err) {
    logger.error('GET /products failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/products — create. Body: { business_id?, name, price_ghs, description?,
 * category?, in_stock?, image_url?, stock_qty?, low_stock_threshold?, featured?,
 * hidden?, sort_order?, available_from?, available_to? }
 */
router.post('/', requirePermission('products', 'write'), async (req, res) => {
  try {
    const businessId = req.body?.business_id || req.auth?.businessId;
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const { errors, out } = validateProductBody(req.body || {});
    if (errors.length) return res.status(400).json({ success: false, error: errors.join('; ') });

    const result = await query(
      `INSERT INTO products (
         business_id, name, description, price_ghs, category, in_stock, image_url, stock_qty,
         low_stock_threshold, featured, hidden, sort_order, available_from, available_to,
         cost_price_ghs, supplier_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        businessId, out.name, out.description ?? null, out.price_ghs,
        out.category || 'general', out.in_stock ?? true, out.image_url ?? null,
        out.stock_qty ?? null, out.low_stock_threshold ?? 3, out.featured ?? false,
        out.hidden ?? false, out.sort_order ?? 0, out.available_from ?? null, out.available_to ?? null,
        out.cost_price_ghs ?? null, out.supplier_id ?? null
      ]
    );
    res.status(201).json({ success: true, product: result.rows[0] });
  } catch (err) {
    logger.error('POST /products failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** PATCH /api/products/:id — update any subset of fields. */
router.patch('/:id', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    const product = existing.rows[0];
    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    if (tenantBlocksBusinessId(req, product.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }

    const { errors, out } = validateProductBody(req.body || {}, { partial: true });
    if (errors.length) return res.status(400).json({ success: false, error: errors.join('; ') });
    if (!Object.keys(out).length) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    const sets = [];
    const params = [req.params.id];
    for (const [col, val] of Object.entries(out)) {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }
    const result = await query(
      `UPDATE products SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    const updated = result.rows[0];

    // Back-in-stock alert: fire-and-forget, never blocks or fails the save.
    if (!product.in_stock && updated.in_stock) {
      automations.notifyProductRestocked(updated).catch(err =>
        logger.warn('notifyProductRestocked failed for product %s: %s', updated.id, err.message));
    }

    res.json({ success: true, product: updated });
  } catch (err) {
    logger.error('PATCH /products/:id failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** DELETE /api/products/:id — remove a product (order history keeps its own snapshot). */
router.delete('/:id', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    const product = existing.rows[0];
    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    if (tenantBlocksBusinessId(req, product.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    await query('DELETE FROM products WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    logger.error('DELETE /products/:id failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/products/:id/frequently-bought-with — items that most often
 * appear in the same paid order as this one, for the dashboard's upsell view.
 */
router.get('/:id/frequently-bought-with', async (req, res) => {
  try {
    const productRes = await query('SELECT id, business_id, name FROM products WHERE id = $1', [req.params.id]);
    const product = productRes.rows[0];
    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    if (tenantBlocksBusinessId(req, product.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const rows = await orderService.getFrequentlyBoughtWith(product.business_id, [product.name], { limit: 5 });
    res.json({ success: true, suggestions: rows });
  } catch (err) {
    logger.error('GET /products/:id/frequently-bought-with failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* ============================== Variants ============================== */

/** GET /api/products/:id/variants */
router.get('/:id/variants', async (req, res) => {
  try {
    const productRes = await query('SELECT id, business_id FROM products WHERE id = $1', [req.params.id]);
    const product = productRes.rows[0];
    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    if (tenantBlocksBusinessId(req, product.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const result = await query(
      'SELECT * FROM product_variants WHERE product_id = $1 ORDER BY sort_order ASC, name ASC',
      [req.params.id]
    );
    res.json({ success: true, variants: result.rows });
  } catch (err) {
    logger.error('GET /products/:id/variants failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** POST /api/products/:id/variants — { name, price_delta_ghs?, stock_qty?, sort_order? } */
router.post('/:id/variants', requirePermission('products', 'write'), async (req, res) => {
  try {
    const productRes = await query('SELECT id, business_id FROM products WHERE id = $1', [req.params.id]);
    const product = productRes.rows[0];
    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    if (tenantBlocksBusinessId(req, product.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const { errors, out } = validateVariantBody(req.body || {});
    if (errors.length) return res.status(400).json({ success: false, error: errors.join('; ') });

    const result = await query(
      `INSERT INTO product_variants (product_id, business_id, name, price_delta_ghs, stock_qty, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [product.id, product.business_id, out.name, out.price_delta_ghs ?? 0, out.stock_qty ?? null, out.sort_order ?? 0]
    );
    res.status(201).json({ success: true, variant: result.rows[0] });
  } catch (err) {
    logger.error('POST /products/:id/variants failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** PATCH /api/products/variants/:variantId */
router.patch('/variants/:variantId', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM product_variants WHERE id = $1', [req.params.variantId]);
    const variant = existing.rows[0];
    if (!variant) return res.status(404).json({ success: false, error: 'Variant not found' });
    if (tenantBlocksBusinessId(req, variant.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const { errors, out } = validateVariantBody(req.body || {}, { partial: true });
    if (errors.length) return res.status(400).json({ success: false, error: errors.join('; ') });
    if (!Object.keys(out).length) return res.status(400).json({ success: false, error: 'No fields to update' });

    const sets = [];
    const params = [req.params.variantId];
    for (const [col, val] of Object.entries(out)) {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }
    const result = await query(`UPDATE product_variants SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    res.json({ success: true, variant: result.rows[0] });
  } catch (err) {
    logger.error('PATCH /products/variants/:variantId failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** DELETE /api/products/variants/:variantId */
router.delete('/variants/:variantId', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM product_variants WHERE id = $1', [req.params.variantId]);
    const variant = existing.rows[0];
    if (!variant) return res.status(404).json({ success: false, error: 'Variant not found' });
    if (tenantBlocksBusinessId(req, variant.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    await query('DELETE FROM product_variants WHERE id = $1', [req.params.variantId]);
    res.json({ success: true });
  } catch (err) {
    logger.error('DELETE /products/variants/:variantId failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* =============================== Add-ons =============================== */

/** GET /api/products/:id/addons */
router.get('/:id/addons', async (req, res) => {
  try {
    const productRes = await query('SELECT id, business_id FROM products WHERE id = $1', [req.params.id]);
    const product = productRes.rows[0];
    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    if (tenantBlocksBusinessId(req, product.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const result = await query(
      'SELECT * FROM product_addons WHERE product_id = $1 ORDER BY sort_order ASC, name ASC',
      [req.params.id]
    );
    res.json({ success: true, addons: result.rows });
  } catch (err) {
    logger.error('GET /products/:id/addons failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** POST /api/products/:id/addons — { name, price_ghs, sort_order? } */
router.post('/:id/addons', requirePermission('products', 'write'), async (req, res) => {
  try {
    const productRes = await query('SELECT id, business_id FROM products WHERE id = $1', [req.params.id]);
    const product = productRes.rows[0];
    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    if (tenantBlocksBusinessId(req, product.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const { errors, out } = validateAddonBody(req.body || {});
    if (errors.length) return res.status(400).json({ success: false, error: errors.join('; ') });

    const result = await query(
      `INSERT INTO product_addons (product_id, business_id, name, price_ghs, sort_order)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [product.id, product.business_id, out.name, out.price_ghs, out.sort_order ?? 0]
    );
    res.status(201).json({ success: true, addon: result.rows[0] });
  } catch (err) {
    logger.error('POST /products/:id/addons failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** PATCH /api/products/addons/:addonId */
router.patch('/addons/:addonId', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM product_addons WHERE id = $1', [req.params.addonId]);
    const addon = existing.rows[0];
    if (!addon) return res.status(404).json({ success: false, error: 'Add-on not found' });
    if (tenantBlocksBusinessId(req, addon.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const { errors, out } = validateAddonBody(req.body || {}, { partial: true });
    if (errors.length) return res.status(400).json({ success: false, error: errors.join('; ') });
    if (!Object.keys(out).length) return res.status(400).json({ success: false, error: 'No fields to update' });

    const sets = [];
    const params = [req.params.addonId];
    for (const [col, val] of Object.entries(out)) {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }
    const result = await query(`UPDATE product_addons SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    res.json({ success: true, addon: result.rows[0] });
  } catch (err) {
    logger.error('PATCH /products/addons/:addonId failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** DELETE /api/products/addons/:addonId */
router.delete('/addons/:addonId', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM product_addons WHERE id = $1', [req.params.addonId]);
    const addon = existing.rows[0];
    if (!addon) return res.status(404).json({ success: false, error: 'Add-on not found' });
    if (tenantBlocksBusinessId(req, addon.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    await query('DELETE FROM product_addons WHERE id = $1', [req.params.addonId]);
    res.json({ success: true });
  } catch (err) {
    logger.error('DELETE /products/addons/:addonId failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* ============================ CSV import/export ========================= */

const CSV_COLUMNS = [
  'id', 'name', 'description', 'price_ghs', 'cost_price_ghs', 'category', 'in_stock', 'stock_qty',
  'low_stock_threshold', 'featured', 'hidden', 'available_from', 'available_to', 'image_url'
];

/** GET /api/products/export?business_id= — CSV download of the full catalog. */
router.get('/export', async (req, res) => {
  try {
    const businessId = req.query.business_id || req.auth?.businessId;
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const result = await query(
      `SELECT * FROM products WHERE business_id = $1 ORDER BY sort_order ASC, category ASC, name ASC`,
      [businessId]
    );
    const rows = result.rows.map(p => CSV_COLUMNS.map(col => p[col]));
    const csv = toCsv(CSV_COLUMNS, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="products-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    logger.error('GET /products/export failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/products/import — bulk create/update from CSV text.
 * Body: { business_id?, csv }. Rows with a matching `id` (belonging to this
 * business) are updated in place; all other rows are inserted. Malformed
 * rows are skipped and reported back rather than aborting the whole import.
 */
router.post('/import', requirePermission('products', 'write'), async (req, res) => {
  try {
    const businessId = req.body?.business_id || req.auth?.businessId;
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const csvText = req.body?.csv;
    if (!csvText || typeof csvText !== 'string') {
      return res.status(400).json({ success: false, error: 'csv (string) is required' });
    }

    const rows = parseCsv(csvText);
    if (!rows.length) return res.status(400).json({ success: false, error: 'CSV has no rows' });

    const header = rows[0].map(h => String(h || '').trim().toLowerCase());
    const dataRows = rows.slice(1);
    if (dataRows.length > 2000) {
      return res.status(400).json({ success: false, error: 'Import is limited to 2000 rows per file' });
    }

    let created = 0;
    let updated = 0;
    const skipped = [];

    // Only trust an `id` that already belongs to this business — prevents a
    // crafted CSV from overwriting another tenant's product by guessing UUIDs.
    const existingIdsRes = await query('SELECT id FROM products WHERE business_id = $1', [businessId]);
    const ownedIds = new Set(existingIdsRes.rows.map(r => r.id));

    for (let i = 0; i < dataRows.length; i++) {
      const cells = dataRows[i];
      const record = {};
      header.forEach((col, idx) => { record[col] = cells[idx]; });

      const bodyForValidation = {
        name: record.name,
        description: record.description || undefined,
        price_ghs: record.price_ghs,
        cost_price_ghs: record.cost_price_ghs === '' ? null : (record.cost_price_ghs || undefined),
        category: record.category || undefined,
        in_stock: record.in_stock === undefined ? undefined : /^(1|true|yes)$/i.test(String(record.in_stock).trim()),
        stock_qty: record.stock_qty === '' ? null : record.stock_qty,
        low_stock_threshold: record.low_stock_threshold || undefined,
        featured: record.featured === undefined ? undefined : /^(1|true|yes)$/i.test(String(record.featured).trim()),
        hidden: record.hidden === undefined ? undefined : /^(1|true|yes)$/i.test(String(record.hidden).trim()),
        available_from: record.available_from,
        available_to: record.available_to,
        image_url: record.image_url || undefined
      };

      const isUpdate = record.id && ownedIds.has(record.id);
      const { errors, out } = validateProductBody(bodyForValidation, { partial: isUpdate });
      if (errors.length) {
        skipped.push({ row: i + 2, name: record.name || '(no name)', errors });
        continue;
      }

      if (isUpdate) {
        const sets = [];
        const params = [record.id];
        for (const [col, val] of Object.entries(out)) {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        }
        if (sets.length) {
          await query(`UPDATE products SET ${sets.join(', ')} WHERE id = $1`, params);
          updated++;
        }
      } else {
        await query(
          `INSERT INTO products (
             business_id, name, description, price_ghs, category, in_stock, image_url, stock_qty,
             low_stock_threshold, featured, hidden, available_from, available_to, cost_price_ghs
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            businessId, out.name, out.description ?? null, out.price_ghs,
            out.category || 'general', out.in_stock ?? true, out.image_url ?? null,
            out.stock_qty ?? null, out.low_stock_threshold ?? 3, out.featured ?? false,
            out.hidden ?? false, out.available_from ?? null, out.available_to ?? null,
            out.cost_price_ghs ?? null
          ]
        );
        created++;
      }
    }

    res.json({ success: true, created, updated, skipped_count: skipped.length, skipped });
  } catch (err) {
    logger.error('POST /products/import failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* ============================== Bundles ================================= */
// Fixed-price groupings of existing products ("Lunch combo: Jollof + drink").
// Sold on the storefront and reorderable in WhatsApp as ONE line item priced
// at the bundle's own price_ghs — components are display-only metadata, not
// separately inventory-tracked (see migrate.js note on product_bundles).

function validateBundleBody(body, { partial = false } = {}) {
  const errors = [];
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 200) errors.push('name is required (max 200 chars)');
    out.name = name;
  }
  if (!partial || body.price_ghs !== undefined) {
    const price = Number(body.price_ghs);
    if (!Number.isFinite(price) || price < 0) errors.push('price_ghs must be a non-negative number');
    out.price_ghs = Math.round(price * 100) / 100;
  }
  if (body.description !== undefined) {
    out.description = body.description == null ? null : String(body.description).slice(0, 1000);
  }
  if (body.image_url !== undefined) {
    out.image_url = body.image_url == null ? null : String(body.image_url).slice(0, 500);
  }
  if (body.active !== undefined) out.active = !!body.active;
  if (body.sort_order !== undefined) {
    const n = Number(body.sort_order);
    if (!Number.isInteger(n)) errors.push('sort_order must be an integer');
    out.sort_order = n;
  }
  if (body.items !== undefined) {
    if (!Array.isArray(body.items) || !body.items.length) {
      errors.push('items must be a non-empty array of { product_id, quantity? }');
    } else if (body.items.some(it => !it || !it.product_id)) {
      errors.push('every item needs a product_id');
    } else {
      out.items = body.items.map(it => ({
        product_id: it.product_id,
        quantity: Number.isInteger(Number(it.quantity)) && Number(it.quantity) > 0 ? Number(it.quantity) : 1
      }));
    }
  }
  return { errors, out };
}

async function loadBundle(id) {
  const bundleRes = await query('SELECT * FROM product_bundles WHERE id = $1', [id]);
  const bundle = bundleRes.rows[0];
  if (!bundle) return null;
  const itemsRes = await query(
    `SELECT bi.product_id, bi.quantity, p.name, p.price_ghs, p.image_url
       FROM product_bundle_items bi JOIN products p ON p.id = bi.product_id
      WHERE bi.bundle_id = $1
      ORDER BY p.name ASC`,
    [id]
  );
  return { ...bundle, items: itemsRes.rows };
}

async function replaceBundleItems(bundleId, businessId, items) {
  const ownedRes = await query('SELECT id FROM products WHERE business_id = $1', [businessId]);
  const owned = new Set(ownedRes.rows.map(r => r.id));
  for (const it of items) {
    if (!owned.has(it.product_id)) throw Object.assign(new Error('One or more products do not belong to this business'), { status: 400 });
  }
  await query('DELETE FROM product_bundle_items WHERE bundle_id = $1', [bundleId]);
  for (const it of items) {
    await query(
      'INSERT INTO product_bundle_items (bundle_id, product_id, quantity) VALUES ($1,$2,$3)',
      [bundleId, it.product_id, it.quantity]
    );
  }
}

/** GET /api/products/bundles?business_id= */
router.get('/bundles', async (req, res) => {
  try {
    const businessId = req.query.business_id || req.auth?.businessId;
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const bundlesRes = await query(
      'SELECT * FROM product_bundles WHERE business_id = $1 ORDER BY sort_order ASC, name ASC',
      [businessId]
    );
    const itemsRes = await query(
      `SELECT bi.bundle_id, bi.product_id, bi.quantity, p.name, p.price_ghs
         FROM product_bundle_items bi JOIN products p ON p.id = bi.product_id
        WHERE bi.bundle_id = ANY($1::uuid[])`,
      [bundlesRes.rows.map(b => b.id)]
    );
    const byBundle = new Map();
    for (const it of itemsRes.rows) {
      if (!byBundle.has(it.bundle_id)) byBundle.set(it.bundle_id, []);
      byBundle.get(it.bundle_id).push(it);
    }
    const bundles = bundlesRes.rows.map(b => ({ ...b, items: byBundle.get(b.id) || [] }));
    res.json({ success: true, bundles });
  } catch (err) {
    logger.error('GET /products/bundles failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** POST /api/products/bundles — { business_id?, name, price_ghs, description?, image_url?, items: [{product_id, quantity?}] } */
router.post('/bundles', requirePermission('products', 'write'), async (req, res) => {
  try {
    const businessId = req.body?.business_id || req.auth?.businessId;
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const { errors, out } = validateBundleBody(req.body || {});
    if (!out.items) errors.push('items is required');
    if (errors.length) return res.status(400).json({ success: false, error: errors.join('; ') });

    const inserted = await query(
      `INSERT INTO product_bundles (business_id, name, description, price_ghs, image_url, active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [businessId, out.name, out.description ?? null, out.price_ghs, out.image_url ?? null, out.active ?? true, out.sort_order ?? 0]
    );
    const bundle = inserted.rows[0];
    await replaceBundleItems(bundle.id, businessId, out.items);
    res.status(201).json({ success: true, bundle: await loadBundle(bundle.id) });
  } catch (err) {
    logger.error('POST /products/bundles failed: %s', err.message);
    res.status(err.status || 500).json({ success: false, error: err.status ? err.message : 'Internal server error' });
  }
});

/** PATCH /api/products/bundles/:id */
router.patch('/bundles/:id', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM product_bundles WHERE id = $1', [req.params.id]);
    const bundle = existing.rows[0];
    if (!bundle) return res.status(404).json({ success: false, error: 'Bundle not found' });
    if (tenantBlocksBusinessId(req, bundle.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const { errors, out } = validateBundleBody(req.body || {}, { partial: true });
    if (errors.length) return res.status(400).json({ success: false, error: errors.join('; ') });

    const { items, ...columns } = out;
    if (Object.keys(columns).length) {
      const sets = [];
      const params = [bundle.id];
      for (const [col, val] of Object.entries(columns)) {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      }
      await query(`UPDATE product_bundles SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params);
    }
    if (items) await replaceBundleItems(bundle.id, bundle.business_id, items);
    res.json({ success: true, bundle: await loadBundle(bundle.id) });
  } catch (err) {
    logger.error('PATCH /products/bundles/:id failed: %s', err.message);
    res.status(err.status || 500).json({ success: false, error: err.status ? err.message : 'Internal server error' });
  }
});

/** DELETE /api/products/bundles/:id */
router.delete('/bundles/:id', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM product_bundles WHERE id = $1', [req.params.id]);
    const bundle = existing.rows[0];
    if (!bundle) return res.status(404).json({ success: false, error: 'Bundle not found' });
    if (tenantBlocksBusinessId(req, bundle.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    await query('DELETE FROM product_bundles WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    logger.error('DELETE /products/bundles/:id failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
