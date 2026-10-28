/**
 * PM2 config for the Zalo bot.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup        # then run exactly the line it prints
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
