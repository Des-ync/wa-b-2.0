const express = require('express');
const logger = require('../utils/logger');
const { query, transaction } = require('../config/database');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { tenantBlocksBusinessId, resolveBusinessId } = require('../middleware/tenantAccess');
const { recordAudit } = require('../utils/auditLog');

const router = express.Router();

// Same auth model as products: admin keys see everything, tenant keys are
// pinned to their own business_id. Inventory writes reuse the 'products'
// capability — it's the same merchant surface (catalog + stock), not a
// separate permission area (the RBAC matrix is deliberately coarse).
router.use(requireAuth('any'));

/* =================================================================
   Suppliers
   ================================================================= */

/** GET /api/inventory/suppliers?business_id= */
router.get('/suppliers', async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const result = await query(
      `SELECT * FROM suppliers WHERE business_id = $1 ORDER BY name ASC`,
      [businessId]
    );
    res.json({ success: true, suppliers: result.rows });
  } catch (err) {
    logger.error('GET /inventory/suppliers failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** POST /api/inventory/suppliers — { business_id?, name, contact_name?, contact_phone?, notes? } */
router.post('/suppliers', requirePermission('products', 'write'), async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const name = String(req.body?.name || '').trim();
    if (!name || name.length > 200) {
      return res.status(400).json({ success: false, error: 'name is required (max 200 chars)' });
    }
    const result = await query(
      `INSERT INTO suppliers (business_id, name, contact_name, contact_phone, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [
        businessId, name,
        req.body?.contact_name ? String(req.body.contact_name).trim().slice(0, 200) : null,
        req.body?.contact_phone ? String(req.body.contact_phone).trim().slice(0, 40) : null,
        req.body?.notes ? String(req.body.notes).trim().slice(0, 1000) : null
      ]
    );
    res.status(201).json({ success: true, supplier: result.rows[0] });
  } catch (err) {
    logger.error('POST /inventory/suppliers failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** PATCH /api/inventory/suppliers/:id */
router.patch('/suppliers/:id', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT business_id FROM suppliers WHERE id = $1', [req.params.id]);
    const supplier = existing.rows[0];
    if (!supplier) return res.status(404).json({ success: false, error: 'Supplier not found' });
    if (tenantBlocksBusinessId(req, supplier.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const sets = [];
    const params = [];
    const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if ('name' in (req.body || {})) {
      const v = String(req.body.name || '').trim();
      if (!v || v.length > 200) return res.status(400).json({ success: false, error: 'name is required (max 200 chars)' });
      set('name', v);
    }
    if ('contact_name' in (req.body || {})) set('contact_name', req.body.contact_name ? String(req.body.contact_name).trim().slice(0, 200) : null);
    if ('contact_phone' in (req.body || {})) set('contact_phone', req.body.contact_phone ? String(req.body.contact_phone).trim().slice(0, 40) : null);
    if ('notes' in (req.body || {})) set('notes', req.body.notes ? String(req.body.notes).trim().slice(0, 1000) : null);
    if (!sets.length) return res.status(400).json({ success: false, error: 'No recognized fields in body' });

    params.push(req.params.id);
    const result = await query(
      `UPDATE suppliers SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
      params
    );
    res.json({ success: true, supplier: result.rows[0] });
  } catch (err) {
    logger.error('PATCH /inventory/suppliers/:id failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * DELETE /api/inventory/suppliers/:id — products referencing this supplier
 * keep selling (supplier_id is ON DELETE SET NULL); this only removes the
 * vendor record itself, not their purchase history in stock_movements
 * (which also SET NULLs — the audit trail keeps the row, loses the label).
 */
router.delete('/suppliers/:id', requirePermission('products', 'write'), async (req, res) => {
  try {
    const existing = await query('SELECT business_id FROM suppliers WHERE id = $1', [req.params.id]);
    const supplier = existing.rows[0];
    if (!supplier) return res.status(404).json({ success: false, error: 'Supplier not found' });
    if (tenantBlocksBusinessId(req, supplier.business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    await query('DELETE FROM suppliers WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    logger.error('DELETE /inventory/suppliers/:id failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* =================================================================
   Restock (purchase stock intake)
   ================================================================= */

/**
 * POST /api/inventory/restock
 * Body: { business_id?, product_id, quantity (>0), unit_cost_ghs?, supplier_id?, note? }
 * Increments stock_qty, clears low_stock_notified when it rises back above
 * threshold, optionally records the latest cost price on the product, and
 * always writes a stock_movements row — this is the "purchase stock intake"
 * feature: a merchant restocking is an auditable event, not a silent number bump.
 */
router.post('/restock', requirePermission('products', 'write'), async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const productId = req.body?.product_id;
    const quantity = Number(req.body?.quantity);
    if (!productId) return res.status(400).json({ success: false, error: 'product_id is required' });
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ success: false, error: 'quantity must be a positive integer' });
    }
    let unitCost = null;
    if (req.body?.unit_cost_ghs !== undefined && req.body.unit_cost_ghs !== null && req.body.unit_cost_ghs !== '') {
      unitCost = Number(req.body.unit_cost_ghs);
      if (!Number.isFinite(unitCost) || unitCost < 0) {
        return res.status(400).json({ success: false, error: 'unit_cost_ghs must be a non-negative number' });
      }
    }
    const supplierId = req.body?.supplier_id || null;
    const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;

    const result = await transaction(async client => {
      const productRes = await client.query(
        `SELECT id, business_id, stock_qty, low_stock_threshold, low_stock_notified
           FROM products WHERE id = $1 AND business_id = $2 FOR UPDATE`,
        [productId, businessId]
      );
      const product = productRes.rows[0];
      if (!product) return { notFound: true };
      if (product.stock_qty === null) {
        return { untracked: true };
      }

      const newQty = product.stock_qty + quantity;
      const setUnitCost = unitCost !== null ? ', cost_price_ghs = $3' : '';
      const params = unitCost !== null
        ? [productId, newQty, unitCost]
        : [productId, newQty];
      const updateRes = await client.query(
        `UPDATE products
            SET stock_qty = $2, in_stock = TRUE,
                low_stock_notified = (CASE WHEN $2 > low_stock_threshold THEN FALSE ELSE low_stock_notified END)
                ${setUnitCost}
          WHERE id = $1 RETURNING *`,
        params
      );

      await client.query(
        `INSERT INTO stock_movements
           (business_id, product_id, type, quantity_delta, quantity_after, unit_cost_ghs, supplier_id, note, created_by)
         VALUES ($1,$2,'restock',$3,$4,$5,$6,$7,$8)`,
        [businessId, productId, quantity, newQty, unitCost, supplierId, note, req.auth?.keyId || req.auth?.clerkUserId || null]
      );

      return { product: updateRes.rows[0] };
    });

    if (result.notFound) return res.status(404).json({ success: false, error: 'Product not found' });
    if (result.untracked) {
      return res.status(400).json({ success: false, error: 'This product has untracked/unlimited stock (stock_qty is empty) — set a stock quantity on the product before restocking' });
    }
    recordAudit({
      actorType: req.auth?.scope === 'admin' ? 'admin' : 'merchant',
      actorId: req.auth?.clerkUserId || req.auth?.keyId,
      businessId, action: 'inventory.restock',
      detail: { product_id: productId, quantity, unit_cost_ghs: unitCost }
    });
    res.json({ success: true, product: result.product });
  } catch (err) {
    logger.error('POST /inventory/restock failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/inventory/adjust — manual correction (stock take, damage,
 * shrinkage) without pretending it's a purchase. Body: { business_id?,
 * product_id, new_quantity (>=0), note? }. Sets stock_qty to an exact value
 * rather than a delta — matches how a merchant actually counts a shelf.
 */
router.post('/adjust', requirePermission('products', 'write'), async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const productId = req.body?.product_id;
    const newQuantity = Number(req.body?.new_quantity);
    if (!productId) return res.status(400).json({ success: false, error: 'product_id is required' });
    if (!Number.isInteger(newQuantity) || newQuantity < 0) {
      return res.status(400).json({ success: false, error: 'new_quantity must be a non-negative integer' });
    }
    const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;

    const result = await transaction(async client => {
      const productRes = await client.query(
        `SELECT id, stock_qty, low_stock_threshold FROM products WHERE id = $1 AND business_id = $2 FOR UPDATE`,
        [productId, businessId]
      );
      const product = productRes.rows[0];
      if (!product) return { notFound: true };
      if (product.stock_qty === null) return { untracked: true };

      const delta = newQuantity - product.stock_qty;
      const updateRes = await client.query(
        `UPDATE products
            SET stock_qty = $2, in_stock = ($2 > 0),
                low_stock_notified = (CASE WHEN $2 > low_stock_threshold THEN FALSE ELSE low_stock_notified END)
          WHERE id = $1 RETURNING *`,
        [productId, newQuantity]
      );
      await client.query(
        `INSERT INTO stock_movements
           (business_id, product_id, type, quantity_delta, quantity_after, note, created_by)
         VALUES ($1,$2,'adjustment',$3,$4,$5,$6)`,
        [businessId, productId, delta, newQuantity, note, req.auth?.keyId || req.auth?.clerkUserId || null]
      );
      return { product: updateRes.rows[0] };
    });

    if (result.notFound) return res.status(404).json({ success: false, error: 'Product not found' });
    if (result.untracked) {
      return res.status(400).json({ success: false, error: 'This product has untracked/unlimited stock (stock_qty is empty)' });
    }
    recordAudit({
      actorType: req.auth?.scope === 'admin' ? 'admin' : 'merchant',
      actorId: req.auth?.clerkUserId || req.auth?.keyId,
      businessId, action: 'inventory.adjust',
      detail: { product_id: productId, new_quantity: newQuantity }
    });
    res.json({ success: true, product: result.product });
  } catch (err) {
    logger.error('POST /inventory/adjust failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/* =================================================================
   History and reorder suggestions
   ================================================================= */

/** GET /api/inventory/movements?business_id=&product_id=&limit= */
router.get('/movements', async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const params = [businessId];
    let where = 'sm.business_id = $1';
    if (req.query.product_id) {
      params.push(req.query.product_id);
      where += ` AND sm.product_id = $${params.length}`;
    }
    params.push(limit);
    const result = await query(
      `SELECT sm.*, p.name AS product_name, s.name AS supplier_name
         FROM stock_movements sm
         JOIN products p ON p.id = sm.product_id
         LEFT JOIN suppliers s ON s.id = sm.supplier_id
        WHERE ${where}
        ORDER BY sm.created_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ success: true, movements: result.rows });
  } catch (err) {
    logger.error('GET /inventory/movements failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/inventory/reorder-suggestions?business_id=
 * Products at or below their low-stock threshold, with a suggested reorder
 * quantity (enough to reach 3× the threshold — a simple, explainable buffer,
 * not a demand-forecasting model) and their default supplier if one is set.
 */
router.get('/reorder-suggestions', async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const result = await query(
      `SELECT p.id, p.name, p.category, p.stock_qty, p.low_stock_threshold,
              GREATEST(p.low_stock_threshold * 3 - p.stock_qty, p.low_stock_threshold + 1) AS suggested_reorder_qty,
              p.supplier_id, s.name AS supplier_name, s.contact_phone AS supplier_phone
         FROM products p
         LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.business_id = $1 AND p.stock_qty IS NOT NULL
          AND p.stock_qty <= p.low_stock_threshold AND p.hidden = FALSE
        ORDER BY p.stock_qty ASC`,
      [businessId]
    );
    res.json({ success: true, suggestions: result.rows });
  } catch (err) {
    logger.error('GET /inventory/reorder-suggestions failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/inventory/margins?business_id= — per-product cost vs. price. Static
 * unit economics only (price_ghs - cost_price_ghs); period-based COGS tied
 * to actual sales volume belongs to accounting exports, not here.
 */
router.get('/margins', async (req, res) => {
  try {
    const businessId = resolveBusinessId(req);
    if (!businessId) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, businessId)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const result = await query(
      `SELECT id, name, category, price_ghs, cost_price_ghs,
              CASE WHEN cost_price_ghs IS NOT NULL THEN ROUND(price_ghs - cost_price_ghs, 2) END AS margin_ghs,
              CASE WHEN cost_price_ghs IS NOT NULL AND price_ghs > 0
                   THEN ROUND(100 * (price_ghs - cost_price_ghs) / price_ghs, 1) END AS margin_pct
         FROM products
        WHERE business_id = $1 AND hidden = FALSE
        ORDER BY name ASC`,
      [businessId]
    );
    res.json({ success: true, products: result.rows });
  } catch (err) {
    logger.error('GET /inventory/margins failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
