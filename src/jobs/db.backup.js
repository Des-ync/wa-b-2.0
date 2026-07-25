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
    // The dump is a full copy of every tenant's data. A predictably-named file
    // sitting in the shared system temp dir under the default umask is
    // readable by any other local user for the whole duration of the dump —
    // so it goes in a per-run 0700 directory instead, and the file itself is
    // created 0600 before pg_dump writes a single byte into it.
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-b-backup-')); // mkdtemp(3) is always 0700
    const dumpFile = path.join(dumpDir, `wa-b-backup-${stamp}.sql.gz`);
    fs.closeSync(fs.openSync(dumpFile, 'w', 0o600));

    try {
      logger.info('[cron] db backup: starting pg_dump → %s', dumpFile);
      // Pass the connection string and output path through the environment
      // rather than interpolating into the command line: passwords with `$`,
      // `"` or backticks would otherwise be shell-expanded (breaking the dump
      // or worse), and the URL would leak into process listings via `ps`.
      //
      // `>>` rather than `>`: the file was pre-created with 0600 above and is
      // empty, and appending keeps those permissions instead of letting the
      // shell re-create it under the default umask.
      await execAsync(
        `pg_dump "$WA_B_DB_URL" | gzip >> "$WA_B_DUMP_FILE"`,
        {
          shell: '/bin/bash',
          maxBuffer: 1024 * 1024 * 64,
          env: {
            ...process.env,
            WA_B_DB_URL: process.env.DATABASE_URL,
            WA_B_DUMP_FILE: dumpFile
          }
        }
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
      // Remove the dump *and* its private directory, so a failed run doesn't
      // leave a full database copy on disk until the next reboot. Never let
      // cleanup trouble mask the real error from the try block.
      try {
        fs.rmSync(dumpDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        logger.error('[cron] db backup: could not remove %s: %s', dumpDir, cleanupErr.message);
      }
    }
  });
}

module.exports = { runDbBackupJob };
