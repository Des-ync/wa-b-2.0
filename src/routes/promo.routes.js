const express = require('express');
const logger = require('../utils/logger');
const { query } = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth('any'));

function tenantBlocksBusinessId(req, businessId) {
  if (req.auth?.scope === 'admin') return false;
  if (!req.auth?.businessId) return true;
  return businessId && businessId !== req.auth.businessId;
}

/** GET /api/promos?business_id= */
router.get('/', async (req, res) => {
  try {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    const r = await query(
      `SELECT id, code, type, value, expires_at, max_uses, used_count, active, created_at
         FROM promos
        WHERE business_id = $1
        ORDER BY created_at DESC`,
      [business_id]
    );
    res.json({ success: true, promos: r.rows });
  } catch (err) {
    logger.error('GET /promos failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/promos
 * Body: { business_id, code, type: 'percent'|'fixed', value, expires_at?, max_uses? }
 */
router.post('/', async (req, res) => {
  try {
    const { business_id, type, expires_at } = req.body || {};
    const code = String(req.body?.code || '').trim().toUpperCase();
    const value = Number(req.body?.value);
    const maxUses = req.body?.max_uses != null && req.body.max_uses !== ''
      ? parseInt(req.body.max_uses, 10) : null;

    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    if (!code || !/^[A-Z0-9_-]{2,32}$/.test(code)) {
      return res.status(400).json({ success: false, error: 'code must be 2-32 chars: letters, numbers, - or _' });
    }
    if (!['percent', 'fixed'].includes(type)) {
      return res.status(400).json({ success: false, error: "type must be 'percent' or 'fixed'" });
    }
    if (!(value > 0) || !Number.isFinite(value)) {
      return res.status(400).json({ success: false, error: 'value must be a positive number' });
    }
    if (type === 'percent' && value > 100) {
      return res.status(400).json({ success: false, error: 'percent value cannot exceed 100' });
    }
    if (maxUses !== null && !(maxUses > 0)) {
      return res.status(400).json({ success: false, error: 'max_uses must be a positive integer' });
    }

    const r = await query(
      `INSERT INTO promos (business_id, code, type, value, expires_at, max_uses)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, code, type, value, expires_at, max_uses, used_count, active, created_at`,
      [business_id, code, type, value, expires_at || null, maxUses]
    );
    res.status(201).json({ success: true, promo: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, error: 'A promo with this code already exists' });
    }
    logger.error('POST /promos failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** PATCH /api/promos/:id — toggle active, e.g. { business_id, active: false } */
router.patch('/:id', async (req, res) => {
  try {
    const { business_id } = req.body || {};
    if (!business_id) return res.status(400).json({ success: false, error: 'business_id required' });
    if (tenantBlocksBusinessId(req, business_id)) {
      return res.status(403).json({ success: false, error: 'Key does not match business' });
    }
    if (typeof req.body?.active !== 'boolean') {
      return res.status(400).json({ success: false, error: 'active (boolean) is required' });
    }
    const r = await query(
      `UPDATE promos SET active = $3 WHERE id = $1 AND business_id = $2
       RETURNING id, code, type, value, expires_at, max_uses, used_count, active, created_at`,
      [req.params.id, business_id, req.body.active]
    );
    if (!r.rowCount) return res.status(404).json({ success: false, error: 'Promo not found' });
    res.json({ success: true, promo: r.rows[0] });
  } catch (err) {
    logger.error('PATCH /promos/:id failed: %s', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
