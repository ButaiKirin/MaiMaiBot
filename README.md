# MaiMai Telegram Bot

A Telegram bot for McDonald's China MCP tools over Streamable HTTP.

## Current Interface Support

This project is aligned with the current official MCP documentation at [https://open.mcd.cn/mcp/doc](https://open.mcd.cn/mcp/doc), including the `2026-04-02` `v1.0.3` toolset.

It now handles the current interface changes:

- Uses the current canonical MCP URL `https://mcp.mcd.cn`
- Validates tokens through `tools/list` instead of hard-coding a single tool call
- Adapts to renamed tools:
  - `campaign-calender` -> `campaign-calendar`
  - `my-coupons` -> `query-my-coupons`
- Keeps compatibility with legacy tool names where possible
- Isolates cache entries by token to avoid cross-account result reuse

## Features

- Campaign calendar query via Telegraph article with images
- Available coupons list
- One-click claim all available coupons
- My coupons list
- My points query
- Nutrition list query with keyword filtering
- Points mall product list, detail, and redeem
- Delivery address list and create
- Nearby store search and favorite-store query
- Store coupon, meal list, meal detail, price calculation, order create/query
- Raw `/tool` passthrough for any currently exposed MCP tool
- Optional cache for selected tools
- Daily auto-claim with burst scheduling when new coupons appear
- Multiple MCP accounts per Telegram user

## Requirements

- Node.js 18+ (Node.js 20+ recommended)
- A Telegram bot token from BotFather
- An MCP token from https://open.mcd.cn/mcp

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

- `/help` - full command list
- `/tools` - list MCP tools available to the active account

Account and token:

- `/token YOUR_MCP_TOKEN` - save MCP token to the active/default account
- `/account add <name> <token>` - add/update an account
- `/account use <name>` - switch active account
- `/account list` - list accounts
- `/account del <name>` - delete an account
- `/cleartoken` - clear all accounts
- `/status` - show account status
- `/stats` - my claim stats

Coupon and calendar:

- `/calendar [YYYY-MM-DD]` - campaign calendar
- `/coupons` - available coupons
- `/claim` - one-click claim all available coupons
- `/mycoupons` - my coupons list
- `/autoclaim on|off [name]` - enable/disable daily auto-claim per account
- `/autoclaimreport success|fail on|off [name]` - enable/disable auto-claim reporting per account

Points, mall, time, nutrition:

- `/points` - my points account
- `/mall list` - points mall product list
- `/mall detail <spuId>` - points mall product detail
- `/mall redeem <skuId> [count]` - redeem a points mall item
- `/nutrition [keyword]` - nutrition list (optional local keyword filter)
- `/now` - MCP server current time info

Store and delivery:

- `/deliveryaddrs mls|group` - list delivery addresses
- `/deliveryadd mls|group 城市|联系人|电话|地址|门牌|性别(可选)` - create a delivery address
- `/stores fav` - query favorite in-store pickup stores
- `/stores search <city> <keyword>` - search nearby stores
- `/storecoupons <storeCode> <pickup|delivery> [beCode]` - list usable coupons for a store/order type
- `/meals <storeCode> <pickup|delivery> [beCode]` - list meals for a store/order type
- `/mealdetail <code> <storeCode> <pickup|delivery> [beCode]` - meal detail

Advanced order tools:

- `/price <json>` - call `calculate-price`
- `/order create <json>` - call `create-order`
- `/order query <orderId>` - call `query-order`
- `/tool <toolName> [json]` - raw passthrough for any current MCP tool

Admin:

- `/admin` - admin summary (users/accounts/auto-claim status/claim totals/config/sweep状态)
- `/admin notify on|off` - admin error push toggle
- `/admin sweep` - run a sweep immediately (admin)

### JSON command examples

```bash
/price {"storeCode":"12345","orderType":"pickup","items":[{"productCode":"9900008139","quantity":1}]}
/order create {"storeCode":"12345","orderType":"pickup","takeWayCode":"locker-in","items":[{"productCode":"9900008139","quantity":1}]}
/tool now-time-info
```

## Environment Variables

See `.env.example` for all options. Key variables:

- `MCD_MCP_URL` (default: `https://mcp.mcd.cn`)
- `MCP_REQUEST_TIMEOUT_MS` (default: `30000`)
- `MCP_CLIENT_CACHE_TTL_SECONDS` (default: `1800`)
- `MCP_RETRY_MAX` (default: `2`)
- `MCP_RETRY_BASE_DELAY_MS` (default: `500`)
- `MCP_RETRY_MAX_DELAY_MS` (default: `5000`)
- `MCP_RETRY_JITTER_MS` (default: `200`)
- `MCP_RETRY_STATUS_CODES` (default: `502,503,504`)
- `MCP_RETRY_ON_TIMEOUT` (default: `true`)
- `MCP_RETRY_ON_NETWORK_ERROR` (default: `true`)
- `MCP_HEALTH_CHECK_INTERVAL_MS` (default: `60000`)
- `MCP_HEALTH_CHECK_TIMEOUT_MS` (default: `5000`)
- `MCP_HEALTH_FAILURE_THRESHOLD` (default: `2`)
- `MCP_UPSTREAM_ERROR_MESSAGE` (default: Chinese "upstream error")
- `ACCOUNT_ID_MIN_LENGTH` (default: `1`)
- `ACCOUNT_ID_MAX_LENGTH` (default: `32`)
- `TOKEN_MIN_LENGTH` (default: `16`)
- `TOKEN_MAX_LENGTH` (default: `256`)
- `TOKEN_SET_RATE_LIMIT_MS` (default: `30000`)
- `ACCOUNT_SET_RATE_LIMIT_MS` (default: `30000`)
- `CACHE_TTL_SECONDS` (default: `300`)
- `CACHEABLE_TOOLS` (default: `campaign-calendar,list-nutrition-foods`)
- `AUTO_CLAIM_CHECK_MINUTES` (default: `10`)
- `AUTO_CLAIM_HOUR` (default: `9`)
- `AUTO_CLAIM_TIMEZONE` (default: `Asia/Shanghai`)
- `AUTO_CLAIM_SPREAD_MINUTES` (default: `600`)
- `AUTO_CLAIM_MAX_PER_SWEEP` (default: `10`)
- `AUTO_CLAIM_REQUEST_GAP_MS` (default: `1500`)
- `AUTO_CLAIM_SPREAD_RERUN_MINUTES` (default: `120`)
- `GLOBAL_BURST_WINDOW_MINUTES` (default: `30`)
- `GLOBAL_BURST_CHECK_SECONDS` (default: `30`)
- `ADMIN_TELEGRAM_IDS` (comma-separated Telegram user IDs)
- `SWEEP_WATCHDOG_SECONDS` (default: `60`)
- `SWEEP_STALE_MULTIPLIER` (default: `2`)
- `AUTO_CLAIM_DEBUG` (default: `false`, set to `true`/`1` to enable verbose auto-claim logs)

## Notes

- The bot uses MCP Streamable HTTP (protocol 2025-06-18).
- The MCP token is required for all tool calls.
- Official docs: [https://open.mcd.cn/mcp/doc](https://open.mcd.cn/mcp/doc)
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
