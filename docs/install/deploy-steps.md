---
summary: "Step-by-step deploy: install deps, build, and run (local, Docker, or VPS)"
read_when:
  - You want a single reference for deploy commands
  - You are deploying to AWS, a VPS, or Docker
title: "Deploy steps (commands)"
---

# Deploy steps and commands

One-page reference: install dependencies, build, and run OpenClaw (from source, Docker, or on a VPS like AWS).

## Prerequisites

- **Node.js 22+** ([install guide](/install/node))
- **pnpm** (recommended; or npm). Repo uses `pnpm`; lockfile is `pnpm-lock.yaml`.
- **Git** (to clone the repo)

---

## Option A: From source (local or VPS)

### 1. Clone and enter repo

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

### 2. Install dependencies

```bash
pnpm install
```

- Installs root + workspace packages (including `extensions/*`, e.g. MongoDB plugin).
- If you see "Ignored build scripts" with pnpm, run:
  ```bash
  pnpm approve-builds -g
  ```
  and approve the listed packages (openclaw, sharp, etc.), then run `pnpm install` again.

### 3. Build

```bash
pnpm build
```

- Builds the main package and plugin SDK. For a full pack (including UI), use:
  ```bash
  pnpm ui:build
  pnpm build
  ```

### 4. (Optional) Link CLI globally

```bash
pnpm link --global
```

- So you can run `openclaw` from anywhere. Alternatively run via `pnpm openclaw ...` from the repo root.

### 5. Onboarding (first-time setup)

```bash
openclaw onboard --install-daemon
```

- Wizard: model auth, channels, gateway token, optional daemon (systemd).

### 6. Run the gateway

**Foreground (dev):**

```bash
openclaw gateway run
# or
pnpm openclaw gateway run
```

**With bind/port (e.g. for remote access):**

```bash
openclaw gateway run --bind lan --port 18789
```

**Production (systemd, Linux):** after `openclaw onboard --install-daemon`, the gateway runs as a user service:

```bash
systemctl --user status openclaw-gateway.service
journalctl --user -u openclaw-gateway.service -f
```

### 7. Verify

```bash
openclaw doctor
openclaw status
openclaw dashboard
```

---

## Option B: Docker (single machine or VPS)

### 1. Clone repo

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

### 2. Install dependencies and build (inside Docker)

Dockerfile runs install + build. Build the image:

```bash
docker build -t openclaw:local -f Dockerfile .
```

- Image build runs: `pnpm install --frozen-lockfile` → `pnpm build` → `pnpm ui:build`.

### 3. Create env and persist dirs

```bash
# Optional: copy and edit .env (see docker-compose or Hetzner guide)
mkdir -p ~/.openclaw/workspace
```

### 4. Run with Docker Compose

```bash
docker compose up -d openclaw-gateway
```

Or use the setup script (build + onboard + start):

```bash
./docker-setup.sh
```

### 5. Get dashboard URL / token

```bash
docker compose run --rm openclaw-cli dashboard --no-open
```

---

## Option C: Deploy on AWS (or any Linux VPS)

### 1. Provision a VM

- **AWS:** EC2 or Lightsail, Ubuntu 24.04 LTS, 1 vCPU + 1GB RAM minimum.
- Attach a security group that allows SSH (22) and, if you expose the gateway, the gateway port (e.g. 18789).

### 2. SSH and install Node 22 + Git

```bash
ssh ubuntu@YOUR_AWS_IP   # or ec2-user@... for Amazon Linux

sudo apt-get update && sudo apt-get upgrade -y
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v   # expect v22.x
```

### 3. Install pnpm (optional but recommended)

```bash
sudo npm install -g pnpm
# or: corepack enable && corepack prepare pnpm@latest --activate
```

### 4. Clone, install deps, build

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build
pnpm build
```

### 5. Onboarding

```bash
pnpm openclaw onboard --install-daemon
```

- Complete wizard (model auth, channels, token). For a server, you may bind to `lan` and protect with a token.

### 6. Run gateway (production)

**Option 6a: systemd (after onboarding with `--install-daemon`)**

```bash
systemctl --user start openclaw-gateway.service
systemctl --user enable openclaw-gateway.service
```

**Option 6b: manual (foreground)**

```bash
pnpm openclaw gateway run --bind lan --port 18789
```

**Option 6c: nohup (simple background)**

```bash
nohup pnpm openclaw gateway run --bind lan --port 18789 > /tmp/openclaw-gateway.log 2>&1 &
```

### 7. Access from your laptop

- **SSH tunnel (recommended):**

  ```bash
  ssh -L 18789:localhost:18789 ubuntu@YOUR_AWS_IP
  ```

  Then open `http://localhost:18789` and paste the gateway token.

- **Direct (only if you set a strong token and firewall):** open `http://YOUR_AWS_IP:18789` and use the token.

### 8. MongoDB / Azure Cosmos (your plugin)

- Ensure **Azure Cosmos DB firewall** allows your AWS instance’s **outbound IP**. Add that IP in Azure Portal → Cosmos DB account → Networking → Firewall.
- MongoDB plugin reads `uri` from plugin config or the default in `extensions/mongodb/index.ts`. Configure via OpenClaw config if you override the URI.

---

## Quick command reference

| Task                               | Command                                          |
| ---------------------------------- | ------------------------------------------------ |
| Install deps                       | `pnpm install`                                   |
| Build                              | `pnpm build`                                     |
| Build + UI                         | `pnpm ui:build && pnpm build`                    |
| Link CLI                           | `pnpm link --global`                             |
| First-time setup                   | `openclaw onboard --install-daemon`              |
| Run gateway (foreground)           | `openclaw gateway run`                           |
| Run gateway (bind all, port)       | `openclaw gateway run --bind lan --port 18789`   |
| Run gateway (allow without config) | `openclaw gateway run --allow-unconfigured`      |
| Check health                       | `openclaw doctor` / `openclaw status`            |
| Open dashboard                     | `openclaw dashboard`                             |
| Docker build                       | `docker build -t openclaw:local -f Dockerfile .` |
| Docker Compose up                  | `docker compose up -d openclaw-gateway`          |

---

## Environment variables (optional)

- `OPENCLAW_HOME` — base directory for internal paths.
- `OPENCLAW_STATE_DIR` — mutable state (config, credentials, sessions).
- `OPENCLAW_CONFIG_PATH` — config file path.
- `OPENCLAW_GATEWAY_TOKEN` — gateway auth token (when not in config).
- `OPENCLAW_GATEWAY_BIND` — bind mode (e.g. `lan`).
- `OPENCLAW_GATEWAY_PORT` — port (e.g. `18789`).

See [Environment](/help/environment) for full list and precedence.

---

## Troubleshooting

- **`openclaw` not found:** Ensure `$(pnpm root -g)/bin` or `$(npm prefix -g)/bin` is in your `PATH`, or run via `pnpm openclaw ...` from the repo.
- **Gateway won’t start:** Set `gateway.mode=local` in config or use `--allow-unconfigured` for dev.
- **New Telegram bot:** After creating a new bot in Telegram (e.g. via @BotFather), set `channels.telegram.botToken` to the new token in your OpenClaw config (`~/.openclaw/openclaw.json` or Gateway UI). MongoDB, tools, and schema stay the same; only the bot token changes. If you also moved the gateway to a new server, **Google Calendar/Gmail (gog) auth is per-environment** — re-run `gog auth add you@gmail.com --services calendar` (and Gmail if needed) on that server; see [gog skill](/tools/skills) troubleshooting.
- **MongoDB / mongo_export_csv “Server selection timed out”:** The gateway cannot reach the database. If the gateway runs on AWS or another cloud:
  1. In Azure Cosmos DB (or your MongoDB host), open **Networking** → **Firewall** and add this server’s **outbound IP** (or allow the cloud provider’s IP range for dev).
  2. Optionally set `plugins.mongodb.uri` (and `serverSelectionTimeoutMS` / `connectTimeoutMS` if you need longer timeouts) in config. Default timeouts are 30s.
- **`google_meet_create` tool not found:** The Google Calendar Meet plugin is bundled but **disabled by default**. Enable it and add it to the plugin allowlist, then set its config (OAuth or service account). In `~/.openclaw/openclaw.json` (or Gateway config):
  1. Add `"google-calendar-meet"` to `plugins.allow` (if you use an allowlist). If you don’t have `plugins.allow`, add it with the plugin ids you use, e.g. `"plugins": { "allow": ["telegram", "mongodb", "google-calendar-meet"] }`.
  2. Enable the plugin and set credentials: `"plugins": { "entries": { "google-calendar-meet": { "enabled": true, "config": { "clientId": "...", "clientSecret": "...", "refreshToken": "..." } } } }` (OAuth), or use `keyFile` / `credentialsJson` for a service account.
  3. Restart the gateway. The agent will then see the `google_meet_create` and `google_calendar_event_update` tools (create Meet; update existing event title and/or add attendees, same Meet link).
- **Build fails (sharp / native deps):** On macOS with Homebrew libvips, try `SHARP_IGNORE_GLOBAL_LIBVIPS=1 pnpm install`. Approve pnpm build scripts if prompted.
