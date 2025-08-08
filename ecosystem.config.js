module.exports = {
  apps: [
    {
      name: "steam-game-updates-server",
      script: "./src/server/index.js",
      exec_interpreter: "node",
      node_args: "--max_old_space_size=16000 --max-http-header-size=16000",
      cwd: "./",
      instances: "max",
      exec_mode: "cluster",
      watch: true,
      ignore_watch: ["node_modules", "logs", "src/server/storage"],
      autorestart: true,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: '16G',
      stop_exit_codes: [0]
    }
  ]
};
