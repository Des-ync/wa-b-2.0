const test = require('node:test');
const assert = require('node:assert/strict');

const uploads = require('../src/routes/upload.routes');
const { identify, publicUrlFor } = uploads._testing;

/**
 * Product photo upload.
 *
 * The client resizes the photo and posts raw bytes, which means the server is
 * handed a Buffer and a Content-Type header chosen by the caller. The header
 * is a claim; the bytes are the fact. That distinction is what these tests are
 * about — files uploaded here are served back from our own origin, so a file
 * the browser decides is HTML would be same-origin script.
 */

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const webp = () => {
  const b = Buffer.alloc(24);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  return b;
};

test('identifies the three formats by their magic bytes', () => {
  assert.equal(identify(jpeg()).ext, 'jpg');
  assert.equal(identify(png()).ext, 'png');
  assert.equal(identify(webp()).ext, 'webp');
});

test('rejects a file that merely claims to be an image', () => {
  // The realistic attack: an HTML document posted as image/jpeg. Served back
  // from our own origin and sniffed as HTML, it would be same-origin script.
  const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');
  assert.equal(identify(html), null);
});

test('rejects an SVG, which is a script vector despite being an image', () => {
  // SVG is deliberately absent from the allowed list: it can carry <script>,
  // and browsers execute it when the file is navigated to directly.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal(identify(svg), null);
});

test('rejects a polyglot that starts as text and contains JPEG bytes later', () => {
  const sneaky = Buffer.concat([Buffer.from('GIF89a<script>'), jpeg()]);
  assert.equal(identify(sneaky), null);
});

test('rejects empty, tiny and non-buffer bodies rather than throwing', () => {
  for (const body of [null, undefined, '', Buffer.alloc(0), Buffer.alloc(4), 'a string']) {
    assert.equal(identify(body), null);
  }
});

test('a truncated RIFF header is not mistaken for WebP', () => {
  const b = Buffer.alloc(13);
  b.write('RIFF', 0, 'ascii');
  assert.equal(identify(b), null);
});

test('the served URL is business-scoped and under the routed prefix', () => {
  const url = publicUrlFor('biz-1', 'abc123.jpg');
  assert.equal(url, '/wa-b/uploads/biz-1/abc123.jpg');
  // /wa-b is already routed to this app, so uploads need no nginx change.
  assert.ok(url.startsWith('/wa-b/'));
});

test('the size cap is small enough to matter on a metered connection', () => {
  // The client resizes to ~150 KB; 2 MB is headroom, not an invitation.
  assert.ok(uploads.MAX_BYTES <= 2 * 1024 * 1024);
});

test('the upload directory is outside public/', () => {
  // Anything under public/ is served directly by express.static. Uploads are
  // served through their own mount with nosniff and a fixed disposition.
  assert.ok(!uploads.UPLOAD_DIR.split(require('path').sep).includes('public'),
    `UPLOAD_DIR must not be inside public/: ${uploads.UPLOAD_DIR}`);
});
