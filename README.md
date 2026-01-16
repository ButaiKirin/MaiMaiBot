# MaiMai Telegram Bot

A Telegram bot that calls the McDonald's MCP tools (campaign calendar, coupons, and time info) via Streamable HTTP.

## Features

- Campaign calendar query (`campaign-calender`)
- Available coupons list (`available-coupons`)
- One-click claim all coupons (`auto-bind-coupons`)
- My coupons list (`my-coupons`)
- Current time info (`now-time-info`)
- Optional 5-minute cache for non-user-specific tools
- Daily auto-claim (once per day)

## Requirements

- Node.js 18+ (Node.js 20+ recommended)
- A Telegram bot token from BotFather
- An MCP token from https://open.mcd.cn/mcp/doc

## Quick Start

1. Copy `.env.example` to `.env` and fill in `TELEGRAM_BOT_TOKEN`.
2. Install dependencies:

```bash
npm install
```

3. Start the bot:

```bash
npm start
```

## Bot Commands

- `/token YOUR_MCP_TOKEN` - save your MCP token
- `/calendar [YYYY-MM-DD]` - campaign calendar (optional date)
- `/coupons` - available coupons
- `/claim` - one-click claim all available coupons
- `/mycoupons` - my coupons list
- `/time` - current time info
- `/autoclaim on|off` - enable/disable daily auto-claim
- `/status` - show token and auto-claim status
- `/cleartoken` - remove your token

## Environment Variables

See `.env.example` for all options. Key variables:

- `MCD_MCP_URL` (default: `https://mcp.mcd.cn/mcp-servers/mcd-mcp`)
- `CACHE_TTL_SECONDS` (default: `300`)
- `CACHEABLE_TOOLS` (default: `campaign-calender,now-time-info`)
- `AUTO_CLAIM_CHECK_MINUTES` (default: `10`)
- `AUTO_CLAIM_HOUR` (default: `9`)
- `AUTO_CLAIM_TIMEZONE` (default: `Asia/Shanghai`)

## Deployment

### 1) Install Node.js

```bash
sudo apt update
sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Verify:

```bash
node -v
npm -v
```

### 2) Install the bot

```bash
git clone <YOUR_REPO_URL> maimai-bot
cd maimai-bot
cp .env.example .env
```

Edit `.env` and set:

- `TELEGRAM_BOT_TOKEN`
- `MCD_MCP_URL` (optional)

Install dependencies:

```bash
npm install
```

Run once to verify:

```bash
npm start
```

### 3) Run as a systemd service

Create a service file:

```bash
sudo tee /etc/systemd/system/maimai-bot.service > /dev/null <<'SERVICE'
[Unit]
Description=MaiMai Telegram Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/maimai-bot
EnvironmentFile=/opt/maimai-bot/.env
ExecStart=/usr/bin/node /opt/maimai-bot/src/index.js
Restart=always
RestartSec=5
User=ubuntu
Group=ubuntu

[Install]
WantedBy=multi-user.target
SERVICE
```

Adjust paths and user:

```bash
sudo mkdir -p /opt
sudo mv ~/maimai-bot /opt/maimai-bot
sudo chown -R ubuntu:ubuntu /opt/maimai-bot
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now maimai-bot
```

View logs:

```bash
journalctl -u maimai-bot -f
```

### 4) Update

```bash
cd /opt/maimai-bot
git pull
npm install
sudo systemctl restart maimai-bot
```
