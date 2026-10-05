module.exports = {
  apps: [
    {
      name: 'factory-desk',
      script: 'server/index.js',
      cwd: '/opt/factory-desk/current',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        FACTORY_SHARED_HOST: '0.0.0.0',
        FACTORY_SHARED_PORT: '8787',
        FACTORY_STORAGE_ROOT: '/opt/factory-desk/data',
        FACTORY_ADMIN_USERNAME: 'admin',
        FACTORY_ADMIN_PASSWORD: 'ChangeToStrongPassword!'
      }
    }
  ]
};
