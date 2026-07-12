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
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production'
      },
      max_memory_restart: '600M',
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
      time: true
    }
  ]
};
