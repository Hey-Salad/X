module.exports = {
  apps: [
    {
      name: 'heysalad-deepseek-coder',
      script: 'agents/deepseek_api_agent.js',
      interpreter: 'node',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 5055,
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
        DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek-chat'
      },
      max_restarts: 5
    }
  ]
};
