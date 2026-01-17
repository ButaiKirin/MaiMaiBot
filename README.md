# MaiMai Telegram Bot

A Telegram bot that calls the McDonald's MCP tools (campaign calendar and coupons) via Streamable HTTP.

## Features

- Campaign calendar query (`campaign-calender`) via Telegraph article (with images)
- Available coupons list (`available-coupons`) via Telegraph article (with images)
- One-click claim all coupons (`auto-bind-coupons`)
- My coupons list (`my-coupons`)
- Optional 5-minute cache for non-user-specific tools
- Daily auto-claim (once per day) with burst scheduling when new coupons appear
- Multiple MCP accounts per Telegram user (switchable)

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
- `/account add <name> <token>` - add/update an account
- `/account use <name>` - switch active account
- `/account list` - list accounts
- `/account del <name>` - delete an account
- `/calendar [YYYY-MM-DD]` - campaign calendar (optional date)
- `/coupons` - available coupons
- `/claim` - one-click claim all available coupons
- `/mycoupons` - my coupons list
- `/autoclaim on|off [name]` - enable/disable daily auto-claim per account
- `/autoclaimreport success|fail on|off [name]` - enable/disable auto-claim reporting per account
- `/status` - show account status
- `/cleartoken` - clear all accounts

## Environment Variables

See `.env.example` for all options. Key variables:

- `MCD_MCP_URL` (default: `https://mcp.mcd.cn/mcp-servers/mcd-mcp`)
- `CACHE_TTL_SECONDS` (default: `300`)
- `CACHEABLE_TOOLS` (default: `campaign-calender,available-coupons`)
- `AUTO_CLAIM_CHECK_MINUTES` (default: `10`)
- `AUTO_CLAIM_HOUR` (default: `9`)
- `AUTO_CLAIM_TIMEZONE` (default: `Asia/Shanghai`)
- `AUTO_CLAIM_SPREAD_MINUTES` (default: `600`)
- `AUTO_CLAIM_MAX_PER_SWEEP` (default: `10`)
- `AUTO_CLAIM_REQUEST_GAP_MS` (default: `1500`)
- `GLOBAL_BURST_WINDOW_MINUTES` (default: `30`)
- `GLOBAL_BURST_CHECK_SECONDS` (default: `60`)

## Notes

- The bot uses MCP Streamable HTTP (protocol 2025-06-18).
- The MCP token is required for all tool calls.
- Telegraph access token is created automatically and stored at `data/telegraph.json`.
- Auto-claim runs once per account per day, scheduled across a spread window to avoid bursts.
- When any account claims a previously unseen coupon, the bot triggers a short burst window so all accounts attempt to claim within that time.

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
git clone https://github.com/ButaiKirin/MaiMaiBot.git
cd MaiMaiBot
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
WorkingDirectory=/opt/MaiMaiBot
EnvironmentFile=/opt/MaiMaiBot/.env
ExecStart=/usr/bin/node /opt/MaiMaiBot/src/index.js
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
sudo mv ~/MaiMaiBot /opt/MaiMaiBot
sudo chown -R ubuntu:ubuntu /opt/MaiMaiBot
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
cd /opt/MaiMaiBot
git pull
npm install
sudo systemctl restart maimai-bot
```
