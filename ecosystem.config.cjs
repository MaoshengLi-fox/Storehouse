// PM2 process file for the production server.
//
// Secrets (admin password …) are NOT kept here. They live in a separate file on the server,
// by default /opt/factory-desk/factory.env (chmod 600, owned by the service user), written as
// KEY=VALUE lines — see deploy/factory.env.example. Set FACTORY_ENV_FILE to use another path.
const fs = require('node:fs');

const envFile = process.env.FACTORY_ENV_FILE || '/opt/factory-desk/factory.env';

function readEnvFile(file) {
  if (!fs.existsSync(file)) {
    console.warn(`[ecosystem] ${file} not found — using built-in defaults only. See DEPLOY_SERVER.md.`);
    return {};
  }
  const result = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[key] = value;
  }
  return result;
}

module.exports = {
  apps: [
    {
      name: 'factory-desk',
      script: 'server/index.js',
      cwd: '/opt/factory-desk/current',
      instances: 1, // SQLite + in-memory login throttle: keep a single process
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        FACTORY_SHARED_PORT: '8787',
        FACTORY_STORAGE_ROOT: '/opt/factory-desk/data',
        FACTORY_BUSINESS_TIMEZONE: 'Asia/Shanghai',
        ...readEnvFile(envFile),
        // Always loopback: the public entrance is Nginx.
        FACTORY_SHARED_HOST: '127.0.0.1'
      }
    }
  ]
};
