const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const logger = require('../utils/logger');
const lock = require('../services/worker.lock');
const { alertOps } = require('../services/alert.service');

const execAsync = util.promisify(exec);

/**
 * Nightly pg_dump → gzip → object storage. Opt-in via DB_BACKUP_ENABLED so a
 * box without pg_dump/a configured upload command doesn't fail loudly by
 * default.
 *
 * DB_BACKUP_UPLOAD_CMD is a shell command template with a {file} placeholder,
 * left generic on purpose so it works with whatever's already on the host —
 * the AWS CLI against Oracle Object Storage's S3-compatible endpoint,
 * `rclone`, `b2`, scp, whatever. Example for Oracle Object Storage:
 *   DB_BACKUP_UPLOAD_CMD="aws --endpoint-url=https://<namespace>.compat.objectstorage.<region>.oraclecloud.com s3 cp {file} s3://<bucket>/db-backups/"
 */
async function runDbBackupJob() {
  if (process.env.DB_BACKUP_ENABLED !== 'true') return;

  await lock.withLock('db_backup_job', 3600, async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dumpFile = path.join(os.tmpdir(), `wa-b-backup-${stamp}.sql.gz`);

    try {
      logger.info('[cron] db backup: starting pg_dump → %s', dumpFile);
      await execAsync(
        `pg_dump "${process.env.DATABASE_URL}" | gzip > "${dumpFile}"`,
        { shell: '/bin/bash', maxBuffer: 1024 * 1024 * 64 }
      );

      const { size } = fs.statSync(dumpFile);
      if (size < 100) {
        throw new Error(`Dump file suspiciously small (${size} bytes) — pg_dump likely failed silently`);
      }
      logger.info('[cron] db backup: dump complete (%d bytes)', size);

      const uploadCmd = process.env.DB_BACKUP_UPLOAD_CMD;
      if (uploadCmd) {
        await execAsync(uploadCmd.replace('{file}', dumpFile), { shell: '/bin/bash' });
        logger.info('[cron] db backup: uploaded to object storage');
      } else {
        // DB_BACKUP_ENABLED=true with no upload destination means every
        // night's dump is produced then thrown away — that's not a backup,
        // it's wasted work, and worth a one-time-per-cooldown page rather
        // than a log line nobody will read until the day it's needed.
        logger.warn('[cron] db backup: DB_BACKUP_UPLOAD_CMD not set — dump discarded, nothing persisted');
        alertOps('DB backups are not actually going anywhere', 'DB_BACKUP_ENABLED=true but DB_BACKUP_UPLOAD_CMD is unset — every dump is discarded after this run.');
      }
    } catch (err) {
      logger.error('[cron] db backup failed: %s', err.message);
      alertOps('Nightly DB backup failed', err.message);
      throw err;
    } finally {
      fs.unlink(dumpFile, () => {});
    }
  });
}

module.exports = { runDbBackupJob };
