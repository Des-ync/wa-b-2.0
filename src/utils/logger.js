const winston = require('winston');
const path = require('path');
const fs = require('fs');
// Lazy require to dodge a require cycle: requestContext has no deps of its
// own, but logger.js is required by nearly everything, so keep this import
// as narrow as possible.
const { getContext } = require('./requestContext');

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const { combine, timestamp, printf, colorize, errors, json, splat } = winston.format;

// Tags every log line with the current request id / tenant business id from
// AsyncLocalStorage, when a request is in flight — free tenant-scoped,
// correlatable logs without passing these through every function call.
const contextFormat = winston.format(info => {
  const ctx = getContext();
  if (ctx.requestId) info.request_id = ctx.requestId;
  if (ctx.businessId) info.business_id = ctx.businessId;
  return info;
});

const consoleFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} [${level}] ${stack || message}${metaStr}`;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    splat(),
    contextFormat(),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' })
  ),
  defaultMeta: { service: 'whatsapp-saas' },
  transports: [
    new winston.transports.Console({
      format: combine(
        colorize(),
        timestamp({ format: 'HH:mm:ss' }),
        consoleFormat
      )
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format: combine(timestamp(), json()),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      format: combine(timestamp(), json()),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5
    })
  ],
  exitOnError: false
});

module.exports = logger;
