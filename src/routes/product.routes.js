const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Same auth model as orders: admin keys see everything, tenant keys are
// pinned to their own business_id.
router.use(requireAuth('any'));

function tenantBlocksBusinessId(req, businessId) {
  if (req.auth?.scope === 'admin') return false;
  if (!req.auth?.businessId) return true;
  return businessId && businessId !== req.auth.businessId;
}

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
      `SELECT * FROM products WHERE business_id = $1 ORDER BY category ASC, name ASC`,
      [businessId]
    );
    res.json({ success: true, products: result.rows });
  } catch (err) {
    logger.error('GET /products failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** POST /api/products — create. Body: { business_id?, name, price_ghs, description?, category?, in_stock?, image_url? } */
router.post('/', async (req, res) => {
  try {
    const businessId = req.body?.business_id || req.auth?.businessId;
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const { errors, out } = validateProductBody(req.body || {});
    if (errors.length) return res.status(400).json({ success: false, error: errors.join('; ') });

    const result = await query(
      `INSERT INTO products (business_id, name, description, price_ghs, category, in_stock, image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        businessId, out.name, out.description ?? null, out.price_ghs,
        out.category || 'general', out.in_stock ?? true, out.image_url ?? null
      ]
    );
    res.status(201).json({ success: true, product: result.rows[0] });
  } catch (err) {
    logger.error('POST /products failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** PATCH /api/products/:id — update any subset of fields. */
router.patch('/:id', async (req, res) => {
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
    res.json({ success: true, product: result.rows[0] });
  } catch (err) {
    logger.error('PATCH /products/:id failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** DELETE /api/products/:id — remove a product (order history keeps its own snapshot). */
router.delete('/:id', async (req, res) => {
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

module.exports = router;
