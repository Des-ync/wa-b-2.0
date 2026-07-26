// PM2 process manager config for the Oracle Cloud app VM.
// Usage on the server:
//   pm2 start deploy/ecosystem.config.js
//   pm2 save && pm2 startup   (persist across reboots)
//   pm2 reload deploy/ecosystem.config.js   (zero-downtime reload on deploy)
module.exports = {
  apps: [
    {
      name: 'wa-saas-api',
      script: 'src/server.js',
      cwd: '/opt/wa-b-2.0',
      // Single fork instance — the Oracle Free Tier Ampere A1 shape this runs
      // on has limited vCPU/RAM headroom for cluster mode. The app already
      // supports horizontal scaling via RUN_CRON/RUN_PROCESSOR env flags
      // (src/server.js) if this ever needs instances > 1.
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production'
      },
      max_memory_restart: '600M',
      // src/server.js's gracefulShutdown() takes up to 10s to close the HTTP
      // server, stop cron, and drain the pg pool — this must exceed that or
      // PM2 SIGKILLs the process mid-shutdown on every reload/restart.
      kill_timeout: 12000,
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
      time: true
    }
  ]
};
