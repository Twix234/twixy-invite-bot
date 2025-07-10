module.exports = {
  apps: [{
    name: 'vk-bot',
    script: 'main.js',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production'
    }
  }]
};