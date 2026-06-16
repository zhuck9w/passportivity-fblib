// PM2 process manager config for the VPS — runs BOTH backends from this repo.
// Named .cjs (not .js) because package.json has "type": "module" and PM2 config must be CommonJS.
//
// Usage on the server (from the project root):
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup        # restart both processes on server reboot
//   pm2 logs interface             # tail one process
//   pm2 restart interface scraper  # after `git pull`
//
// Both processes read config from .env in this directory (dotenv in src/server/env.ts),
// so secrets/PROXY_URL live only in that .env, never in this file.
module.exports = {
  apps: [
    {
      name: 'interface',
      script: 'npm',
      args: 'run start:interface',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      env: { NODE_ENV: 'production' }
    },
    {
      name: 'scraper',
      script: 'npm',
      args: 'run start:scraper',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      // Scraper is a SINGLE long-lived instance (persistent Playwright profile + in-memory jobs).
      // Never scale this to multiple instances — one browser profile = one process.
      env: { NODE_ENV: 'production' }
    }
  ]
};
