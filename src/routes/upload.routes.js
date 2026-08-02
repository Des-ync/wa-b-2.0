const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { tenantBlocksBusinessId } = require('../middleware/tenantAccess');
const respond = require('../utils/response');

const router = express.Router();
router.use(requireAuth('any'));

/**
 * Product photo upload.
 *
 * Merchants could only paste a URL, which assumes they already host the image
 * somewhere — a fair assumption for a developer and a poor one for a shop
 * owner photographing shito on a phone.
 *
 * No multipart parser and no image library. The client resizes with a canvas
 * and posts the resulting bytes as the raw request body, so this reads a
 * Buffer and writes it. That avoids a native `sharp` build on the VM, and more
 * importantly it means the *phone* shrinks the photo before sending: a 4 MB
 * camera original becomes ~150 KB, and on a metered Ghanaian connection that
 * difference is the merchant's own money.
 *
 * The client is not trusted about any of it. Type comes from the magic bytes,
 * not the Content-Type header; the filename is generated here, never taken
 * from the request.
 */

/** Where the bytes live. Outside `public/` so nothing is served by accident. */
const UPLOAD_DIR = process.env.UPLOAD_DIR
  || path.join(__dirname, '..', '..', 'uploads');

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Signatures, checked against the actual bytes.
 *
 * A Content-Type header is a claim by the caller. Serving user-uploaded files
 * from our own origin means a file that the browser decides is HTML would be
 * same-origin script, so what matters is what the file *is*.
 */
const SIGNATURES = [
  { ext: 'jpg', mime: 'image/jpeg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', mime: 'image/png', test: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  {
    ext: 'webp',
    mime: 'image/webp',
    test: b => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'
  }
];

function identify(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  return SIGNATURES.find(s => s.test(buf)) || null;
}

/**
 * The public URL for a stored file.
 *
 * Under the `/wa-b` prefix deliberately: that path is already routed to this
 * app, so uploads need no change to the nginx config in front of it.
 */
function publicUrlFor(businessId, filename) {
  return `/wa-b/uploads/${businessId}/${filename}`;
}

/** POST /api/uploads/product-image?business_id= — raw image bytes as the body. */
router.post('/product-image', requirePermission('products', 'write'), async (req, res) => {
  try {
    const businessId = req.query.business_id || req.auth?.businessId;
    if (!businessId) {
      return respond.invalid(req, res, 'business_id required', { business_id: 'is required' });
    }
    if (tenantBlocksBusinessId(req, businessId)) {
      return respond.forbidden(req, res);
    }

    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return respond.invalid(req, res,
        'Send the image bytes as the request body.', { image: 'is required' });
    }
    if (buf.length > MAX_BYTES) {
      return respond.invalid(req, res,
        'That image is too large. Please choose a smaller photo.', { image: 'too large' });
    }

    const kind = identify(buf);
    if (!kind) {
      return respond.invalid(req, res,
        'That file is not a JPEG, PNG or WebP image.', { image: 'unsupported format' });
    }

    // Business-scoped directory, random filename. Never the client's name:
    // it could contain a path, a traversal, or an extension the browser
    // interprets as something other than an image.
    const dir = path.join(UPLOAD_DIR, String(businessId));
    await fsp.mkdir(dir, { recursive: true });
    const filename = `${crypto.randomBytes(16).toString('hex')}.${kind.ext}`;
    await fsp.writeFile(path.join(dir, filename), buf);

    logger.info('product image stored (%d bytes, %s) for business %s',
      buf.length, kind.mime, businessId);

    return respond.ok(req, res, {
      url: publicUrlFor(businessId, filename),
      bytes: buf.length,
      content_type: kind.mime
    }, { status: 201 });
  } catch (err) {
    return respond.failInternal(req, res, logger, 'POST /uploads/product-image', err);
  }
});

module.exports = router;
module.exports.UPLOAD_DIR = UPLOAD_DIR;
module.exports.MAX_BYTES = MAX_BYTES;
module.exports._testing = { identify, publicUrlFor, SIGNATURES };

// Created eagerly so a misconfigured path fails at boot, where somebody will
// see it, rather than on a merchant's first upload.
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
} catch (err) {
  logger.error('uploads: cannot create UPLOAD_DIR %s: %s', UPLOAD_DIR, err.message);
}
