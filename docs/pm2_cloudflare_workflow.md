# HeySalad GitHub Agent – PM2 & Cloudflare Access Guide

This playbook covers three layers:

1. Running long-lived agents (GitHub + Spotify concierge) under PM2 so they survive crashes/reboots.
2. Wiring PM2 into systemd to auto-respawn on boot.
3. Publishing the GitHub agent API over Cloudflare Tunnel at `https://api.heysalad.deepseek.coder.heysalad.app`.

> These commands assume Ubuntu/Debian, Node 18+, Python 3.10+, and that you cloned `~/heysalad-mcp`.

---

## 1. Install PM2 + Runtime Prereqs

```bash
# Node-based supervisor
npm install --global pm2

# Make sure the agents virtualenv exists
cd ~/heysalad-mcp/agents
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
deactivate
```

Add helper scripts in your shell profile:

```bash
cat <<'EOF' >> ~/.bashrc
alias hs_agents_venv='source ~/heysalad-mcp/agents/.venv/bin/activate'
EOF
```

---

## 2. PM2 Process Definitions

Create the ecosystem file `pm2/ecosystem.config.cjs` (example below) and adjust paths/ports as needed.

```js
module.exports = {
  apps: [
    {
      name: 'heysalad-github-agent',
      cwd: '/home/admin/heysalad-mcp',
      script: 'python',
      interpreter: '/home/admin/heysalad-mcp/agents/.venv/bin/python',
      args: 'agents/heysalad_github_agent_service.py --port 8700',
      env: {
        GITHUB_TOKEN: process.env.GITHUB_TOKEN,
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
        HEYSALAD_AGENT_REPO: '/home/admin/worktrees', // adjust
        GIT_SSH_COMMAND: 'ssh -F /home/admin/.ssh/config',
        GIT_AUTHOR_NAME: 'chilu18',
        GIT_AUTHOR_EMAIL: 'chilumba@agriweiss.com'
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '1G',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      name: 'spotify-llm-agent',
      cwd: '/home/admin/heysalad-mcp',
      script: 'python',
      interpreter: '/home/admin/heysalad-mcp/agents/.venv/bin/python',
      args: 'agents/spotify_llm_agent.py --history /home/admin/.cache/spotify_agent/history.json',
      env: {
        SPOTIFY_CLIENT_ID: process.env.SPOTIFY_CLIENT_ID,
        SPOTIFY_CLIENT_SECRET: process.env.SPOTIFY_CLIENT_SECRET,
        SPOTIFY_REFRESH_TOKEN: process.env.SPOTIFY_REFRESH_TOKEN,
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
        HF_TOKEN: process.env.HF_TOKEN,
      },
      autorestart: false,
      cron_restart: '0 * * * *',   // optional hourly refresh
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
```

Launch + persist:

```bash
cd ~/heysalad-mcp
pm2 start pm2/ecosystem.config.cjs
pm2 status
pm2 logs heysalad-github-agent --lines 100
```

Enable boot persistence:

```bash
pm2 startup systemd -u admin --hp /home/admin
pm2 save
```

Now every reboot will restore the processes and tail logs under `~/.pm2/logs/*.log`.

---

## 3. Cloudflare Tunnel (api.heysalad.deepseek.coder.heysalad.app)

1. Install Cloudflare’s daemon:
   ```bash
   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
   sudo dpkg -i /tmp/cloudflared.deb
   ```
2. Run the provided token once to create the tunnel + cert:
   ```bash
   cloudflared tunnel --no-autoupdate run --token RyKyRz5LQ4bV8gbDDvurCUohj-b5xJTu15JSjkYn
   ```
   Note the assigned tunnel ID (printed at startup). Cloudflare automatically provisions the backend in your account.
3. Create `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <TUNNEL-ID>
   credentials-file: /home/admin/.cloudflared/<TUNNEL-ID>.json
   ingress:
     - hostname: api.heysalad.deepseek.coder.heysalad.app
       service: http://localhost:8700   # GitHub agent HTTP port
     - service: http_status:404
   ```
4. Register the hostname (Cloudflare dashboard → Zero Trust → Networks → Tunnels → your tunnel → DNS → add CNAME for `api.heysalad.deepseek.coder.heysalad.app`).
5. Run cloudflared under PM2 so it restarts automatically:
   ```bash
   pm2 start cloudflared --name cf-heysalad-deepseek \
     -- tunnel --config /home/admin/.cloudflared/config.yml run
   pm2 save
   ```

### Access Guide

- Internal health check: `curl http://127.0.0.1:8700/healthz`
- External check (after DNS propagates): `curl https://api.heysalad.deepseek.coder.heysalad.app/healthz`
- Logs: `pm2 logs cf-heysalad-deepseek`

Use Cloudflare Access policies if you need SSO in front of the tunnel (Zero Trust → Access → Applications).

---

## 4. Operational Tips

- **Zero-downtime reloads**: `pm2 reload heysalad-github-agent` after deploying new code.
- **Version pinning**: commit `pm2/ecosystem.config.cjs` and `docs/pm2_cloudflare_workflow.md` so other operators can replicate the setup.
- **Secrets**: store tokens (GitHub, DeepSeek, Spotify) in a `.env.agent` file and `export $(cat .env.agent | xargs)` before running `pm2 start`.
- **Monitoring**: integrate PM2 with Keymetrics (`pm2 link <public> <secret>`) if you need remote dashboards.

With these pieces in place, the GitHub agent survives restarts, exposes an authenticated HTTPS endpoint via Cloudflare, and the Spotify concierge can be scheduled or hot-reloaded from the same supervisor.
