const logger = require('../utils/logger');

// SMTP is optional infrastructure: when SMTP_HOST/SMTP_USER/SMTP_PASS aren't
// set, sendMail() becomes a logged no-op instead of throwing, so the app
// still boots and the contact route can return a clear "not configured"
// error rather than crashing the process.
let transporter = null;
let initTried = false;

function init() {
  if (initTried) return transporter;
  initTried = true;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    logger.info('mail: SMTP_HOST/SMTP_USER/SMTP_PASS not set — outbound email disabled');
    return null;
  }
  const nodemailer = require('nodemailer');
  const port = Number(SMTP_PORT) || 587;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  logger.info('mail: SMTP transport configured (%s:%d)', SMTP_HOST, port);
  return transporter;
}

async function sendMail({ to, replyTo, subject, text }) {
  const t = init();
  if (!t) {
    const err = new Error('Email is not configured on this server');
    err.code = 'mail_not_configured';
    throw err;
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  await t.sendMail({ from, to, replyTo, subject, text });
}

module.exports = { sendMail };
