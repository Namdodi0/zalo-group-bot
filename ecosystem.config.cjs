/**
 * PM2 config cho bot Zalo.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup        # rồi chạy đúng dòng nó in ra
 */
module.exports = {
  apps: [
    {
      name: 'zalo-bot',
      cwd: __dirname,
      script: 'src/index.js',
      interpreter: 'node',
      node_args: '--env-file-if-exists=.env',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      max_memory_restart: '400M',
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
