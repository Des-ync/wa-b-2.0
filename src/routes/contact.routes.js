const express = require('express');
const logger = require('../utils/logger');
const mail = require('../services/mail.service');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUBJECTS = ['Sales / a demo', 'Technical support', 'Billing question', 'Partnership', 'Press / media', 'Something else'];
const CONTACT_TO = process.env.CONTACT_TO_EMAIL || 'dev@skes.tech';

// Strip line breaks so form input can never inject extra mail headers —
// nodemailer guards against this too, but this keeps the value sane either way.
const stripHeaderChars = s => String(s).replace(/[\r\n]+/g, ' ').trim();

router.post('/', async (req, res) => {
  const { name, email, subject, message, website } = req.body || {};

  // Honeypot: a real visitor never fills a field named/labeled for bots.
  if (website) return res.json({ success: true });

  if (typeof name !== 'string' || !name.trim() || name.length > 200) {
    return res.status(400).json({ success: false, error: 'Name is required' });
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email) || email.length > 320) {
    return res.status(400).json({ success: false, error: 'A valid email is required' });
  }
  if (typeof message !== 'string' || !message.trim() || message.length > 5000) {
    return res.status(400).json({ success: false, error: 'A message (max 5000 chars) is required' });
  }
  const safeSubject = SUBJECTS.includes(subject) ? subject : 'Something else';

  try {
    await mail.sendMail({
      to: CONTACT_TO,
      replyTo: stripHeaderChars(email),
      subject: `[Contact form] ${safeSubject} — ${stripHeaderChars(name)}`,
      text: `From: ${stripHeaderChars(name)} <${stripHeaderChars(email)}>\nTopic: ${safeSubject}\n\n${message.trim()}`
    });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'mail_not_configured') {
      logger.warn('contact: submission dropped — SMTP not configured');
      return res.status(503).json({ success: false, error: 'Message sending is temporarily unavailable. Please WhatsApp us instead.' });
    }
    logger.error('contact: failed to send: %s', err.message);
    res.status(502).json({ success: false, error: 'Could not send your message. Please try again or WhatsApp us instead.' });
  }
});

module.exports = router;
