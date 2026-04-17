require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const { MCPClient } = require("./mcpClient");
const { TTLCache } = require("./cache");
const { getUser, getGlobalState, updateGlobalState, upsertUser, deleteUser, allUsers } = require("./storage");
const { getLocalDate, getMinutesSinceMidnight, getLocalDateTime } = require("./time");
const { createTelegraphPage } = require("./telegraph");

function readNumberEnv(key, fallback, options = {}) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`Invalid ${key}=${raw}, using default ${fallback}.`);
    return fallback;
  }
  let value = parsed;
  if (Number.isFinite(options.min) && value < options.min) {
    console.warn(`Clamping ${key}=${parsed} to min ${options.min}.`);
    value = options.min;
  }
  if (Number.isFinite(options.max) && value > options.max) {
    console.warn(`Clamping ${key}=${parsed} to max ${options.max}.`);
    value = options.max;
  }
  return value;
}

function readBooleanEnv(key, fallback = false) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseStatusCodeList(raw, fallback = []) {
  const source = raw === undefined || raw === null ? "" : String(raw);
  const values = source
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length) {
    return Array.from(new Set(values));
  }
  if (Array.isArray(fallback)) {
    return Array.from(new Set(fallback.filter((value) => Number.isFinite(value) && value > 0)));
  }
  return [];
}

function normalizeHour(value, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  if (value === 24) {
    console.warn("AUTO_CLAIM_HOUR=24 treated as 0 (midnight).");
    return 0;
  }
  if (value < 0) {
    console.warn(`AUTO_CLAIM_HOUR ${value} < 0, clamping to 0.`);
    return 0;
  }
  if (value > 24) {
    const wrapped = value % 24;
    console.warn(`AUTO_CLAIM_HOUR ${value} > 24, wrapping to ${wrapped}.`);
    return wrapped;
  }
  return value;
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in environment.");
  process.exit(1);
}

const MCP_URL = process.env.MCD_MCP_URL || "https://mcp.mcd.cn";
const MCP_PROTOCOL_VERSION = process.env.MCP_PROTOCOL_VERSION || "2025-06-18";
const MCP_REQUEST_TIMEOUT_MS = readNumberEnv("MCP_REQUEST_TIMEOUT_MS", 30000, { min: 0 });
const MCP_CLIENT_CACHE_TTL_SECONDS = readNumberEnv("MCP_CLIENT_CACHE_TTL_SECONDS", 1800, { min: 0 });
const MCP_RETRY_MAX = readNumberEnv("MCP_RETRY_MAX", 2, { min: 0 });
const MCP_RETRY_BASE_DELAY_MS = readNumberEnv("MCP_RETRY_BASE_DELAY_MS", 500, { min: 0 });
const MCP_RETRY_MAX_DELAY_MS = readNumberEnv("MCP_RETRY_MAX_DELAY_MS", 5000, { min: 0 });
const MCP_RETRY_JITTER_MS = readNumberEnv("MCP_RETRY_JITTER_MS", 200, { min: 0 });
const MCP_RETRY_STATUS_CODES = parseStatusCodeList(process.env.MCP_RETRY_STATUS_CODES, [502, 503, 504]);
const MCP_RETRY_ON_TIMEOUT = readBooleanEnv("MCP_RETRY_ON_TIMEOUT", true);
const MCP_RETRY_ON_NETWORK_ERROR = readBooleanEnv("MCP_RETRY_ON_NETWORK_ERROR", true);
const MCP_UPSTREAM_ERROR_MESSAGE = process.env.MCP_UPSTREAM_ERROR_MESSAGE || "上游故障";
const MCP_HEALTH_CHECK_INTERVAL_MS = readNumberEnv("MCP_HEALTH_CHECK_INTERVAL_MS", 60000, { min: 0 });
const MCP_HEALTH_CHECK_TIMEOUT_MS = readNumberEnv("MCP_HEALTH_CHECK_TIMEOUT_MS", 5000, { min: 0 });
const MCP_HEALTH_FAILURE_THRESHOLD = readNumberEnv("MCP_HEALTH_FAILURE_THRESHOLD", 2, { min: 1 });
const ACCOUNT_ID_MIN_LENGTH = readNumberEnv("ACCOUNT_ID_MIN_LENGTH", 1, { min: 1 });
const ACCOUNT_ID_MAX_LENGTH = readNumberEnv("ACCOUNT_ID_MAX_LENGTH", 32, { min: 1 });
const TOKEN_MIN_LENGTH = readNumberEnv("TOKEN_MIN_LENGTH", 16, { min: 1 });
const TOKEN_MAX_LENGTH = readNumberEnv("TOKEN_MAX_LENGTH", 256, { min: 1 });
const TOKEN_SET_RATE_LIMIT_MS = readNumberEnv("TOKEN_SET_RATE_LIMIT_MS", 30000, { min: 0 });
const ACCOUNT_SET_RATE_LIMIT_MS = readNumberEnv("ACCOUNT_SET_RATE_LIMIT_MS", 30000, { min: 0 });
const MCP_RETRY_OPTIONS = {
  maxRetries: MCP_RETRY_MAX,
  baseDelayMs: MCP_RETRY_BASE_DELAY_MS,
  maxDelayMs: MCP_RETRY_MAX_DELAY_MS,
  jitterMs: MCP_RETRY_JITTER_MS,
  retryOnStatus: MCP_RETRY_STATUS_CODES,
  retryOnTimeout: MCP_RETRY_ON_TIMEOUT,
  retryOnNetworkError: MCP_RETRY_ON_NETWORK_ERROR
};

const CACHE_TTL_SECONDS = readNumberEnv("CACHE_TTL_SECONDS", 300, { min: 0 });
const CACHEABLE_TOOLS = new Set(
  (process.env.CACHEABLE_TOOLS || "campaign-calendar,list-nutrition-foods")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

const AUTO_CLAIM_CHECK_MINUTES = readNumberEnv("AUTO_CLAIM_CHECK_MINUTES", 10, { min: 0 });
const AUTO_CLAIM_HOUR = normalizeHour(readNumberEnv("AUTO_CLAIM_HOUR", 9), 9);
const AUTO_CLAIM_TIMEZONE = process.env.AUTO_CLAIM_TIMEZONE || "Asia/Shanghai";
const AUTO_CLAIM_SPREAD_MINUTES = readNumberEnv("AUTO_CLAIM_SPREAD_MINUTES", 600, { min: 0 });
const AUTO_CLAIM_SPREAD_RERUN_MINUTES = readNumberEnv("AUTO_CLAIM_SPREAD_RERUN_MINUTES", 120, { min: 0 });
const AUTO_CLAIM_MAX_PER_SWEEP = readNumberEnv("AUTO_CLAIM_MAX_PER_SWEEP", 10, { min: 0 });
const AUTO_CLAIM_REQUEST_GAP_MS = readNumberEnv("AUTO_CLAIM_REQUEST_GAP_MS", 1500, { min: 0 });
const GLOBAL_BURST_WINDOW_MINUTES = readNumberEnv("GLOBAL_BURST_WINDOW_MINUTES", 30, { min: 0 });
const GLOBAL_BURST_CHECK_SECONDS = readNumberEnv("GLOBAL_BURST_CHECK_SECONDS", 30, { min: 0 });
const SWEEP_WATCHDOG_SECONDS = readNumberEnv("SWEEP_WATCHDOG_SECONDS", 60, { min: 0 });
const SWEEP_STALE_MULTIPLIER = readNumberEnv("SWEEP_STALE_MULTIPLIER", 2, { min: 0 });
const AUTO_CLAIM_DEBUG = readBooleanEnv("AUTO_CLAIM_DEBUG", false);
const ADMIN_TELEGRAM_IDS = new Set(
  (process.env.ADMIN_TELEGRAM_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

const cache = new TTLCache(CACHE_TTL_SECONDS * 1000);
const telegraphCache = new TTLCache(CACHE_TTL_SECONDS * 1000);
const mcpClientCache =
  MCP_CLIENT_CACHE_TTL_SECONDS > 0 ? new TTLCache(MCP_CLIENT_CACHE_TTL_SECONDS * 1000) : null;
const availableToolsCache =
  MCP_CLIENT_CACHE_TTL_SECONDS > 0 ? new TTLCache(MCP_CLIENT_CACHE_TTL_SECONDS * 1000) : null;
const bot = new Telegraf(BOT_TOKEN);
let autoClaimInterval = null;
let burstInterval = null;
let watchdogInterval = null;
let mcpHealthInterval = null;
const userRateLimits = new Map();

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._\-\u4e00-\u9fff]+$/;
const TOKEN_PATTERN = /^[A-Za-z0-9._=-]+$/;
const KNOWN_MCP_TOOLS = {
  calendar: {
    names: ["campaign-calendar", "campaign-calender"],
    label: "活动日历"
  },
  availableCoupons: {
    names: ["available-coupons"],
    label: "麦麦省可领优惠券"
  },
  claimCoupons: {
    names: ["auto-bind-coupons"],
    label: "麦麦省一键领券"
  },
  myCoupons: {
    names: ["query-my-coupons", "my-coupons"],
    label: "我的优惠券"
  },
  myAccount: {
    names: ["query-my-account"],
    label: "我的积分"
  },
  nutritionFoods: {
    names: ["list-nutrition-foods"],
    label: "餐品营养信息"
  },
  deliveryAddresses: {
    names: ["delivery-query-addresses"],
    label: "配送地址列表"
  },
  createDeliveryAddress: {
    names: ["delivery-create-address"],
    label: "新增配送地址"
  },
  nearbyStores: {
    names: ["query-nearby-stores"],
    label: "附近门店"
  },
  storeCoupons: {
    names: ["query-store-coupons"],
    label: "门店可用券"
  },
  meals: {
    names: ["query-meals"],
    label: "门店菜单"
  },
  mealDetail: {
    names: ["query-meal-detail"],
    label: "餐品详情"
  },
  calculatePrice: {
    names: ["calculate-price"],
    label: "价格计算"
  },
  createOrder: {
    names: ["create-order"],
    label: "创建订单"
  },
  queryOrder: {
    names: ["query-order"],
    label: "查询订单"
  },
  mallProducts: {
    names: ["mall-points-products"],
    label: "积分商城商品"
  },
  mallProductDetail: {
    names: ["mall-product-detail"],
    label: "积分商城商品详情"
  },
  mallCreateOrder: {
    names: ["mall-create-order"],
    label: "积分商城兑换下单"
  },
  nowTimeInfo: {
    names: ["now-time-info"],
    label: "当前时间信息"
  }
};

function logAutoClaim(message, extra) {
  if (extra !== undefined) {
    console.log(`[auto-claim] ${message}`, extra);
    return;
  }
  console.log(`[auto-claim] ${message}`);
}

function logAutoClaimDebug(message, extra) {
  if (!AUTO_CLAIM_DEBUG) {
    return;
  }
  if (extra !== undefined) {
    console.log(`[auto-claim][debug] ${message}`, extra);
    return;
  }
  console.log(`[auto-claim][debug] ${message}`);
}

function formatMinutesSinceMidnight(minutes) {
  if (!Number.isFinite(minutes)) {
    return "unknown";
  }
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatSkipStats(stats) {
  return Object.entries(stats)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

const TOKEN_GUIDE_MESSAGE = [
  "先获取麦当劳 MCP Token：",
  "1) 打开 https://open.mcd.cn/mcp",
  "2) 右上角登录（手机号验证）",
  "3) 登录后点击“控制台”，点击激活申请 MCP Token",
  "4) 同意协议后复制 Token"
].join("\n");

const ACCOUNT_HELP_MESSAGE = [
  "账号管理：",
  "/account add 名称 Token - 添加或更新账号",
  "/account use 名称 - 切换账号",
  "/account list - 查看账号",
  "/account del 名称 - 删除账号",
  "/autoclaim on|off [名称] - 自动领券开关",
  "/autoclaimreport success|fail on|off [名称] - 汇报开关",
  "提示：名称不要包含空格"
].join("\n");

const MAIN_MENU = Markup.inlineKeyboard([
  [Markup.button.callback("活动日历（本月）", "menu_calendar"), Markup.button.callback("可领优惠券", "menu_available")],
  [Markup.button.callback("一键领券", "menu_claim"), Markup.button.callback("我的优惠券", "menu_mycoupons")],
  [Markup.button.callback("积分查询", "menu_points"), Markup.button.callback("当前时间", "menu_now")],
  [Markup.button.callback("账号状态", "menu_status"), Markup.button.callback("我的统计", "menu_stats")],
  [Markup.button.callback("账号管理", "menu_accounts"), Markup.button.callback("完整帮助", "menu_help")],
  [Markup.button.callback("Token 获取指引", "menu_token_help"), Markup.button.callback("更多能力", "menu_more")],
  [Markup.button.callback("开启自动领券", "menu_autoclaim_on"), Markup.button.callback("关闭自动领券", "menu_autoclaim_off")],
  [Markup.button.callback("开启成功汇报", "menu_report_success_on"), Markup.button.callback("关闭成功汇报", "menu_report_success_off")],
  [Markup.button.callback("开启失败汇报", "menu_report_fail_on"), Markup.button.callback("关闭失败汇报", "menu_report_fail_off")]
]);

function buildQuickHelpMessage() {
  return [
    "欢迎使用麦麦 MCP 机器人。",
    "",
    TOKEN_GUIDE_MESSAGE,
    "",
    "常用指令：",
    "/token 你的MCP_TOKEN（首次会创建默认账号）",
    "/calendar [YYYY-MM-DD] - 活动日历查询",
    "/coupons - 麦麦省可领取券列表",
    "/claim - 麦麦省一键领券",
    "/mycoupons - 我的优惠券",
    "/points - 我的积分",
    "/tools - 当前账号可用 MCP 工具",
    "/help - 查看完整指令"
  ].join("\n");
}

function buildAdvancedFeatureMessage() {
  return [
    "新增能力：",
    "/nutrition [关键词] - 餐品营养信息",
    "/mall list - 积分商城商品列表",
    "/mall detail <spuId> - 积分商品详情",
    "/mall redeem <skuId> [count] - 积分兑换商品券",
    "/stores fav - 到店收藏门店",
    "/stores search 城市 关键词 - 按位置搜索门店",
    "/deliveryaddrs mls|group - 查询配送地址",
    "/deliveryadd mls|group 城市|联系人|电话|地址|门牌|性别(可选) - 新增配送地址",
    "/storecoupons <storeCode> <pickup|delivery> [beCode] - 查询门店可用券",
    "/meals <storeCode> <pickup|delivery> [beCode] - 查询门店菜单",
    "/mealdetail <code> <storeCode> <pickup|delivery> [beCode] - 查询餐品详情",
    "/price <json> - 价格计算",
    "/order create <json> - 创建订单",
    "/order query <orderId> - 查询订单",
    "/now - 当前时间信息",
    "/tool <toolName> [json] - 原始调用任意当前 MCP 工具"
  ].join("\n");
}

function buildHelpMessage() {
  return [buildQuickHelpMessage(), "", ACCOUNT_HELP_MESSAGE, "", buildAdvancedFeatureMessage()].join("\n");
}

function chunkText(text, maxLength = 3500) {
  const lines = text.split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLength && current) {
      chunks.push(current);
      current = line;
      continue;
    }
    if (next.length > maxLength) {
      let remaining = line;
      while (remaining.length > maxLength) {
        chunks.push(remaining.slice(0, maxLength));
        remaining = remaining.slice(maxLength);
      }
      current = remaining;
      continue;
    }
    current = next;
  }

  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function stripHtmlTags(text) {
  return text.replace(/<[^>]+>/g, "");
}

const CONTROL_CHARS_REGEX = /[\x00-\x1F\x7F]/g;
const CONTROL_CHARS_KEEP_NEWLINE_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function sanitizeInlineText(value, options = {}) {
  if (value === undefined || value === null) {
    return "";
  }
  const maxLength = Number.isFinite(options.maxLength) ? options.maxLength : 300;
  const keepNewlines = Boolean(options.keepNewlines);
  let text = String(value);
  text = keepNewlines
    ? text.replace(CONTROL_CHARS_KEEP_NEWLINE_REGEX, "")
    : text.replace(CONTROL_CHARS_REGEX, " ");
  text = stripHtmlTags(text);
  if (keepNewlines) {
    text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  } else {
    text = text.replace(/\s+/g, " ");
  }
  text = text.trim();
  if (maxLength > 0 && text.length > maxLength) {
    text = text.slice(0, maxLength);
  }
  return text;
}

function maskToken(token, options = {}) {
  const safe = sanitizeInlineText(token, { maxLength: 200 });
  if (!safe) {
    return "";
  }
  const visible = Number.isFinite(options.visible) ? Math.max(0, options.visible) : 4;
  if (safe.length <= visible) {
    return "*".repeat(Math.max(1, safe.length));
  }
  return `${"*".repeat(safe.length - visible)}${safe.slice(-visible)}`;
}

function validateAccountIdInput(accountId) {
  const value = String(accountId || "").trim();
  if (!value) {
    return { ok: false, message: "账号名不能为空。" };
  }
  if (value.length < ACCOUNT_ID_MIN_LENGTH || value.length > ACCOUNT_ID_MAX_LENGTH) {
    return {
      ok: false,
      message: `账号名长度需在 ${ACCOUNT_ID_MIN_LENGTH}-${ACCOUNT_ID_MAX_LENGTH} 之间。`
    };
  }
  if (!ACCOUNT_ID_PATTERN.test(value)) {
    return {
      ok: false,
      message: "账号名仅支持中文、字母、数字、点、下划线、连字符。"
    };
  }
  return { ok: true, value };
}

function validateTokenInput(token) {
  const value = String(token || "").trim();
  if (!value) {
    return { ok: false, message: "Token 不能为空。" };
  }
  if (value.length < TOKEN_MIN_LENGTH || value.length > TOKEN_MAX_LENGTH) {
    return {
      ok: false,
      message: `Token 长度需在 ${TOKEN_MIN_LENGTH}-${TOKEN_MAX_LENGTH} 之间。`
    };
  }
  if (!TOKEN_PATTERN.test(value)) {
    return {
      ok: false,
      message: "Token 仅支持字母、数字、点、下划线、连字符和等号。"
    };
  }
  return { ok: true, value };
}

function checkRateLimit(userId, action, intervalMs) {
  if (!intervalMs || intervalMs <= 0) {
    return { ok: true, waitMs: 0 };
  }
  const key = `${userId}:${action}`;
  const now = Date.now();
  const last = userRateLimits.get(key) || 0;
  const elapsed = now - last;
  if (elapsed >= intervalMs) {
    userRateLimits.set(key, now);
    return { ok: true, waitMs: 0 };
  }
  return { ok: false, waitMs: intervalMs - elapsed };
}

async function sendLongMessage(ctx, text, options = {}) {
  const parseMode = options.parseMode || "HTML";
  const chunks = chunkText(text);
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, {
        disable_web_page_preview: true,
        parse_mode: parseMode
      });
    } catch (error) {
      await ctx.reply(stripHtmlTags(chunk), {
        disable_web_page_preview: true
      });
    }
  }
}

async function sendLongMessageToUser(userId, text, options = {}) {
  const parseMode = options.parseMode || "HTML";
  const chunks = chunkText(text);
  for (const chunk of chunks) {
    try {
      await bot.telegram.sendMessage(userId, chunk, {
        disable_web_page_preview: true,
        parse_mode: parseMode
      });
    } catch (error) {
      await bot.telegram.sendMessage(userId, stripHtmlTags(chunk), {
        disable_web_page_preview: true
      });
    }
  }
}

async function sendPlainMessageToUser(userId, text) {
  const chunks = chunkText(text);
  for (const chunk of chunks) {
    await bot.telegram.sendMessage(userId, chunk, { disable_web_page_preview: true });
  }
}

function getToolRawText(result) {
  let rawText = "";

  if (typeof result === "string") {
    rawText = result;
  } else if (result && Array.isArray(result.content)) {
    const parts = [];
    for (const item of result.content) {
      if (!item) {
        continue;
      }
      if (item.type === "text" && item.text) {
        parts.push(item.text);
        continue;
      }
      if (item.type === "image") {
        if (item.url) {
          parts.push(item.url);
        } else if (item.data) {
          parts.push("图片内容已省略");
        }
      }
    }
    rawText = parts.join("\n\n").trim();
  } else {
    try {
      rawText = JSON.stringify(result, null, 2);
    } catch (error) {
      rawText = String(result);
    }
  }

  if (!rawText) {
    return "";
  }

  return rawText;
}

function extractBalancedJsonFragment(text, startIndex) {
  if (!text || startIndex < 0 || startIndex >= text.length) {
    return "";
  }
  const opening = text[startIndex];
  if (opening !== "{" && opening !== "[") {
    return "";
  }

  const stack = [opening];
  let inString = false;
  let escaping = false;

  for (let index = startIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack[stack.length - 1] !== expected) {
        return "";
      }
      stack.pop();
      if (!stack.length) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return "";
}

function findJsonFragment(text) {
  const source = String(text || "");
  if (!source.trim()) {
    return "";
  }

  const marker = source.lastIndexOf("## Original Response");
  if (marker >= 0) {
    for (let index = marker; index < source.length; index += 1) {
      if (source[index] !== "{" && source[index] !== "[") {
        continue;
      }
      const fragment = extractBalancedJsonFragment(source, index);
      if (!fragment) {
        continue;
      }
      try {
        JSON.parse(fragment);
        return fragment;
      } catch (error) {
        continue;
      }
    }
  }

  const candidateStarts = [];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "{" || source[index] === "[") {
      candidateStarts.push(index);
    }
  }

  const tried = new Set();
  let lastValid = "";
  for (const startIndex of candidateStarts) {
    if (tried.has(startIndex)) {
      continue;
    }
    tried.add(startIndex);
    const fragment = extractBalancedJsonFragment(source, startIndex);
    if (!fragment) {
      continue;
    }
    try {
      JSON.parse(fragment);
      if (!lastValid || fragment.length > lastValid.length) {
        lastValid = fragment;
      }
    } catch (error) {
      continue;
    }
  }
  return lastValid;
}

function extractOriginalResponseText(rawText) {
  const source = String(rawText || "");
  const marker = source.lastIndexOf("## Original Response");
  if (marker < 0) {
    return source;
  }
  return source.slice(marker + "## Original Response".length).trim();
}

function extractOriginalResponseDataString(rawText) {
  const source = extractOriginalResponseText(rawText);
  const match = source.match(/"data":"([\s\S]*)"\s*}$/);
  if (!match) {
    return "";
  }
  return match[1]
    .replace(/\\"/g, "\"")
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
}

function getStructuredContentPayload(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const structured = result.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    return null;
  }
  return structured;
}

function parseToolJsonPayload(result) {
  const structured = getStructuredContentPayload(result);
  if (structured) {
    return structured;
  }

  if (result && typeof result === "object" && !Array.isArray(result)) {
    if (result.success !== undefined || result.code !== undefined || result.data !== undefined) {
      return result;
    }
  }

  const rawText = getToolRawText(result);
  if (!rawText) {
    return null;
  }

  const candidates = [normalizeToolText(rawText), rawText.trim()].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch (error) {
      continue;
    }
  }

  const fragment = findJsonFragment(rawText);
  if (fragment) {
    try {
      return JSON.parse(fragment);
    } catch (error) {
      return null;
    }
  }

  return null;
}

function getStructuredToolData(result) {
  const payload = parseToolJsonPayload(result);
  if (!payload || typeof payload !== "object") {
    return null;
  }
  return payload.data !== undefined ? payload.data : payload;
}

function formatJsonCodeBlock(value) {
  return formatTelegramHtml(`\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``);
}

function formatFenAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return String(value || "0");
  }
  return `¥${(amount / 100).toFixed(2)}`;
}

function formatCurrencyValue(value) {
  if (value === undefined || value === null || value === "") {
    return "0";
  }
  return String(value);
}

function normalizeToolText(rawText, options = {}) {
  if (!rawText) {
    return "";
  }

  let text = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/^\s*如果当前的 Client 支持 Markdown 渲染.*$/gm, "");
  text = text.replace(/^\s*请你把下面响应的内容以 Markdown 格式返回给用户[:：]?\s*$/gm, "");
  text = text.replace(/```(?:\w+)?\n([\s\S]*?)```/g, "$1");
  text = text.replace(/```/g, "");
  text = text.replace(/\\\s*$/gm, "");
  if (text.includes("\\n")) {
    text = text.replace(/\\n/g, "\n");
  }
  text = text.replace(/\n{3,}/g, "\n\n");

  if (options.removeTimeInfo) {
    text = text
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return true;
        }
        return !/^#{1,6}\s*当前时间[:：]/.test(trimmed) && !/^当前时间[:：]/.test(trimmed);
      })
      .join("\n");
  }

  if (options.removeClaimStatus) {
    text = text
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return true;
        }
        return !/(领取状态|是否已领取|已领取|未领取)/.test(trimmed);
      })
      .join("\n");
  }

  return text.trim();
}

function normalizeCalendarText(rawText) {
  return normalizeToolText(rawText, { removeTimeInfo: true });
}

function normalizeCouponListText(rawText) {
  return normalizeToolText(rawText, { removeClaimStatus: true });
}

function normalizeMyCouponsText(rawText) {
  const text = normalizeToolText(rawText);
  if (!text) {
    return "";
  }
  const lines = text.split("\n");
  const cleaned = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      cleaned.push(line);
      continue;
    }
    if (/^您的优惠券列表/.test(trimmed)) {
      continue;
    }
    if (/^共\s*\d+\s*张可用优惠券/.test(trimmed)) {
      continue;
    }
    if (
      /张可用优惠券/.test(trimmed) &&
      (/第\s*\d+\s*\/\s*\d+\s*页/.test(trimmed) || /每页\s*\d+\s*条/.test(trimmed))
    ) {
      continue;
    }
    if (/^图片[:：]/i.test(trimmed) || /图片内容已省略/.test(trimmed)) {
      continue;
    }
    if (/^https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?\S*)?$/i.test(trimmed)) {
      continue;
    }
    cleaned.push(line);
  }
  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function simplifyClaimResultText(text) {
  if (!text) {
    return "";
  }
  const lines = text.split("\n");
  const cleaned = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      cleaned.push(line);
      continue;
    }
    if (/couponId[:：]/i.test(trimmed) || /couponCode[:：]/i.test(trimmed)) {
      continue;
    }
    if (/^图片[:：]/i.test(trimmed) || /图片内容已省略/.test(trimmed)) {
      continue;
    }
    if (/(领取状态|是否已领取|已领取|未领取)/.test(trimmed)) {
      continue;
    }
    const bulletMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bulletMatch) {
      const indent = bulletMatch[1].length;
      const content = bulletMatch[2].trim();
      if (indent > 0) {
        continue;
      }
      if (/(couponId|couponCode|图片|领取状态|是否已领取|已领取|未领取)/i.test(content)) {
        continue;
      }
    }
    cleaned.push(line);
  }
  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function getClaimedCouponCount(rawText) {
  if (!rawText) {
    return 0;
  }
  const counts = parseClaimCounts(rawText);
  if (counts && Number.isFinite(counts.success)) {
    return counts.success;
  }
  const ids = parseCouponIds(rawText);
  return ids.length;
}

function incrementUserStats(userId, delta) {
  const user = getUser(userId) || {};
  const current = user.stats || {};
  const autoClaimRuns = Number(current.autoClaimRuns) || 0;
  const manualClaimRuns = Number(current.manualClaimRuns) || 0;
  const couponsClaimed = Number(current.couponsClaimed) || 0;
  const updated = {
    autoClaimRuns: autoClaimRuns + (delta.autoClaimRuns || 0),
    manualClaimRuns: manualClaimRuns + (delta.manualClaimRuns || 0),
    couponsClaimed: couponsClaimed + (delta.couponsClaimed || 0)
  };
  upsertUser(userId, { stats: updated });
  return updated;
}

function parseClaimCounts(rawText) {
  if (!rawText) {
    return null;
  }
  const normalized = rawText.replace(/\*/g, "");
  const getCount = (label) => {
    const match = normalized.match(new RegExp(`${label}\\s*[:：]\\s*(\\d+)`));
    return match ? Number(match[1]) : null;
  };

  const total = getCount("总计");
  const success = getCount("成功");
  const failed = getCount("失败");

  if (total === null && success === null && failed === null) {
    return null;
  }

  return { total, success, failed };
}

function hasClaimedCoupons(rawText) {
  const counts = parseClaimCounts(rawText);
  if (counts && Number.isFinite(counts.success)) {
    return counts.success > 0;
  }
  if (/couponId[:：]/i.test(rawText) || /couponCode[:：]/i.test(rawText)) {
    return true;
  }
  if (/成功领取/.test(rawText)) {
    return true;
  }
  return false;
}

function isAuthFailureMessage(message) {
  if (!message) {
    return false;
  }
  const text = String(message);
  return (
    /\b401\b/.test(text) ||
    /鉴权码/.test(text) ||
    /token.*(无效|失效)/i.test(text) ||
    /unauthorized|authorization/i.test(text)
  );
}

function getErrorMessage(error) {
  if (!error) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error.message) {
    return String(error.message);
  }
  return String(error);
}

function isUpstreamError(error) {
  if (!error) {
    return false;
  }
  if (error.isUpstream || error.isNetworkError || error.isTimeout) {
    return true;
  }
  if (error.code === "MCP_TIMEOUT" || error.code === "MCP_NETWORK_ERROR") {
    return true;
  }
  if (Number.isFinite(error.status)) {
    return error.status >= 500;
  }
  const match = String(error.message || "").match(/MCP request failed \((\d+)\)/);
  if (match) {
    const status = Number(match[1]);
    return Number.isFinite(status) && status >= 500;
  }
  return false;
}

function formatMcpErrorMessage(error) {
  const rawMessage = getErrorMessage(error);
  const authFailure = isAuthFailureMessage(rawMessage);
  const upstreamFailure = isUpstreamError(error);
  if (upstreamFailure || (!authFailure && isMcpDown())) {
    return MCP_UPSTREAM_ERROR_MESSAGE;
  }
  const safe = sanitizeInlineText(rawMessage, { maxLength: 400 });
  return safe || "未知错误";
}

function parseCouponIds(rawText) {
  if (!rawText) {
    return [];
  }
  const ids = new Set();
  const regex = /couponId[:：]\s*([0-9a-zA-Z]+)/g;
  let match;
  while ((match = regex.exec(rawText))) {
    ids.add(match[1].toUpperCase());
  }
  return Array.from(ids);
}

function recordClaimedCoupons(rawText, trigger) {
  const couponIds = parseCouponIds(rawText);
  if (!couponIds.length) {
    return { newCouponIds: [], couponIds: [] };
  }

  const state = getGlobalState();
  const knownCoupons = state.knownCoupons || {};
  const updated = { ...knownCoupons };
  const nowIso = new Date().toISOString();
  const newCouponIds = [];

  for (const id of couponIds) {
    if (!updated[id]) {
      updated[id] = nowIso;
      newCouponIds.push(id);
    }
  }

  if (newCouponIds.length) {
    const nowMs = Date.now();
    const windowMinutes = Number.isFinite(GLOBAL_BURST_WINDOW_MINUTES) ? GLOBAL_BURST_WINDOW_MINUTES : 0;
    const burst =
      windowMinutes > 0
        ? {
            id: `burst_${nowMs}`,
            startAt: nowMs,
            endAt: nowMs + windowMinutes * 60 * 1000,
            windowMinutes,
            couponIds: newCouponIds,
            triggeredAt: nowIso,
            triggeredBy: trigger || null
          }
        : null;

    updateGlobalState({
      knownCoupons: updated,
      burst
    });
    if (burst) {
      logAutoClaim(`Burst window started: ${newCouponIds.length} new coupons, ${windowMinutes} minutes.`);
      ensureBurstScheduler(true);
    }
  }

  return { newCouponIds, couponIds };
}

function stripImagesFromText(text) {
  if (!text) {
    return "";
  }
  const lines = text.split("\n");
  const cleaned = [];
  for (const line of lines) {
    if (/<img\\b/i.test(line)) {
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      cleaned.push(line);
      continue;
    }
    if (/^(图片|优惠券图片|活动图片介绍|图片介绍)[:：]?$/i.test(trimmed)) {
      continue;
    }
    if (/^(图片|优惠券图片|活动图片介绍|图片介绍)[:：]\\s*$/i.test(trimmed)) {
      continue;
    }
    cleaned.push(line);
  }
  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n");
}

function formatToolResult(result, options = {}) {
  const rawText = normalizeToolText(getToolRawText(result), options.normalizeOptions);
  if (!rawText) {
    return "";
  }
  const removeImages = options.removeImages !== false;
  const text = removeImages ? stripImagesFromText(rawText) : rawText;
  return formatTelegramHtml(text);
}

function formatTelegramHtml(text) {
  const { text: withoutImages, images } = replaceImages(text);
  const codeBlocks = [];

  let processed = withoutImages.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
    const escapedCode = escapeHtml(code.trim());
    const htmlBlock = `<pre><code>${escapedCode}</code></pre>`;
    const key = `__CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push(htmlBlock);
    return key;
  });

  processed = escapeHtml(processed);

  const lines = processed.split("\n").map((line) => {
    const trimmed = line.trimEnd();
    if (/^#{1,6}\s+/.test(trimmed)) {
      const title = trimmed.replace(/^#{1,6}\s+/, "");
      return `<b>${title}</b>`;
    }
    if (/^-{3,}$/.test(trimmed)) {
      return "────────";
    }
    if (/^\s*[-*+]\s+/.test(trimmed)) {
      return trimmed.replace(/^(\s*)[-*+]\s+/, "$1• ");
    }
    return trimmed;
  });

  processed = lines.join("\n");
  processed = processed.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  processed = processed.replace(/`([^`]+)`/g, "<code>$1</code>");

  codeBlocks.forEach((block, index) => {
    processed = processed.replace(new RegExp(`__CODE_BLOCK_${index}__`, "g"), block);
  });

  images.forEach((url, index) => {
    const safeUrl = escapeHtml(url);
    const link = `<a href=\"${safeUrl}\">查看图片</a>`;
    processed = processed.replace(new RegExp(`__IMAGE_${index}__`, "g"), link);
  });

  return processed;
}

function replaceImages(text) {
  const images = [];
  const replaced = text.replace(/<img[^>]*src=[\"']([^\"']+)[\"'][^>]*>/gi, (match, url) => {
    const key = `__IMAGE_${images.length}__`;
    images.push(url);
    return `图片：${key}`;
  });
  return { text: replaced, images };
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function safeHtmlText(value, options = {}) {
  return escapeHtml(sanitizeInlineText(value, options));
}

function parseInlineNodes(text) {
  if (!text) {
    return [""];
  }
  const segments = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return segments.map((segment) => {
    if (segment.startsWith("**") && segment.endsWith("**")) {
      const inner = segment.slice(2, -2);
      return { tag: "strong", children: [inner] };
    }
    if (segment.startsWith("`") && segment.endsWith("`")) {
      const inner = segment.slice(1, -1);
      return { tag: "code", children: [inner] };
    }
    return segment;
  });
}

function buildTelegraphNodes(text) {
  const nodes = [];
  const lines = text.split("\n");
  let listItems = null;

  const flushList = () => {
    if (listItems && listItems.length) {
      nodes.push({ tag: "ul", children: listItems });
    }
    listItems = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushList();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      const tag = `h${Math.min(level, 4)}`;
      nodes.push({ tag, children: parseInlineNodes(stripHtmlTags(headingMatch[2])) });
      continue;
    }

    if (/^-{3,}$/.test(trimmed)) {
      flushList();
      nodes.push({ tag: "hr" });
      continue;
    }

    const imgMatches = [...trimmed.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi)];
    if (imgMatches.length) {
      flushList();
      const textWithoutImg = stripHtmlTags(trimmed.replace(/<img[^>]*>/gi, "")).trim();
      if (textWithoutImg && !/^(图片|优惠券图片|活动图片介绍|图片介绍)[:：]?$/i.test(textWithoutImg)) {
        nodes.push({ tag: "p", children: parseInlineNodes(textWithoutImg) });
      }
      for (const match of imgMatches) {
        nodes.push({ tag: "img", attrs: { src: match[1] } });
      }
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (bulletMatch) {
      if (!listItems) {
        listItems = [];
      }
      listItems.push({ tag: "li", children: parseInlineNodes(stripHtmlTags(bulletMatch[1])) });
      continue;
    }

    flushList();
    nodes.push({ tag: "p", children: parseInlineNodes(stripHtmlTags(trimmed)) });
  }

  flushList();
  return nodes;
}

function parseCommandArgs(ctx) {
  const text = ctx.message && ctx.message.text ? ctx.message.text : "";
  return text.split(/\s+/).slice(1).filter(Boolean);
}

function getCommandPayload(ctx) {
  const text = ctx.message && ctx.message.text ? ctx.message.text : "";
  const match = text.match(/^\/\S+(?:\s+([\s\S]*))?$/);
  return match && match[1] ? match[1].trim() : "";
}

function splitFirstToken(text) {
  const payload = String(text || "").trim();
  if (!payload) {
    return { head: "", tail: "" };
  }
  const match = payload.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return {
    head: match ? match[1] : payload,
    tail: match && match[2] ? match[2].trim() : ""
  };
}

function parseJsonPayload(text, usageText) {
  const payload = String(text || "").trim();
  if (!payload) {
    return { ok: false, message: usageText || "缺少 JSON 参数。" };
  }
  try {
    const value = JSON.parse(payload);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, message: "JSON 参数必须是对象。" };
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, message: `JSON 解析失败：${sanitizeInlineText(error.message, { maxLength: 120 })}` };
  }
}

function parsePipeFields(text) {
  return String(text || "")
    .split("|")
    .map((value) => value.trim())
    .filter((value, index, list) => value || index < list.length - 1);
}

function normalizeDeliveryTypeInput(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["2", "mls", "delivery", "deliver", "麦乐送", "外送"].includes(normalized)) {
    return { ok: true, value: 2, label: "麦乐送" };
  }
  if (["6", "group", "corp", "enterprise", "团餐"].includes(normalized)) {
    return { ok: true, value: 6, label: "团餐" };
  }
  return { ok: false, message: "类型仅支持 mls|group（或 2|6）。" };
}

function normalizeOrderTypeInput(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["1", "pickup", "takeout", "instore", "store", "到店", "堂食"].includes(normalized)) {
    return { ok: true, value: 1, label: "到店" };
  }
  if (["2", "delivery", "deliver", "外送", "麦乐送", "团餐"].includes(normalized)) {
    return { ok: true, value: 2, label: "外送" };
  }
  return { ok: false, message: "取餐方式仅支持 pickup|delivery（或 1|2）。" };
}

function buildStoreToolArgs(storeCode, orderTypeInput, beCode) {
  if (!storeCode) {
    return { ok: false, message: "缺少 storeCode。" };
  }
  const orderType = normalizeOrderTypeInput(orderTypeInput);
  if (!orderType.ok) {
    return orderType;
  }
  if (orderType.value === 2 && !beCode) {
    return { ok: false, message: "外送场景必须提供 beCode。" };
  }
  return {
    ok: true,
    value: {
      storeCode,
      orderType: orderType.value,
      ...(orderType.value === 2 ? { beCode } : {})
    },
    orderType
  };
}

function parseCompactTableText(text) {
  const source = String(text || "").trim();
  const match = source.match(/^\[\d+\]\{([^}]+)\}:\s*([\s\S]*)$/);
  if (!match) {
    return [];
  }
  const fields = match[1].split(",").map((value) => value.trim()).filter(Boolean);
  const body = match[2]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return body.map((line) => {
    const values = line.split(",").map((value) => value.trim());
    return fields.reduce((acc, field, index) => {
      acc[field] = values[index] !== undefined ? values[index] : "";
      return acc;
    }, {});
  });
}

function formatToolListMessage(toolNames) {
  const names = Array.from(toolNames || []).filter(Boolean).sort();
  if (!names.length) {
    return "当前账号未返回可用工具。";
  }
  return ["当前账号可用 MCP 工具：", `共 ${names.length} 个`, ...names.map((name) => `- ${name}`)].join("\n");
}

function formatPointsText(data) {
  if (!data || typeof data !== "object") {
    return "未返回积分数据。";
  }
  return [
    "我的积分：",
    `可用积分：${formatCurrencyValue(data.availablePoint)}`,
    `累计积分：${formatCurrencyValue(data.accumulativePoint)}`,
    `已使用积分：${formatCurrencyValue(data.usedPoint)}`,
    `冻结积分：${formatCurrencyValue(data.frozenPoint)}`,
    `本月将过期：${formatCurrencyValue(data.currentMouthExpirePoint)}`,
    `下月将过期：${formatCurrencyValue(data.nextMouthExpirePoint)}`,
    `已过期积分：${formatCurrencyValue(data.expiredPoint)}`
  ].join("\n");
}

function formatMallProductsText(data) {
  const items = Array.isArray(data) ? data : [];
  if (!items.length) {
    return "当前没有可兑换商品。";
  }
  const lines = [`积分商城商品：共 ${items.length} 个`];
  for (const item of items) {
    lines.push(
      [
        `- ${item.spuName || "未命名商品"}`,
        `  spuId: ${item.spuId || "-"}`,
        `  skuId: ${item.skuId || "-"}`,
        `  所需积分: ${formatCurrencyValue(item.point)}`,
        `  有效期: ${item.upTime || "-"} ~ ${item.downTime || "-"}`
      ].join("\n")
    );
  }
  return lines.join("\n");
}

function formatMallProductDetailText(data) {
  if (!data || typeof data !== "object") {
    return "未返回商品详情。";
  }
  const images = Array.isArray(data.images) ? data.images : [];
  const lines = [
    `商品：${data.spuName || "未命名商品"}`,
    `spuId: ${data.spuId || "-"}`,
    `skuId: ${data.skuId || "-"}`,
    `所需积分: ${formatCurrencyValue(data.points)}`,
    `参考价格: ${data.extTradePrice || "-"}`,
    `有效期: ${data.upDate || "-"} ~ ${data.downDate || "-"}`
  ];
  if (data.note) {
    lines.push(`说明: ${data.note}`);
  }
  if (data.detail) {
    lines.push(`详情: ${data.detail}`);
  }
  if (images.length) {
    lines.push(`图片: ${images.join("\n")}`);
  }
  return lines.join("\n");
}

function formatMallRedeemText(data) {
  if (!data || typeof data !== "object") {
    return "未返回兑换结果。";
  }
  const coupons = Array.isArray(data.coupons) ? data.coupons : [];
  const lines = [
    "积分兑换结果：",
    `订单号: ${data.orderId || "-"}`,
    `订单状态: ${data.orderStatus || "-"}`,
    `兑换状态: ${data.status || "-"}`
  ];
  if (coupons.length) {
    lines.push("发放券码：");
    for (const coupon of coupons) {
      lines.push(
        [
          `- couponId: ${coupon.couponId || "-"}`,
          `  orderItemId: ${coupon.orderItemId || "-"}`,
          `  couponCodes: ${Array.isArray(coupon.couponCodes) ? coupon.couponCodes.join(", ") : "-"}`
        ].join("\n")
      );
    }
  }
  return lines.join("\n");
}

function formatDeliveryAddressesText(data, label) {
  const addresses = data && Array.isArray(data.addresses) ? data.addresses : [];
  if (!addresses.length) {
    return `${label}地址为空。`;
  }
  const lines = [`${label}地址：共 ${addresses.length} 个`];
  for (const item of addresses) {
    lines.push(
      [
        `- ${item.contactName || "未命名联系人"} ${item.phone || ""}`.trim(),
        `  addressId: ${item.addressId || "-"}`,
        `  地址: ${item.fullAddress || "-"}`,
        `  门店: ${item.storeName || "-"} (${item.storeCode || "-"})`,
        `  beCode: ${item.beCode || "-"}`
      ].join("\n")
    );
  }
  return lines.join("\n");
}

function formatNearbyStoresText(data) {
  const stores = Array.isArray(data) ? data : [];
  if (!stores.length) {
    return "未找到门店。";
  }
  const lines = [`附近门店：共 ${stores.length} 家`];
  for (const item of stores) {
    lines.push(
      [
        `- ${item.storeName || "未命名门店"} (${item.storeCode || "-"})`,
        `  地址: ${item.address || "-"}`,
        `  beCode: ${item.beCode || "-"}`,
        `  距离: ${item.distance || "-"}`
      ].join("\n")
    );
  }
  return lines.join("\n");
}

function formatStoreCouponsText(data) {
  const coupons = Array.isArray(data) ? data : [];
  if (!coupons.length) {
    return "当前门店没有可用券。";
  }
  const lines = [`当前门店可用券：共 ${coupons.length} 张`];
  for (const item of coupons) {
    const products = Array.isArray(item.products) ? item.products : [];
    const productText = products.length
      ? products.map((product) => `${product.productName || "-"}(${product.productCode || "-"})`).join("、")
      : "-";
    lines.push(
      [
        `- ${item.title || "未命名优惠券"}`,
        `  couponId: ${item.couponId || "-"}`,
        `  couponCode: ${item.couponCode || "-"}`,
        `  有效期: ${item.tradeDateTime || "-"}`,
        `  适用品: ${productText}`
      ].join("\n")
    );
  }
  return lines.join("\n");
}

function formatMealsText(data) {
  const categories = data && Array.isArray(data.categories) ? data.categories : [];
  const meals = data && data.meals && typeof data.meals === "object" ? data.meals : {};
  if (!categories.length) {
    return "当前门店没有返回可售餐品。";
  }
  const lines = ["当前门店菜单："];
  for (const category of categories) {
    lines.push(`\n${category.name || "未分类"}：`);
    const list = Array.isArray(category.meals) ? category.meals : [];
    for (const item of list) {
      const detail = meals[item.code] || {};
      const tags = Array.isArray(item.tags) && item.tags.length ? `｜标签:${item.tags.join("、")}` : "";
      lines.push(`- ${detail.name || item.code || "未知餐品"}｜code:${item.code || "-"}｜价格:${detail.currentPrice || "-"}${tags}`);
    }
  }
  return lines.join("\n");
}

function formatMealDetailText(data) {
  if (!data || typeof data !== "object") {
    return "未返回餐品详情。";
  }
  const lines = [
    `餐品编码: ${data.code || "-"}`,
    `价格: ${data.price || "-"}`,
    "套餐组成："
  ];
  const rounds = Array.isArray(data.rounds) ? data.rounds : [];
  if (!rounds.length) {
    lines.push("- 无");
    return lines.join("\n");
  }
  for (const round of rounds) {
    lines.push(
      `- ${round.name || "未命名分组"}｜数量:${round.quantity || 0}｜最少:${round.minQuantity || 0}｜最多:${round.maxQuantity || 0}`
    );
    const choices = Array.isArray(round.choices) ? round.choices : [];
    for (const choice of choices) {
      lines.push(`  • ${choice.name || "未命名选项"}｜code:${choice.code || "-"}｜数量:${choice.quantity || 0}`);
    }
  }
  return lines.join("\n");
}

function formatPriceResultText(data) {
  if (!data || typeof data !== "object") {
    return "未返回价格计算结果。";
  }
  const lines = [
    "价格计算结果：",
    `商品原价: ${formatFenAmount(data.productOriginalPrice)}`,
    `商品现价: ${formatFenAmount(data.productPrice)}`,
    `配送原价: ${formatFenAmount(data.deliveryOriginalPrice)}`,
    `配送现价: ${formatFenAmount(data.deliveryPrice)}`,
    `优惠金额: ${formatFenAmount(data.discount)}`,
    `应付总价: ${formatFenAmount(data.price)}`
  ];
  const products = Array.isArray(data.productList) ? data.productList : [];
  if (products.length) {
    lines.push("商品列表：");
    for (const item of products) {
      lines.push(
        `- ${item.productName || item.productCode || "未命名商品"}｜code:${item.productCode || "-"}｜数量:${item.quantity || 0}｜小计:${formatFenAmount(item.subtotal)}`
      );
    }
  }
  const takeWays = Array.isArray(data.takeWayList) ? data.takeWayList : [];
  if (takeWays.length) {
    lines.push("到店取餐方式：");
    for (const item of takeWays) {
      lines.push(`- ${item.name || item.takeWayName || item.code || "-"}｜code:${item.code || item.takeWayCode || "-"}`);
    }
  }
  const mealAssistance = Array.isArray(data.mealAssistanceList) ? data.mealAssistanceList : [];
  if (mealAssistance.length) {
    lines.push("助餐信息：");
    for (const item of mealAssistance) {
      lines.push(`- ${item.name || item.code || "-"}`);
    }
  }
  return lines.join("\n");
}

function formatOrderText(data, options = {}) {
  const order = options.includeNestedDetail && data && data.orderDetail ? data.orderDetail : data;
  if (!order || typeof order !== "object") {
    return "未返回订单数据。";
  }
  const lines = [
    options.title || "订单信息：",
    `订单号: ${data.orderId || order.orderId || "-"}`,
    `订单状态: ${order.orderStatus || "-"}`,
    `门店: ${order.storeName || "-"}`,
    `门店地址: ${order.storeAddress || "-"}`,
    `商品金额: ${order.productPrice || "-"}`,
    `配送费: ${order.realDeliveryPrice || order.deliveryPrice || "-"}`,
    `优惠金额: ${order.totalDiscountAmount || "-"}`,
    `应付总额: ${order.realTotalAmount || order.totalAmount || "-"}`
  ];
  if (data.payH5Url) {
    lines.push(`支付链接: ${data.payH5Url}`);
  }
  if (order.createTime) {
    lines.push(`创建时间: ${order.createTime}`);
  }
  if (order.takeWay) {
    lines.push(`取餐方式: ${order.takeWay}`);
  }
  if (order.pickupCode) {
    lines.push(`取餐码: ${order.pickupCode}`);
  }
  if (order.lockerCode) {
    lines.push(`柜机码: ${order.lockerCode}`);
  }
  const products = Array.isArray(order.orderProductList) ? order.orderProductList : [];
  if (products.length) {
    lines.push("商品列表：");
    for (const item of products) {
      lines.push(`- ${item.productName || "-"}｜数量:${item.quantity || 0}｜价格:${item.price || "-"}`);
      const combos = Array.isArray(item.comboItemList) ? item.comboItemList : [];
      for (const combo of combos) {
        lines.push(`  • ${combo.itemName || "-"} x ${combo.itemQuantity || 0}`);
      }
    }
  }
  const deliveryInfo = order.deliveryInfo;
  if (deliveryInfo && typeof deliveryInfo === "object") {
    lines.push("配送信息：");
    lines.push(`- 类型: ${deliveryInfo.deliveryType || "-"}`);
    lines.push(`- 地址: ${deliveryInfo.deliveryAddress || "-"} ${deliveryInfo.addressDetail || ""}`.trim());
    lines.push(`- 联系人: ${deliveryInfo.customerNickname || "-"} ${deliveryInfo.mobilePhone || ""}`.trim());
    lines.push(`- 预计送达: ${deliveryInfo.expectDeliveryTime || "-"}`);
  }
  return lines.join("\n");
}

function formatNowTimeText(data) {
  if (!data || typeof data !== "object") {
    return "未返回时间信息。";
  }
  return [
    "当前时间信息：",
    `格式化时间: ${data.formatted || "-"}`,
    `日期: ${data.date || "-"}`,
    `星期: ${data.dayOfWeek || "-"}`,
    `时区: ${data.timezone || "-"} (${data.offset || "-"})`,
    `UTC: ${data.utc || "-"}`,
    `时间戳: ${data.timestamp || "-"}`
  ].join("\n");
}

function formatNutritionText(result, keyword) {
  const payload = parseToolJsonPayload(result);
  const rawText = getToolRawText(result);
  const compact =
    payload && typeof payload.data === "string"
      ? payload.data
      : extractOriginalResponseDataString(rawText) || normalizeToolText(rawText);
  const rows = parseCompactTableText(compact);
  if (!rows.length) {
    return normalizeToolText(rawText) || "未返回营养数据。";
  }
  const normalizedKeyword = String(keyword || "").trim().toLowerCase();
  const filtered = normalizedKeyword
    ? rows.filter((row) => String(row.productName || "").toLowerCase().includes(normalizedKeyword))
    : rows;
  if (!filtered.length) {
    return `未找到包含“${sanitizeInlineText(keyword, { maxLength: 40 })}”的餐品。`;
  }
  const lines = [`餐品营养信息：共 ${filtered.length} 项`];
  for (const item of filtered) {
    lines.push(
      `- ${item.productName || "未命名餐品"}｜${item.energyKcal || "-"} kcal｜蛋白质 ${item.protein || "-"}g｜脂肪 ${item.fat || "-"}g｜碳水 ${item.carbohydrate || "-"}g｜钠 ${item.sodium || "-"}mg`
    );
  }
  return lines.join("\n");
}

function formatGenericToolResponse(result) {
  const payload = parseToolJsonPayload(result);
  if (payload) {
    return formatJsonCodeBlock(payload);
  }
  return formatToolResult(result);
}

function formatTimestamp(ms, timeZone) {
  if (!ms) {
    return "无";
  }
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return "无";
  }
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

function formatSignedDelta(delta) {
  const safeDelta = Number.isFinite(delta) ? delta : 0;
  const sign = safeDelta >= 0 ? "+" : "-";
  return `(${sign}${Math.abs(safeDelta)})`;
}

function formatCountWithDelta(value, baseline) {
  const current = Number.isFinite(value) ? value : 0;
  const base = Number.isFinite(baseline) ? baseline : current;
  return `${current} ${formatSignedDelta(current - base)}`;
}

const MCP_HEALTH_STATUS = {
  OK: "ok",
  DEGRADED: "degraded",
  DOWN: "down",
  UNKNOWN: "unknown"
};

function getMcpHealth() {
  const state = getGlobalState();
  return state.mcpHealth || {
    status: MCP_HEALTH_STATUS.UNKNOWN,
    lastCheckedAt: 0,
    lastOkAt: 0,
    lastErrorAt: 0,
    lastError: "",
    lastStatusCode: 0,
    consecutiveFailures: 0,
    lastLatencyMs: 0
  };
}

function updateMcpHealth(updates) {
  const current = getMcpHealth();
  const next = {
    ...current,
    ...updates
  };
  updateGlobalState({ mcpHealth: next });
  return next;
}

function recordMcpSuccess(latencyMs, options = {}) {
  const now = Date.now();
  updateMcpHealth({
    status: MCP_HEALTH_STATUS.OK,
    lastCheckedAt: now,
    lastOkAt: now,
    lastErrorAt: 0,
    lastError: "",
    lastStatusCode: Number.isFinite(options.statusCode) ? options.statusCode : 0,
    consecutiveFailures: 0,
    lastLatencyMs: Number.isFinite(latencyMs) ? latencyMs : 0
  });
}

function recordMcpFailure(error, options = {}) {
  const now = Date.now();
  const current = getMcpHealth();
  const failures = (Number(current.consecutiveFailures) || 0) + 1;
  const status =
    failures >= MCP_HEALTH_FAILURE_THRESHOLD ? MCP_HEALTH_STATUS.DOWN : MCP_HEALTH_STATUS.DEGRADED;
  updateMcpHealth({
    status,
    lastCheckedAt: now,
    lastErrorAt: now,
    lastError: sanitizeInlineText(getErrorMessage(error), { maxLength: 200 }),
    lastStatusCode: Number.isFinite(options.statusCode) ? options.statusCode : 0,
    consecutiveFailures: failures,
    lastLatencyMs: Number.isFinite(options.latencyMs) ? options.latencyMs : 0
  });
}

function isMcpDown() {
  const health = getMcpHealth();
  return health.status === MCP_HEALTH_STATUS.DOWN;
}

function formatMcpHealthStatus(status) {
  if (status === MCP_HEALTH_STATUS.OK) {
    return "正常";
  }
  if (status === MCP_HEALTH_STATUS.DEGRADED) {
    return "不稳";
  }
  if (status === MCP_HEALTH_STATUS.DOWN) {
    return "故障";
  }
  return "未知";
}

function getAdminSettings() {
  const state = getGlobalState();
  return state.admin || {};
}

function isAdminErrorPushEnabled() {
  const settings = getAdminSettings();
  return Boolean(settings.errorPushEnabled);
}

function updateAdminSettings(updates) {
  const state = getGlobalState();
  const admin = { ...(state.admin || {}), ...updates };
  updateGlobalState({ admin });
  return admin;
}

async function notifyAdmins(message) {
  if (!isAdminErrorPushEnabled()) {
    return;
  }
  if (!ADMIN_TELEGRAM_IDS.size) {
    return;
  }
  for (const adminId of ADMIN_TELEGRAM_IDS) {
    try {
      await sendPlainMessageToUser(adminId, message);
    } catch (error) {
      console.error("Failed to send admin notification", error);
    }
  }
}

function ensureAdmin(ctx) {
  if (!ADMIN_TELEGRAM_IDS.size) {
    ctx.reply("未配置管理员 ID，请先设置 ADMIN_TELEGRAM_IDS。");
    return false;
  }
  const userId = ctx.from && ctx.from.id ? String(ctx.from.id) : "";
  if (!ADMIN_TELEGRAM_IDS.has(userId)) {
    ctx.reply("无权限使用该指令。");
    return false;
  }
  return true;
}

function getAccountDisplayName(accountId, account) {
  const rawName = account && account.label
    ? account.label
    : accountId === "default"
      ? "默认账号"
      : accountId;
  const safeName = sanitizeInlineText(rawName, { maxLength: 60 });
  return safeName || (accountId === "default" ? "默认账号" : accountId);
}

function buildAccountListText(user, options = {}) {
  const entries = user && user.accounts ? Object.entries(user.accounts) : [];
  if (entries.length === 0) {
    return "暂无账号，请先使用 /account add 添加账号。";
  }
  const includeAutoClaimStatus = Boolean(options.includeAutoClaimStatus);
  const lines = entries.map(([accountId, account]) => {
    const name = getAccountDisplayName(accountId, account);
    const safeAccountId = sanitizeInlineText(accountId, { maxLength: 60 });
    const active = user.activeAccountId === accountId ? "✅" : "▫️";
    const autoClaim = account.autoClaimEnabled ? "开" : "关";
    const reportSuccess = account.autoClaimReportSuccess ? "开" : "关";
    const reportFail = account.autoClaimReportFailure ? "开" : "关";
    const nameWithId = name === safeAccountId ? name : `${name}（${safeAccountId}）`;
    const lastAutoClaimAt = account.lastAutoClaimAt || "从未";
    const lastAutoClaimStatus = account.lastAutoClaimStatus
      ? sanitizeInlineText(account.lastAutoClaimStatus, { maxLength: 120 })
      : "";
    const autoClaimMeta = includeAutoClaimStatus
      ? ` ｜上次:${lastAutoClaimAt}${lastAutoClaimStatus ? `｜状态:${lastAutoClaimStatus}` : ""}`
      : "";
    return `${active} ${nameWithId} ｜自动领券:${autoClaim} ｜汇报(成):${reportSuccess} ｜汇报(败):${reportFail}${autoClaimMeta}`;
  });
  return lines.join("\n");
}

function resolveAccount(userId, accountId) {
  const user = getUser(userId);
  if (!user || !user.accounts || Object.keys(user.accounts).length === 0) {
    return { error: "no_accounts" };
  }

  let resolvedId = accountId;
  if (resolvedId) {
    if (!user.accounts[resolvedId]) {
      return { error: "account_not_found", user };
    }
  } else {
    resolvedId = user.activeAccountId;
    if (!resolvedId || !user.accounts[resolvedId]) {
      const firstId = Object.keys(user.accounts)[0];
      if (firstId) {
        resolvedId = firstId;
        if (user.activeAccountId !== firstId) {
          upsertUser(userId, { activeAccountId: firstId });
        }
      }
    }
  }

  if (!resolvedId || !user.accounts[resolvedId]) {
    return { error: "account_not_found", user };
  }

  const account = user.accounts[resolvedId];
  if (!account || !account.token) {
    return { error: "missing_token", user, accountId: resolvedId };
  }

  return { user, accountId: resolvedId, account };
}

function getAccountInfo(userId, accountId) {
  const user = getUser(userId);
  if (!user || !user.accounts || !user.accounts[accountId]) {
    return null;
  }
  const account = user.accounts[accountId];
  if (!account || !account.token) {
    return null;
  }
  return { userId, accountId, account, displayName: getAccountDisplayName(accountId, account) };
}

function ensureAccount(ctx, accountId) {
  const userId = String(ctx.from.id);
  const info = resolveAccount(userId, accountId);

  if (info.error === "no_accounts") {
    ctx.reply("还没有添加账号，请先使用 /token 或 /account add 添加 MCP Token。");
    return null;
  }
  if (info.error === "account_not_found") {
    ctx.reply(`账号不存在：${accountId}`);
    return null;
  }
  if (info.error === "missing_token") {
    const name = getAccountDisplayName(info.accountId, info.user.accounts[info.accountId]);
    ctx.reply(`账号 ${name} 未设置 Token，请重新设置。`);
    return null;
  }

  return { ...info, userId, displayName: getAccountDisplayName(info.accountId, info.account) };
}

function addOrUpdateAccount(userId, accountId, token, label) {
  const user = getUser(userId) || {};
  const accounts = { ...(user.accounts || {}) };
  const existingAccount = accounts[accountId];
  const isNewAccount = !existingAccount;
  const existing = existingAccount || {};
  const defaultAutoClaimEnabled = isNewAccount;
  const updated = {
    ...existing,
    token,
    label: label || existing.label || accountId,
    autoClaimEnabled:
      typeof existing.autoClaimEnabled === "boolean" ? existing.autoClaimEnabled : defaultAutoClaimEnabled,
    autoClaimReportSuccess: typeof existing.autoClaimReportSuccess === "boolean" ? existing.autoClaimReportSuccess : true,
    autoClaimReportFailure: typeof existing.autoClaimReportFailure === "boolean" ? existing.autoClaimReportFailure : true
  };

  accounts[accountId] = updated;
  const activeAccountId = user.activeAccountId || accountId;
  upsertUser(userId, { accounts, activeAccountId });
  return { existed: Boolean(existing && existing.token), isNewAccount };
}

function updateAccount(userId, accountId, updates) {
  const user = getUser(userId);
  if (!user || !user.accounts || !user.accounts[accountId]) {
    return false;
  }
  const accounts = { ...user.accounts };
  accounts[accountId] = { ...accounts[accountId], ...updates };
  upsertUser(userId, { accounts });
  return true;
}

function removeAccount(userId, accountId) {
  const user = getUser(userId);
  if (!user || !user.accounts || !user.accounts[accountId]) {
    return false;
  }
  const accounts = { ...user.accounts };
  delete accounts[accountId];
  const remainingIds = Object.keys(accounts);
  const activeAccountId = remainingIds.includes(user.activeAccountId)
    ? user.activeAccountId
    : remainingIds[0] || null;
  upsertUser(userId, { accounts, activeAccountId });
  return true;
}

function getToolCacheKey(toolName, args, token) {
  const tokenHash = token ? hashString(token) : 0;
  return `${toolName}:${tokenHash}:${JSON.stringify(args || {})}`;
}

function getAvailableToolsCacheKey(token) {
  return `${MCP_URL}:${hashString(token || "")}:tools`;
}

function invalidateAvailableToolsCache(token) {
  if (!availableToolsCache || !token) {
    return;
  }
  availableToolsCache.delete(getAvailableToolsCacheKey(token));
}

async function getAvailableToolNames(token, options = {}) {
  if (!token) {
    return new Set();
  }
  const cacheKey = getAvailableToolsCacheKey(token);
  if (!options.refresh && availableToolsCache) {
    const cached = availableToolsCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }
  const client = getMcpClient(token);
  const tools = await client.listTools();
  const names = new Set(
    tools
      .map((tool) => {
        if (!tool) {
          return "";
        }
        if (typeof tool === "string") {
          return tool;
        }
        return tool.name || "";
      })
      .filter(Boolean)
  );
  if (availableToolsCache) {
    availableToolsCache.set(cacheKey, names);
  }
  return names;
}

async function resolveKnownToolName(token, toolKey, options = {}) {
  const definition = KNOWN_MCP_TOOLS[toolKey];
  if (!definition) {
    throw new Error(`未知工具定义：${toolKey}`);
  }
  const candidates = definition.names || [];
  if (!candidates.length) {
    throw new Error(`工具 ${toolKey} 未配置候选名。`);
  }

  try {
    const available = await getAvailableToolNames(token, options);
    if (available.size) {
      for (const name of candidates) {
        if (available.has(name)) {
          return name;
        }
      }
      throw new Error(`当前 MCP 服务未提供 ${definition.label} 工具，可用名：${candidates.join(" / ")}`);
    }
  } catch (error) {
    if (options.requireDiscovery) {
      throw error;
    }
  }

  return candidates[0];
}

async function callKnownToolWithToken(token, toolKey, args) {
  const toolName = await resolveKnownToolName(token, toolKey);
  try {
    return await callToolWithToken(token, toolName, args || {});
  } catch (error) {
    if (/unknown tool/i.test(getErrorMessage(error))) {
      invalidateAvailableToolsCache(token);
      const refreshedToolName = await resolveKnownToolName(token, toolKey, { refresh: true });
      if (refreshedToolName !== toolName) {
        return callToolWithToken(token, refreshedToolName, args || {});
      }
    }
    throw error;
  }
}

function buildMcpClient(token) {
  return new MCPClient({
    baseUrl: MCP_URL,
    token,
    protocolVersion: MCP_PROTOCOL_VERSION,
    requestTimeoutMs: MCP_REQUEST_TIMEOUT_MS,
    retryOptions: MCP_RETRY_OPTIONS
  });
}

function getMcpClient(token) {
  if (!mcpClientCache) {
    return buildMcpClient(token);
  }
  const key = `${MCP_URL}:${token}`;
  const cached = mcpClientCache.get(key);
  if (cached) {
    return cached;
  }
  const client = buildMcpClient(token);
  mcpClientCache.set(key, client);
  return client;
}

async function callToolWithToken(token, toolName, args) {
  if (!token) {
    throw new Error("缺少 MCP Token，请先设置。");
  }

  const cacheKey = getToolCacheKey(toolName, args, token);
  const useCache = CACHEABLE_TOOLS.has(toolName);
  if (useCache) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const client = getMcpClient(token);

  const startedAt = Date.now();
  try {
    const result = await client.callTool(toolName, args || {});
    recordMcpSuccess(Date.now() - startedAt);
    if (useCache) {
      cache.set(cacheKey, result);
    }
    return result;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const upstreamFailure = isUpstreamError(error);
    if (upstreamFailure) {
      recordMcpFailure(error, { statusCode: error.status, latencyMs: elapsedMs });
    } else {
      recordMcpSuccess(elapsedMs);
    }
    const safeMessage = formatMcpErrorMessage(error);
    const wrapped = new Error(safeMessage);
    if (error && error.code) {
      wrapped.code = error.code;
    }
    if (Number.isFinite(error && error.status)) {
      wrapped.status = error.status;
    }
    wrapped.isUpstream = upstreamFailure;
    throw wrapped;
  }
}

async function validateToken(token) {
  if (!token) {
    return { ok: false, authFailure: true, message: "缺少 MCP Token，请先设置。" };
  }
  const startedAt = Date.now();
  try {
    const client = getMcpClient(token);
    const toolNames = await getAvailableToolNames(token, { refresh: true });
    if (!toolNames.size) {
      return { ok: false, authFailure: false, message: "未获取到可用工具列表。" };
    }
    recordMcpSuccess(Date.now() - startedAt);
    return { ok: true };
  } catch (error) {
    const message = getErrorMessage(error);
    const elapsedMs = Date.now() - startedAt;
    const upstreamFailure = isUpstreamError(error);
    if (upstreamFailure) {
      recordMcpFailure(error, { statusCode: error.status, latencyMs: elapsedMs });
      return { ok: false, authFailure: false, message: MCP_UPSTREAM_ERROR_MESSAGE };
    }
    recordMcpSuccess(elapsedMs);
    const safeMessage = sanitizeInlineText(message, { maxLength: 400 });
    if (isAuthFailureMessage(message)) {
      return { ok: false, authFailure: true, message: safeMessage };
    }
    return { ok: false, authFailure: false, message: safeMessage || "未知错误" };
  }
}

bot.catch((error, ctx) => {
  console.error("Bot error", error);
  const rawMessage = getErrorMessage(error);
  const message = sanitizeInlineText(rawMessage, { maxLength: 400 });
  const isOldQueryError =
    rawMessage.includes("query is too old") ||
    rawMessage.includes("response timeout expired") ||
    (error.description && error.description.includes("query is too old"));
  if (!isOldQueryError) {
    notifyAdmins(`Bot 运行异常：${message || "未知错误"}`);
  }
  if (ctx && ctx.reply) {
    ctx.reply("出错了，请稍后再试。");
  }
});

bot.start((ctx) => {
  ctx.reply(buildQuickHelpMessage(), { disable_web_page_preview: true, ...MAIN_MENU });
});

bot.command("menu", (ctx) => {
  ctx.reply("请选择功能：", { disable_web_page_preview: true, ...MAIN_MENU });
});

bot.command(["help", "commands"], (ctx) => {
  ctx.reply(buildHelpMessage(), { disable_web_page_preview: true });
});

function sendAccountHelp(ctx) {
  const userId = String(ctx.from.id);
  const user = getUser(userId);
  const listText = user ? buildAccountListText(user) : "暂无账号，请先使用 /account add 添加账号。";
  ctx.reply(`${ACCOUNT_HELP_MESSAGE}\n\n${listText}`);
}

async function handleAccountCommand(ctx, args) {
  const userId = String(ctx.from.id);
  const sub = args[0] ? args[0].toLowerCase() : "";

  if (!sub || sub === "help") {
    sendAccountHelp(ctx);
    return;
  }

  if (sub === "list") {
    sendAccountHelp(ctx);
    return;
  }

  if (sub === "add") {
    const accountId = args[1] ? args[1].trim() : "";
    const token = args.slice(2).join(" ").trim();
    if (!accountId || !token) {
      ctx.reply("用法：/account add 名称 Token");
      return;
    }
    const limit = checkRateLimit(userId, "account_set", ACCOUNT_SET_RATE_LIMIT_MS);
    if (!limit.ok) {
      ctx.reply(`操作过于频繁，请 ${Math.ceil(limit.waitMs / 1000)} 秒后再试。`);
      return;
    }
    const accountCheck = validateAccountIdInput(accountId);
    if (!accountCheck.ok) {
      ctx.reply(accountCheck.message);
      return;
    }
    const tokenCheck = validateTokenInput(token);
    if (!tokenCheck.ok) {
      ctx.reply(tokenCheck.message);
      return;
    }
    const validation = await validateToken(tokenCheck.value);
    if (!validation.ok && validation.authFailure) {
      ctx.reply(`账号 ${accountCheck.value} Token 无效或已失效，请重新获取。`);
      return;
    }
    const result = addOrUpdateAccount(userId, accountCheck.value, tokenCheck.value, accountCheck.value);
    const { existed, isNewAccount } = result;
    if (!validation.ok) {
      ctx.reply(
        `${existed ? "账号已更新" : "账号已添加"}，但暂时无法验证 Token：${validation.message}`
      );
      return;
    }
    ctx.reply(existed ? `账号 ${accountCheck.value} 已更新。` : `账号 ${accountCheck.value} 已添加。`);
    if (isNewAccount) {
      const info = getAccountInfo(userId, accountCheck.value);
      if (info && info.account.autoClaimEnabled) {
        runImmediateAutoClaim(ctx, info).catch((error) => {
          console.error("Immediate auto-claim failed", error);
        });
      }
    }
    return;
  }

  if (sub === "use") {
    const accountId = args[1] ? args[1].trim() : "";
    if (!accountId) {
      ctx.reply("用法：/account use 名称");
      return;
    }
    const accountCheck = validateAccountIdInput(accountId);
    if (!accountCheck.ok) {
      ctx.reply(accountCheck.message);
      return;
    }
    const user = getUser(userId);
    if (!user || !user.accounts || !user.accounts[accountCheck.value]) {
      ctx.reply(`账号不存在：${sanitizeInlineText(accountCheck.value, { maxLength: 60 })}`);
      return;
    }
    upsertUser(userId, { activeAccountId: accountCheck.value });
    ctx.reply(`已切换到账号：${getAccountDisplayName(accountCheck.value, user.accounts[accountCheck.value])}`);
    return;
  }

  if (sub === "del" || sub === "delete" || sub === "rm") {
    const accountId = args[1] ? args[1].trim() : "";
    if (!accountId) {
      ctx.reply("用法：/account del 名称");
      return;
    }
    const accountCheck = validateAccountIdInput(accountId);
    if (!accountCheck.ok) {
      ctx.reply(accountCheck.message);
      return;
    }
    const removed = removeAccount(userId, accountCheck.value);
    const safeAccountId = sanitizeInlineText(accountCheck.value, { maxLength: 60 });
    ctx.reply(removed ? `账号 ${safeAccountId} 已删除。` : `账号不存在：${safeAccountId}`);
    return;
  }

  ctx.reply("未知子命令。\n" + ACCOUNT_HELP_MESSAGE);
}

bot.command(["token", "settoken"], async (ctx) => {
  const args = parseCommandArgs(ctx);
  const sub = args[0] ? args[0].toLowerCase() : "";
  if (["add", "use", "list", "del", "delete", "rm", "help"].includes(sub)) {
    await handleAccountCommand(ctx, args);
    return;
  }

  const token = args.join(" ").trim();
  if (!token) {
    ctx.reply("用法：/token 你的MCP_TOKEN");
    return;
  }

  const userId = String(ctx.from.id);
  const limit = checkRateLimit(userId, "token_set", TOKEN_SET_RATE_LIMIT_MS);
  if (!limit.ok) {
    ctx.reply(`操作过于频繁，请 ${Math.ceil(limit.waitMs / 1000)} 秒后再试。`);
    return;
  }
  const tokenCheck = validateTokenInput(token);
  if (!tokenCheck.ok) {
    ctx.reply(tokenCheck.message);
    return;
  }
  const user = getUser(userId);
  const accountId = user && user.activeAccountId ? user.activeAccountId : "default";
  const validation = await validateToken(tokenCheck.value);
  if (!validation.ok && validation.authFailure) {
    ctx.reply("Token 无效或已失效，请重新获取。");
    return;
  }
  const result = addOrUpdateAccount(
    userId,
    accountId,
    tokenCheck.value,
    accountId === "default" ? "默认账号" : accountId
  );
  const { existed, isNewAccount } = result;
  if (!validation.ok) {
    ctx.reply(`${existed ? "Token 已更新" : "Token 已保存"}，但暂时无法验证：${validation.message}`);
    return;
  }
  ctx.reply(existed ? "Token 已更新，可以继续使用。" : "Token 已保存，可以开始使用指令了。");
  if (isNewAccount) {
    const info = getAccountInfo(userId, accountId);
    if (info && info.account.autoClaimEnabled) {
      runImmediateAutoClaim(ctx, info).catch((error) => {
        console.error("Immediate auto-claim failed", error);
      });
    }
  }
});

bot.command(["account", "accounts"], async (ctx) => {
  const args = parseCommandArgs(ctx);
  await handleAccountCommand(ctx, args);
});

bot.command("cleartoken", (ctx) => {
  const userId = String(ctx.from.id);
  const existing = getUser(userId);
  if (!existing) {
    ctx.reply("未找到已保存的账号。");
    return;
  }
  deleteUser(userId);
  ctx.reply("已清空全部账号。");
});

function sendStatus(ctx) {
  const userId = String(ctx.from.id);
  const user = getUser(userId);
  if (!user || !user.accounts || Object.keys(user.accounts).length === 0) {
    ctx.reply("还没有添加账号，请先使用 /token 或 /account add 设置。");
    return;
  }
  const activeId = user.activeAccountId;
  const activeAccount = activeId ? user.accounts[activeId] : null;
  const activeName = activeAccount ? getAccountDisplayName(activeId, activeAccount) : "未选择";
  const autoClaimStatus = activeAccount && activeAccount.autoClaimEnabled ? "已开启" : "已关闭";
  const reportSuccessStatus = activeAccount && activeAccount.autoClaimReportSuccess ? "已开启" : "已关闭";
  const reportFailureStatus = activeAccount && activeAccount.autoClaimReportFailure ? "已开启" : "已关闭";
  const lastRun = activeAccount && activeAccount.lastAutoClaimAt ? activeAccount.lastAutoClaimAt : "从未执行";
  const listText = buildAccountListText(user, { includeAutoClaimStatus: true });

  ctx.reply(
    [
      `当前账号：${activeName}`,
      `自动领券：${autoClaimStatus}`,
      `成功汇报：${reportSuccessStatus}`,
      `失败汇报：${reportFailureStatus}`,
      `上次自动领券：${lastRun}`,
      "",
      "账号列表：",
      listText
    ].join("\n")
  );
}

bot.command("status", sendStatus);

function sendStats(ctx) {
  const userId = String(ctx.from.id);
  const user = getUser(userId);
  const stats = user && user.stats ? user.stats : { autoClaimRuns: 0, manualClaimRuns: 0, couponsClaimed: 0 };
  ctx.reply(
    [
      "我的领券统计：",
      `自动领券次数：${stats.autoClaimRuns || 0}`,
      `手动领券次数：${stats.manualClaimRuns || 0}`,
      `累计领取优惠券：${stats.couponsClaimed || 0}`
    ].join("\n")
  );
}

bot.command("stats", sendStats);

function computeAdminMetrics(today) {
  const users = allUsers();
  const metrics = {
    userCount: Object.keys(users).length,
    accountCount: 0,
    autoClaimEnabledCount: 0,
    autoClaimDisabledCount: 0,
    doneCount: 0,
    pendingCount: 0,
    todayAutoClaimSuccess: 0,
    todayAutoClaimFailureAuth: 0,
    todayAutoClaimFailureOther: 0,
    totalAutoClaimRuns: 0,
    totalManualClaimRuns: 0,
    totalCouponsClaimed: 0,
    knownCouponsCount: 0
  };

  for (const user of Object.values(users)) {
    const accounts = user.accounts || {};
    const entries = Object.values(accounts);
    metrics.accountCount += entries.length;
    for (const account of entries) {
      if (!account) {
        continue;
      }
      const ranToday = account.lastAutoClaimDate === today;
      if (ranToday && account.lastAutoClaimStatus) {
        const status = String(account.lastAutoClaimStatus);
        if (status.startsWith("成功")) {
          metrics.todayAutoClaimSuccess += 1;
        } else if (status.startsWith("失败")) {
          const reason = status.replace(/^失败[:：]\s*/, "");
          if (isAuthFailureMessage(reason) || isAuthFailureMessage(status)) {
            metrics.todayAutoClaimFailureAuth += 1;
          } else {
            metrics.todayAutoClaimFailureOther += 1;
          }
        }
      }
      if (account.autoClaimEnabled) {
        metrics.autoClaimEnabledCount += 1;
        if (ranToday) {
          metrics.doneCount += 1;
        } else {
          metrics.pendingCount += 1;
        }
      } else {
        metrics.autoClaimDisabledCount += 1;
      }
    }

    const stats = user.stats || {};
    metrics.totalAutoClaimRuns += Number(stats.autoClaimRuns) || 0;
    metrics.totalManualClaimRuns += Number(stats.manualClaimRuns) || 0;
    metrics.totalCouponsClaimed += Number(stats.couponsClaimed) || 0;
  }

  const state = getGlobalState();
  metrics.knownCouponsCount = state.knownCoupons ? Object.keys(state.knownCoupons).length : 0;

  return metrics;
}

function getAdminSummaryBaseline(today, metrics) {
  const state = getGlobalState();
  const snapshot = state.adminSummarySnapshot;
  if (snapshot && snapshot.date === today && snapshot.metrics && typeof snapshot.metrics === "object") {
    return snapshot.metrics;
  }
  const baseline = { ...(metrics || computeAdminMetrics(today)) };
  updateGlobalState({ adminSummarySnapshot: { date: today, metrics: baseline } });
  return baseline;
}

bot.command("admin", (ctx) => {
  if (!ensureAdmin(ctx)) {
    return;
  }
  const args = parseCommandArgs(ctx);
  const sub = args[0] ? args[0].toLowerCase() : "";

  if (sub === "notify" || sub === "push" || sub === "alert") {
    const setting = args[1] ? args[1].toLowerCase() : "";
    if (setting !== "on" && setting !== "off") {
      ctx.reply("用法：/admin notify on|off");
      return;
    }
    const enabled = setting === "on";
    updateAdminSettings({ errorPushEnabled: enabled });
    ctx.reply(`管理员报错推送已${enabled ? "开启" : "关闭"}。`);
    return;
  }

  if (
    !sub ||
    sub === "summary" ||
    sub === "users" ||
    sub === "stats" ||
    sub === "count" ||
    sub === "status"
  ) {
    const today = getLocalDate(AUTO_CLAIM_TIMEZONE);
    const metrics = computeAdminMetrics(today);
    const baseline = getAdminSummaryBaseline(today, metrics);
    const totalFailure = metrics.todayAutoClaimFailureAuth + metrics.todayAutoClaimFailureOther;
    const baselineFailure =
      (Number(baseline.todayAutoClaimFailureAuth) || 0) + (Number(baseline.todayAutoClaimFailureOther) || 0);
    const state = getGlobalState();
    const lastRequestAt = formatTimestamp(state.lastAutoClaimRequestAt, AUTO_CLAIM_TIMEZONE);
    const lastSweepStartedAt = formatTimestamp(state.lastSweepStartedAt, AUTO_CLAIM_TIMEZONE);
    const lastSweepFinishedAt = formatTimestamp(state.lastSweepFinishedAt, AUTO_CLAIM_TIMEZONE);
    const lastSweepDuration = state.lastSweepDurationMs
      ? `${Math.round(state.lastSweepDurationMs / 1000)}秒`
      : "无";
    const lastSweepProcessed = Number(state.lastSweepProcessed) || 0;
    const lastSweepEligible = Number(state.lastSweepEligible) || 0;
    const lastSweepReason = state.lastSweepReason || "无";
    const lastSweepError = state.lastSweepError || "无";

    const burst = getActiveBurst();
    const burstRemainingMs = burst ? Math.max(0, burst.endAt - Date.now()) : 0;
    const burstRemainingMinutes = burst ? Math.ceil(burstRemainingMs / 60000) : 0;
    const burstTriggeredAt = burst ? formatTimestamp(burst.startAt, AUTO_CLAIM_TIMEZONE) : "无";
    const burstCouponCount = burst && Array.isArray(burst.couponIds) ? burst.couponIds.length : 0;
    const burstStatus = burst
      ? `进行中（剩余约 ${burstRemainingMinutes} 分钟，券 ${burstCouponCount} 张，触发 ${burstTriggeredAt}）`
      : "无";

    const mcpHealth = getMcpHealth();
    const mcpStatus = formatMcpHealthStatus(mcpHealth.status);
    const mcpLastCheck = formatTimestamp(mcpHealth.lastCheckedAt, AUTO_CLAIM_TIMEZONE);
    const mcpLastOk = formatTimestamp(mcpHealth.lastOkAt, AUTO_CLAIM_TIMEZONE);
    const mcpFailures = Number(mcpHealth.consecutiveFailures) || 0;
    const mcpLastStatusCode = mcpHealth.lastStatusCode || "无";
    const mcpLastError = mcpHealth.lastError || "无";

    const errorPushStatus = isAdminErrorPushEnabled() ? "开" : "关";
    const rerunWindow = AUTO_CLAIM_SPREAD_RERUN_MINUTES
      ? `已执行账号 ${AUTO_CLAIM_SPREAD_RERUN_MINUTES} 分钟后允许重跑`
      : "不重复执行";

    ctx.reply(
      [
        "管理员概览：",
        `用户数：${formatCountWithDelta(metrics.userCount, baseline.userCount)}`,
        `账号数：${formatCountWithDelta(metrics.accountCount, baseline.accountCount)}`,
        `自动领券开启账号数：${formatCountWithDelta(metrics.autoClaimEnabledCount, baseline.autoClaimEnabledCount)}`,
        `自动领券关闭账号数：${formatCountWithDelta(metrics.autoClaimDisabledCount, baseline.autoClaimDisabledCount)}`,
        `今日已执行账号数：${formatCountWithDelta(metrics.doneCount, baseline.doneCount)}`,
        `今日待执行账号数：${formatCountWithDelta(metrics.pendingCount, baseline.pendingCount)}`,
        `今日自动领券成功数：${formatCountWithDelta(metrics.todayAutoClaimSuccess, baseline.todayAutoClaimSuccess)}`,
        `今日自动领券失败数：${formatCountWithDelta(totalFailure, baselineFailure)}（鉴权${formatCountWithDelta(
          metrics.todayAutoClaimFailureAuth,
          baseline.todayAutoClaimFailureAuth
        )}｜其他${formatCountWithDelta(metrics.todayAutoClaimFailureOther, baseline.todayAutoClaimFailureOther)}）`,
        `自动领券次数总计：${formatCountWithDelta(metrics.totalAutoClaimRuns, baseline.totalAutoClaimRuns)}`,
        `手动领券次数总计：${formatCountWithDelta(metrics.totalManualClaimRuns, baseline.totalManualClaimRuns)}`,
        `累计领取优惠券总计：${formatCountWithDelta(metrics.totalCouponsClaimed, baseline.totalCouponsClaimed)}`,
        `已记录券 ID 数量：${formatCountWithDelta(metrics.knownCouponsCount, baseline.knownCouponsCount)}`,
        `最近自动领券请求：${lastRequestAt}`,
        `最近 Sweep：开始 ${lastSweepStartedAt} ｜结束 ${lastSweepFinishedAt} ｜耗时 ${lastSweepDuration} ｜原因 ${lastSweepReason}`,
        `Sweep 进度：符合 ${lastSweepEligible} ｜已处理 ${lastSweepProcessed} ｜状态 ${autoClaimSweepInProgress ? "运行中" : "空闲"}`,
        `Sweep 错误：${lastSweepError}`,
        `Burst 窗口：${burstStatus}`,
        `MCP 状态：${mcpStatus}｜最近检查 ${mcpLastCheck}｜最近成功 ${mcpLastOk}｜连续失败 ${mcpFailures}｜状态码 ${mcpLastStatusCode}`,
        `MCP 最近错误：${mcpLastError}`,
        `报错推送：${errorPushStatus}`,
        `调度配置：检查${AUTO_CLAIM_CHECK_MINUTES}分钟｜起始${AUTO_CLAIM_HOUR}点｜分散${AUTO_CLAIM_SPREAD_MINUTES}分钟｜${rerunWindow}｜每轮上限${AUTO_CLAIM_MAX_PER_SWEEP}｜间隔${AUTO_CLAIM_REQUEST_GAP_MS}ms｜Burst${GLOBAL_BURST_WINDOW_MINUTES}分钟/检查${GLOBAL_BURST_CHECK_SECONDS}s｜时区${AUTO_CLAIM_TIMEZONE}`
      ].join("\n")
    );
    return;
  }

  if (sub === "sweep" || sub === "run") {
    runAutoClaimSweep()
      .then(() => {
        const state = getGlobalState();
        ctx.reply(
          [
            "手动触发 Sweep 完成：",
            `开始：${formatTimestamp(state.lastSweepStartedAt, AUTO_CLAIM_TIMEZONE)}`,
            `结束：${formatTimestamp(state.lastSweepFinishedAt, AUTO_CLAIM_TIMEZONE)}`,
            `耗时：${state.lastSweepDurationMs ? `${Math.round(state.lastSweepDurationMs / 1000)}秒` : "无"}`,
            `原因：${state.lastSweepReason || "无"}`,
            `符合：${state.lastSweepEligible || 0}`,
            `已处理：${state.lastSweepProcessed || 0}`,
            `错误：${state.lastSweepError || "无"}`
          ].join("\n")
        );
      })
      .catch((error) => {
        ctx.reply(`手动 Sweep 失败：${sanitizeInlineText(getErrorMessage(error), { maxLength: 400 })}`);
      });
    return;
  }

  ctx.reply("用法：/admin | /admin notify on|off | /admin sweep");
});

function sendTokenGuide(ctx) {
  ctx.reply(TOKEN_GUIDE_MESSAGE, { disable_web_page_preview: true });
}

async function sendTelegraphArticle(ctx, title, rawText, fallbackPrefix, cacheKey) {
  const nodes = buildTelegraphNodes(rawText);
  if (!nodes.length) {
    await sendLongMessage(ctx, "未返回数据。");
    return;
  }

  try {
    if (cacheKey) {
      const cached = telegraphCache.get(cacheKey);
      if (cached) {
        const message = `<a href="${escapeHtml(cached)}">点击查看</a>`;
        await ctx.reply(message, {
          disable_web_page_preview: false,
          parse_mode: "HTML"
        });
        return;
      }
    }

    const url = await createTelegraphPage(title, nodes);
    if (cacheKey) {
      telegraphCache.set(cacheKey, url);
    }
    const message = `<a href="${escapeHtml(url)}">点击查看</a>`;
    await ctx.reply(message, {
      disable_web_page_preview: false,
      parse_mode: "HTML"
    });
  } catch (error) {
    const label = fallbackPrefix || title || "内容";
    const safeLabel = sanitizeInlineText(label, { maxLength: 60 });
    const safeError = sanitizeInlineText(getErrorMessage(error), { maxLength: 200 });
    const warning = escapeHtml(
      `${safeLabel} Telegraph 生成失败，已改用文本展示：${safeError || "未知错误"}`
    );
    await sendLongMessage(ctx, warning + "\n\n" + formatTelegramHtml(stripImagesFromText(rawText)));
  }
}

async function sendPlainToolText(ctx, text) {
  await sendLongMessage(ctx, formatTelegramHtml(text || "未返回数据。"));
}

async function sendHtmlToolText(ctx, html) {
  await sendLongMessage(ctx, html || "未返回数据。");
}

async function handleToolsList(ctx) {
  const info = ensureAccount(ctx);
  if (!info) return;

  try {
    const toolNames = await getAvailableToolNames(info.account.token, { refresh: true });
    await sendPlainToolText(ctx, formatToolListMessage(toolNames));
  } catch (error) {
    ctx.reply(`工具列表查询失败：${formatMcpErrorMessage(error)}`);
  }
}

async function handlePoints(ctx) {
  const info = ensureAccount(ctx);
  if (!info) return;

  try {
    const result = await callKnownToolWithToken(info.account.token, "myAccount", {});
    await sendPlainToolText(ctx, formatPointsText(getStructuredToolData(result)));
  } catch (error) {
    ctx.reply(`积分查询失败：${formatMcpErrorMessage(error)}`);
  }
}

async function handleNowTime(ctx) {
  const info = ensureAccount(ctx);
  if (!info) return;

  try {
    const result = await callKnownToolWithToken(info.account.token, "nowTimeInfo", {});
    await sendPlainToolText(ctx, formatNowTimeText(getStructuredToolData(result)));
  } catch (error) {
    ctx.reply(`时间信息查询失败：${formatMcpErrorMessage(error)}`);
  }
}

async function handleNutrition(ctx, keyword) {
  const info = ensureAccount(ctx);
  if (!info) return;

  try {
    const result = await callKnownToolWithToken(info.account.token, "nutritionFoods", {});
    await sendPlainToolText(ctx, formatNutritionText(result, keyword));
  } catch (error) {
    ctx.reply(`营养信息查询失败：${formatMcpErrorMessage(error)}`);
  }
}

async function handleMallCommand(ctx, payload) {
  const info = ensureAccount(ctx);
  if (!info) return;

  const { head: subcommand, tail } = splitFirstToken(payload);
  const sub = subcommand.toLowerCase();
  if (!sub || sub === "list") {
    try {
      const result = await callKnownToolWithToken(info.account.token, "mallProducts", {});
      await sendPlainToolText(ctx, formatMallProductsText(getStructuredToolData(result)));
    } catch (error) {
      ctx.reply(`积分商城列表查询失败：${formatMcpErrorMessage(error)}`);
    }
    return;
  }

  if (sub === "detail") {
    if (!tail) {
      ctx.reply("用法：/mall detail <spuId>");
      return;
    }
    const spuId = Number(tail);
    if (!Number.isFinite(spuId)) {
      ctx.reply("spuId 必须是数字。");
      return;
    }
    try {
      const result = await callKnownToolWithToken(info.account.token, "mallProductDetail", { spuId });
      await sendPlainToolText(ctx, formatMallProductDetailText(getStructuredToolData(result)));
    } catch (error) {
      ctx.reply(`积分商品详情查询失败：${formatMcpErrorMessage(error)}`);
    }
    return;
  }

  if (sub === "redeem") {
    const args = tail.split(/\s+/).filter(Boolean);
    const skuId = args[0];
    const count = args[1] ? Number(args[1]) : 1;
    if (!skuId) {
      ctx.reply("用法：/mall redeem <skuId> [count]");
      return;
    }
    if (!Number.isFinite(Number(skuId))) {
      ctx.reply("skuId 必须是数字。");
      return;
    }
    try {
      const result = await callKnownToolWithToken(info.account.token, "mallCreateOrder", {
        skuId: Number(skuId),
        ...(Number.isFinite(count) && count > 0 ? { count } : {})
      });
      await sendPlainToolText(ctx, formatMallRedeemText(getStructuredToolData(result)));
    } catch (error) {
      ctx.reply(`积分兑换失败：${formatMcpErrorMessage(error)}`);
    }
    return;
  }

  ctx.reply("用法：/mall list | /mall detail <spuId> | /mall redeem <skuId> [count]");
}

async function handleDeliveryAddressesCommand(ctx, typeInput) {
  const info = ensureAccount(ctx);
  if (!info) return;

  const parsedType = normalizeDeliveryTypeInput(typeInput);
  if (!parsedType.ok) {
    ctx.reply("用法：/deliveryaddrs mls|group");
    return;
  }

  try {
    const result = await callKnownToolWithToken(info.account.token, "deliveryAddresses", { beType: parsedType.value });
    await sendPlainToolText(ctx, formatDeliveryAddressesText(getStructuredToolData(result), parsedType.label));
  } catch (error) {
    ctx.reply(`配送地址查询失败：${formatMcpErrorMessage(error)}`);
  }
}

async function handleDeliveryAddCommand(ctx, payload) {
  const info = ensureAccount(ctx);
  if (!info) return;

  const { head: typeInput, tail } = splitFirstToken(payload);
  const parsedType = normalizeDeliveryTypeInput(typeInput);
  if (!parsedType.ok) {
    ctx.reply("用法：/deliveryadd mls|group 城市|联系人|电话|地址|门牌|性别(可选)");
    return;
  }
  const fields = parsePipeFields(tail);
  const [city, contactName, phone, address, addressDetail, gender] = fields;
  if (!city || !contactName || !phone || !address || !addressDetail) {
    ctx.reply("用法：/deliveryadd mls|group 城市|联系人|电话|地址|门牌|性别(可选)");
    return;
  }

  try {
    const result = await callKnownToolWithToken(info.account.token, "createDeliveryAddress", {
      city,
      contactName,
      phone,
      address,
      addressDetail,
      beType: parsedType.value,
      ...(gender ? { gender } : {})
    });
    const data = getStructuredToolData(result);
    const text = [
      `${parsedType.label}地址创建成功：`,
      `联系人: ${data && data.contactName ? data.contactName : contactName}`,
      `电话: ${data && data.phone ? data.phone : phone}`,
      `地址: ${data && data.fullAddress ? data.fullAddress : `${city} ${address} ${addressDetail}`}`,
      `addressId: ${data && data.addressId ? data.addressId : "-"}`,
      `门店: ${data && data.storeName ? `${data.storeName} (${data.storeCode || "-"})` : "-"}`,
      `beCode: ${data && data.beCode ? data.beCode : "-"}`
    ].join("\n");
    await sendPlainToolText(ctx, text);
  } catch (error) {
    ctx.reply(`配送地址创建失败：${formatMcpErrorMessage(error)}`);
  }
}

async function handleStoresCommand(ctx, payload) {
  const info = ensureAccount(ctx);
  if (!info) return;

  const { head: subcommand, tail } = splitFirstToken(payload);
  const sub = subcommand.toLowerCase();

  if (!sub || sub === "fav" || sub === "favorite" || sub === "favorites") {
    try {
      const result = await callKnownToolWithToken(info.account.token, "nearbyStores", {
        searchType: 1,
        beType: 1
      });
      await sendPlainToolText(ctx, formatNearbyStoresText(getStructuredToolData(result)));
    } catch (error) {
      ctx.reply(`收藏门店查询失败：${formatMcpErrorMessage(error)}`);
    }
    return;
  }

  if (sub === "search") {
    const { head: city, tail: keyword } = splitFirstToken(tail);
    if (!city || !keyword) {
      ctx.reply("用法：/stores search 城市 关键词");
      return;
    }
    try {
      const result = await callKnownToolWithToken(info.account.token, "nearbyStores", {
        searchType: 2,
        beType: 1,
        city,
        keyword
      });
      await sendPlainToolText(ctx, formatNearbyStoresText(getStructuredToolData(result)));
    } catch (error) {
      ctx.reply(`门店搜索失败：${formatMcpErrorMessage(error)}`);
    }
    return;
  }

  ctx.reply("用法：/stores fav | /stores search 城市 关键词");
}

async function handleStoreCouponsCommand(ctx, args) {
  const info = ensureAccount(ctx);
  if (!info) return;

  const [storeCode, orderTypeInput, beCode] = args;
  const parsed = buildStoreToolArgs(storeCode, orderTypeInput, beCode);
  if (!parsed.ok) {
    ctx.reply("用法：/storecoupons <storeCode> <pickup|delivery> [beCode]");
    return;
  }

  try {
    const result = await callKnownToolWithToken(info.account.token, "storeCoupons", parsed.value);
    await sendPlainToolText(ctx, formatStoreCouponsText(getStructuredToolData(result)));
  } catch (error) {
    ctx.reply(`门店优惠券查询失败：${formatMcpErrorMessage(error)}`);
  }
}

async function handleMealsCommand(ctx, args) {
  const info = ensureAccount(ctx);
  if (!info) return;

  const [storeCode, orderTypeInput, beCode] = args;
  const parsed = buildStoreToolArgs(storeCode, orderTypeInput, beCode);
  if (!parsed.ok) {
    ctx.reply("用法：/meals <storeCode> <pickup|delivery> [beCode]");
    return;
  }

  try {
    const result = await callKnownToolWithToken(info.account.token, "meals", parsed.value);
    await sendPlainToolText(ctx, formatMealsText(getStructuredToolData(result)));
  } catch (error) {
    ctx.reply(`门店菜单查询失败：${formatMcpErrorMessage(error)}`);
  }
}

async function handleMealDetailCommand(ctx, args) {
  const info = ensureAccount(ctx);
  if (!info) return;

  const [code, storeCode, orderTypeInput, beCode] = args;
  if (!code) {
    ctx.reply("用法：/mealdetail <code> <storeCode> <pickup|delivery> [beCode]");
    return;
  }
  const parsed = buildStoreToolArgs(storeCode, orderTypeInput, beCode);
  if (!parsed.ok) {
    ctx.reply("用法：/mealdetail <code> <storeCode> <pickup|delivery> [beCode]");
    return;
  }

  try {
    const result = await callKnownToolWithToken(info.account.token, "mealDetail", {
      code,
      ...parsed.value
    });
    await sendPlainToolText(ctx, formatMealDetailText(getStructuredToolData(result)));
  } catch (error) {
    ctx.reply(`餐品详情查询失败：${formatMcpErrorMessage(error)}`);
  }
}

async function handlePriceCommand(ctx, payload) {
  const info = ensureAccount(ctx);
  if (!info) return;

  const parsed = parseJsonPayload(
    payload,
    '用法：/price {"storeCode":"12345","orderType":"pickup","items":[{"productCode":"9900008139","quantity":1}]}'
  );
  if (!parsed.ok) {
    ctx.reply(parsed.message);
    return;
  }
  const args = { ...parsed.value };
  if (args.orderType !== undefined) {
    const orderType = normalizeOrderTypeInput(args.orderType);
    if (!orderType.ok) {
      ctx.reply(orderType.message);
      return;
    }
    args.orderType = orderType.value;
  }
  if (!Array.isArray(args.items) || !args.items.length) {
    ctx.reply("price 参数中的 items 必须是非空数组。");
    return;
  }
  if (args.orderType === 2 && !args.beCode) {
    ctx.reply("外送价格计算必须提供 beCode。");
    return;
  }
  if (args.orderType === 1) {
    delete args.beCode;
  }

  try {
    const result = await callKnownToolWithToken(info.account.token, "calculatePrice", args);
    await sendPlainToolText(ctx, formatPriceResultText(getStructuredToolData(result)));
  } catch (error) {
    ctx.reply(`价格计算失败：${formatMcpErrorMessage(error)}`);
  }
}

async function handleOrderCommand(ctx, payload) {
  const info = ensureAccount(ctx);
  if (!info) return;

  const { head: subcommand, tail } = splitFirstToken(payload);
  const sub = subcommand.toLowerCase();
  if (sub === "query") {
    if (!tail) {
      ctx.reply("用法：/order query <orderId>");
      return;
    }
    try {
      const result = await callKnownToolWithToken(info.account.token, "queryOrder", { orderId: tail });
      await sendPlainToolText(ctx, formatOrderText(getStructuredToolData(result), { title: "订单详情：" }));
    } catch (error) {
      ctx.reply(`订单查询失败：${formatMcpErrorMessage(error)}`);
    }
    return;
  }

  if (sub === "create") {
    const parsed = parseJsonPayload(
      tail,
      '用法：/order create {"storeCode":"12345","orderType":"pickup","takeWayCode":"locker-in","items":[{"productCode":"9900008139","quantity":1}]}'
    );
    if (!parsed.ok) {
      ctx.reply(parsed.message);
      return;
    }
    const args = { ...parsed.value };
    if (args.orderType !== undefined) {
      const orderType = normalizeOrderTypeInput(args.orderType);
      if (!orderType.ok) {
        ctx.reply(orderType.message);
        return;
      }
      args.orderType = orderType.value;
    }
    if (!Array.isArray(args.items) || !args.items.length) {
      ctx.reply("order create 参数中的 items 必须是非空数组。");
      return;
    }
    if (args.orderType === 2 && !args.beCode) {
      ctx.reply("外送下单必须提供 beCode。");
      return;
    }
    if (args.orderType === 1) {
      delete args.beCode;
    }

    try {
      const result = await callKnownToolWithToken(info.account.token, "createOrder", args);
      await sendPlainToolText(
        ctx,
        formatOrderText(getStructuredToolData(result), { title: "下单结果：", includeNestedDetail: true })
      );
    } catch (error) {
      ctx.reply(`创建订单失败：${formatMcpErrorMessage(error)}`);
    }
    return;
  }

  ctx.reply("用法：/order create <json> | /order query <orderId>");
}

async function handleRawToolCommand(ctx, payload) {
  const info = ensureAccount(ctx);
  if (!info) return;

  const { head: toolName, tail } = splitFirstToken(payload);
  if (!toolName) {
    ctx.reply('用法：/tool <toolName> [json]\n例如：/tool now-time-info\n/tool query-order {"orderId":"123"}');
    return;
  }

  let args = {};
  if (tail) {
    const parsed = parseJsonPayload(tail, "tool 的第二段参数必须是 JSON 对象。");
    if (!parsed.ok) {
      ctx.reply(parsed.message);
      return;
    }
    args = parsed.value;
  }

  try {
    const result = await callToolWithToken(info.account.token, toolName, args);
    await sendHtmlToolText(ctx, formatGenericToolResponse(result));
  } catch (error) {
    ctx.reply(`工具调用失败：${formatMcpErrorMessage(error)}`);
  }
}

async function handleCalendar(ctx, specifiedDate) {
  const info = ensureAccount(ctx);
  if (!info) return;

  let args = {};
  if (specifiedDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(specifiedDate)) {
      ctx.reply("日期格式错误，请使用 YYYY-MM-DD。");
      return;
    }
    args = { specifiedDate };
  }

  try {
    const result = await callKnownToolWithToken(info.account.token, "calendar", args);
    const rawText = getToolRawText(result);
    const cleaned = normalizeCalendarText(rawText);
    const title = specifiedDate ? `麦当劳活动日历（${specifiedDate}）` : "麦当劳活动日历";
    const toolName = await resolveKnownToolName(info.account.token, "calendar");
    const cacheKey = getToolCacheKey(toolName, args, info.account.token);
    await sendTelegraphArticle(ctx, title, cleaned, "活动日历", cacheKey);
  } catch (error) {
    ctx.reply(`活动日历查询失败：${formatMcpErrorMessage(error)}`);
  }
}

async function handleAvailableCoupons(ctx) {
  const info = ensureAccount(ctx);
  if (!info) return;

  try {
    const result = await callKnownToolWithToken(info.account.token, "availableCoupons", {});
    const rawText = getToolRawText(result);
    const cleaned = normalizeCouponListText(rawText);
    const toolName = await resolveKnownToolName(info.account.token, "availableCoupons");
    const cacheKey = getToolCacheKey(toolName, {}, info.account.token);
    await sendTelegraphArticle(ctx, "麦麦省优惠券列表", cleaned, "优惠券列表", cacheKey);
  } catch (error) {
    ctx.reply(`优惠券列表查询失败：${formatMcpErrorMessage(error)}`);
  }
}

async function handleClaimCoupons(ctx) {
  const info = ensureAccount(ctx);
  if (!info) return;

  try {
    const result = await callKnownToolWithToken(info.account.token, "claimCoupons", {});
    const rawText = getToolRawText(result);
    const normalized = normalizeToolText(rawText);
    const simplified = simplifyClaimResultText(normalized);
    const claimedCount = getClaimedCouponCount(normalized);
    recordClaimedCoupons(normalized, { userId: info.userId, accountId: info.accountId, reason: "manual" });
    incrementUserStats(info.userId, { manualClaimRuns: 1, couponsClaimed: claimedCount });
    const text = formatTelegramHtml(stripImagesFromText(simplified));
    await sendLongMessage(ctx, text || "未返回数据。");
  } catch (error) {
    ctx.reply(`一键领券失败：${formatMcpErrorMessage(error)}`);
  }
}

async function runImmediateAutoClaim(ctx, info) {
  const taskKey = `${info.userId}:${info.accountId}`;
  if (autoClaimInProgress.has(taskKey)) {
    ctx.reply(`账号 ${info.displayName} 正在自动领券中，请稍后再试。`);
    return;
  }
  autoClaimInProgress.add(taskKey);
  const today = getLocalDate(AUTO_CLAIM_TIMEZONE);

  try {
    const result = await callKnownToolWithToken(info.account.token, "claimCoupons", {});
    const rawText = getToolRawText(result);
    const normalized = normalizeToolText(rawText);
    const simplified = simplifyClaimResultText(normalized);
    const claimedCount = getClaimedCouponCount(normalized);
    recordClaimedCoupons(normalized, { userId: info.userId, accountId: info.accountId, reason: "enable" });
    incrementUserStats(info.userId, { autoClaimRuns: 1, couponsClaimed: claimedCount });
    updateAccount(info.userId, info.accountId, {
      lastAutoClaimDate: today,
      lastAutoClaimAt: getLocalDateTime(AUTO_CLAIM_TIMEZONE),
      lastAutoClaimStatus: "成功",
      lastRerunAt: Date.now()
    });

    const safeName = safeHtmlText(info.displayName, { maxLength: 60 });
    const text = [
      `自动领券结果（${today}）- 账号：${safeName}`,
      "",
      formatTelegramHtml(stripImagesFromText(simplified))
    ].join("\n");
    await sendLongMessage(ctx, text || "未返回数据。");
  } catch (error) {
    const message = formatMcpErrorMessage(error);
    const authFailure = isAuthFailureMessage(message);
    const updates = {
      lastAutoClaimDate: today,
      lastAutoClaimAt: getLocalDateTime(AUTO_CLAIM_TIMEZONE),
      lastAutoClaimStatus: `失败：${message}`,
      lastRerunAt: Date.now()
    };
    if (authFailure) {
      updates.lastAuthFailureNotifiedDate = today;
    }
    updateAccount(info.userId, info.accountId, updates);
    ctx.reply(`自动领券失败（${today}）- 账号：${info.displayName}\n原因：${message}`);
  } finally {
    autoClaimInProgress.delete(taskKey);
  }
}

async function handleMyCoupons(ctx) {
  const info = ensureAccount(ctx);
  if (!info) return;

  try {
    const result = await callKnownToolWithToken(info.account.token, "myCoupons", {});
    const rawText = getToolRawText(result);
    const normalized = normalizeMyCouponsText(rawText);
    const text = formatTelegramHtml(stripImagesFromText(normalized));
    await sendLongMessage(ctx, text || "未返回数据。");
  } catch (error) {
    ctx.reply(`我的优惠券查询失败：${formatMcpErrorMessage(error)}`);
  }
}

function handleAutoClaimSetting(ctx, enabled, accountId) {
  const info = ensureAccount(ctx, accountId);
  if (!info) return;
  const wasEnabled = Boolean(info.account.autoClaimEnabled);
  updateAccount(info.userId, info.accountId, { autoClaimEnabled: enabled });
  ctx.reply(`账号 ${info.displayName} 自动领券已${enabled ? "开启" : "关闭"}。`);
  if (enabled && !wasEnabled) {
    runImmediateAutoClaim(ctx, info).catch((error) => {
      console.error("Immediate auto-claim failed", error);
    });
  }
}

function handleAutoClaimReportSetting(ctx, type, enabled, accountId) {
  const info = ensureAccount(ctx, accountId);
  if (!info) return;

  const updates = {};
  if (type === "success") {
    updates.autoClaimReportSuccess = enabled;
  } else if (type === "failure") {
    updates.autoClaimReportFailure = enabled;
  } else {
    updates.autoClaimReportSuccess = enabled;
    updates.autoClaimReportFailure = enabled;
  }

  updateAccount(info.userId, info.accountId, updates);

  const label = type === "success" ? "成功汇报" : type === "failure" ? "失败汇报" : "结果汇报";
  ctx.reply(`账号 ${info.displayName} ${label}已${enabled ? "开启" : "关闭"}。`);
}

bot.command("calendar", async (ctx) => {
  const raw = (ctx.message.text || "").split(" ").slice(1).join(" ").trim();
  await handleCalendar(ctx, raw || null);
});

bot.command("coupons", async (ctx) => {
  await handleAvailableCoupons(ctx);
});

bot.command("claim", async (ctx) => {
  await handleClaimCoupons(ctx);
});

bot.command("mycoupons", async (ctx) => {
  await handleMyCoupons(ctx);
});

bot.command("tools", async (ctx) => {
  await handleToolsList(ctx);
});

bot.command("points", async (ctx) => {
  await handlePoints(ctx);
});

bot.command(["now", "timeinfo"], async (ctx) => {
  await handleNowTime(ctx);
});

bot.command("nutrition", async (ctx) => {
  await handleNutrition(ctx, getCommandPayload(ctx));
});

bot.command("mall", async (ctx) => {
  await handleMallCommand(ctx, getCommandPayload(ctx));
});

bot.command("deliveryaddrs", async (ctx) => {
  const args = parseCommandArgs(ctx);
  await handleDeliveryAddressesCommand(ctx, args[0] || "");
});

bot.command("deliveryadd", async (ctx) => {
  await handleDeliveryAddCommand(ctx, getCommandPayload(ctx));
});

bot.command("stores", async (ctx) => {
  await handleStoresCommand(ctx, getCommandPayload(ctx));
});

bot.command("storecoupons", async (ctx) => {
  await handleStoreCouponsCommand(ctx, parseCommandArgs(ctx));
});

bot.command("meals", async (ctx) => {
  await handleMealsCommand(ctx, parseCommandArgs(ctx));
});

bot.command("mealdetail", async (ctx) => {
  await handleMealDetailCommand(ctx, parseCommandArgs(ctx));
});

bot.command("price", async (ctx) => {
  await handlePriceCommand(ctx, getCommandPayload(ctx));
});

bot.command("order", async (ctx) => {
  await handleOrderCommand(ctx, getCommandPayload(ctx));
});

bot.command("tool", async (ctx) => {
  await handleRawToolCommand(ctx, getCommandPayload(ctx));
});

bot.command("autoclaim", (ctx) => {
  const args = parseCommandArgs(ctx);
  const setting = args[0] ? args[0].toLowerCase() : "";
  let accountId = args[1] ? args[1].trim() : "";
  if (!setting || (setting !== "on" && setting !== "off")) {
    ctx.reply("用法：/autoclaim on|off [账号名]");
    return;
  }
  if (accountId) {
    const accountCheck = validateAccountIdInput(accountId);
    if (!accountCheck.ok) {
      ctx.reply(accountCheck.message);
      return;
    }
    accountId = accountCheck.value;
  }

  handleAutoClaimSetting(ctx, setting === "on", accountId);
});

bot.command("autoclaimreport", (ctx) => {
  const args = parseCommandArgs(ctx);
  const first = args[0] ? args[0].toLowerCase() : "";
  const second = args[1] ? args[1].toLowerCase() : "";
  let type = "both";
  let setting = "";
  let accountId = "";

  if (first === "success" || first === "fail" || first === "failure") {
    type = first === "success" ? "success" : "failure";
    setting = second;
    accountId = args[2];
  } else {
    setting = first;
    accountId = args[1];
  }

  if (!setting || (setting !== "on" && setting !== "off")) {
    ctx.reply("用法：/autoclaimreport success|fail on|off [账号名]");
    return;
  }
  if (accountId) {
    const accountCheck = validateAccountIdInput(accountId.trim());
    if (!accountCheck.ok) {
      ctx.reply(accountCheck.message);
      return;
    }
    accountId = accountCheck.value;
  }

  handleAutoClaimReportSetting(ctx, type, setting === "on", accountId);
});

bot.action("menu_calendar", async (ctx) => {
  await ctx.answerCbQuery();
  await handleCalendar(ctx, null);
});

bot.action("menu_available", async (ctx) => {
  await ctx.answerCbQuery();
  await handleAvailableCoupons(ctx);
});

bot.action("menu_claim", async (ctx) => {
  await ctx.answerCbQuery();
  await handleClaimCoupons(ctx);
});

bot.action("menu_mycoupons", async (ctx) => {
  await ctx.answerCbQuery();
  await handleMyCoupons(ctx);
});

bot.action("menu_points", async (ctx) => {
  await ctx.answerCbQuery();
  await handlePoints(ctx);
});

bot.action("menu_now", async (ctx) => {
  await ctx.answerCbQuery();
  await handleNowTime(ctx);
});

bot.action("menu_status", async (ctx) => {
  await ctx.answerCbQuery();
  sendStatus(ctx);
});

bot.action("menu_stats", async (ctx) => {
  await ctx.answerCbQuery();
  sendStats(ctx);
});

bot.action("menu_autoclaim_on", async (ctx) => {
  await ctx.answerCbQuery();
  handleAutoClaimSetting(ctx, true);
});

bot.action("menu_autoclaim_off", async (ctx) => {
  await ctx.answerCbQuery();
  handleAutoClaimSetting(ctx, false);
});

bot.action("menu_report_success_on", async (ctx) => {
  await ctx.answerCbQuery();
  handleAutoClaimReportSetting(ctx, "success", true);
});

bot.action("menu_report_success_off", async (ctx) => {
  await ctx.answerCbQuery();
  handleAutoClaimReportSetting(ctx, "success", false);
});

bot.action("menu_report_fail_on", async (ctx) => {
  await ctx.answerCbQuery();
  handleAutoClaimReportSetting(ctx, "failure", true);
});

bot.action("menu_report_fail_off", async (ctx) => {
  await ctx.answerCbQuery();
  handleAutoClaimReportSetting(ctx, "failure", false);
});

bot.action("menu_accounts", async (ctx) => {
  await ctx.answerCbQuery();
  sendAccountHelp(ctx);
});

bot.action("menu_help", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply(buildHelpMessage(), { disable_web_page_preview: true });
});

bot.action("menu_token_help", async (ctx) => {
  await ctx.answerCbQuery();
  sendTokenGuide(ctx);
});

bot.action("menu_more", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply(buildAdvancedFeatureMessage(), { disable_web_page_preview: true });
});

const autoClaimInProgress = new Set();
let autoClaimSweepInProgress = false;
let mcpHealthCheckInProgress = false;

function hashString(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeMcpEndpoint() {
  const controller = new AbortController();
  let timeoutId = null;
  if (MCP_HEALTH_CHECK_TIMEOUT_MS > 0) {
    timeoutId = setTimeout(() => controller.abort(), MCP_HEALTH_CHECK_TIMEOUT_MS);
  }
  const startedAt = Date.now();
  try {
    const response = await fetch(MCP_URL, {
      method: "HEAD",
      signal: controller.signal
    });
    const latencyMs = Date.now() - startedAt;
    return {
      ok: response.status < 500,
      status: response.status,
      latencyMs
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (error && error.name === "AbortError") {
      const timeoutError = new Error("MCP health check timed out");
      timeoutError.code = "MCP_TIMEOUT";
      timeoutError.isTimeout = true;
      return { ok: false, status: 0, latencyMs, error: timeoutError };
    }
    return { ok: false, status: 0, latencyMs, error };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function runMcpHealthCheck() {
  if (mcpHealthCheckInProgress) {
    return;
  }
  mcpHealthCheckInProgress = true;
  try {
    const result = await probeMcpEndpoint();
    if (result.ok) {
      recordMcpSuccess(result.latencyMs, { statusCode: result.status });
      return;
    }
    const error =
      result.error ||
      new Error(result.status ? `MCP health check failed (${result.status})` : "MCP health check failed");
    recordMcpFailure(error, { statusCode: result.status, latencyMs: result.latencyMs });
  } catch (error) {
    recordMcpFailure(error, { statusCode: 0, latencyMs: 0 });
  } finally {
    mcpHealthCheckInProgress = false;
  }
}

function startMcpHealthMonitor() {
  if (!MCP_HEALTH_CHECK_INTERVAL_MS || MCP_HEALTH_CHECK_INTERVAL_MS <= 0) {
    console.log("MCP health monitor disabled: MCP_HEALTH_CHECK_INTERVAL_MS <= 0.");
    return;
  }
  console.log(`MCP health monitor started: every ${MCP_HEALTH_CHECK_INTERVAL_MS} ms.`);
  const trigger = () => {
    runMcpHealthCheck().catch((error) => {
      console.error("MCP health check failed", error);
    });
  };
  trigger();
  mcpHealthInterval = setInterval(trigger, MCP_HEALTH_CHECK_INTERVAL_MS);
}

function getDailyTargetMinute(userId, accountId, today) {
  const startMinutes = AUTO_CLAIM_HOUR * 60;
  const maxWindow = 24 * 60 - startMinutes;
  const windowMinutes = Math.max(1, Math.min(AUTO_CLAIM_SPREAD_MINUTES, maxWindow));
  const seed = `${userId}:${accountId}:${today}`;
  const offset = hashString(seed) % windowMinutes;
  return startMinutes + offset;
}

function shouldRunAutoClaim(userId, accountId, today, nowMinutes) {
  const targetMinute = getDailyTargetMinute(userId, accountId, today);
  return nowMinutes >= targetMinute;
}

function shouldRerunAutoClaim(account) {
  if (!AUTO_CLAIM_SPREAD_RERUN_MINUTES || AUTO_CLAIM_SPREAD_RERUN_MINUTES <= 0) {
    return false;
  }
  const lastRerunAt = account.lastRerunAt || 0;
  if (!lastRerunAt) {
    return true;
  }
  return Date.now() - lastRerunAt >= AUTO_CLAIM_SPREAD_RERUN_MINUTES * 60 * 1000;
}

function getActiveBurst() {
  const state = getGlobalState();
  const burst = state.burst;
  if (!burst || !burst.startAt || !burst.endAt) {
    if (burst) {
      updateGlobalState({ burst: null });
    }
    return null;
  }
  if (Date.now() >= burst.endAt) {
    updateGlobalState({ burst: null });
    return null;
  }
  return burst;
}

function getBurstTargetAt(userId, accountId, burst) {
  const windowMs = Math.max(1, burst.endAt - burst.startAt);
  const seed = `${burst.id}:${userId}:${accountId}`;
  const offsetMs = hashString(seed) % windowMs;
  return burst.startAt + offsetMs;
}

function shouldRunBurst(userId, accountId, burst, nowMs) {
  if (!burst || !burst.startAt || !burst.endAt) {
    return false;
  }
  if (nowMs < burst.startAt || nowMs > burst.endAt) {
    return false;
  }
  const targetAt = getBurstTargetAt(userId, accountId, burst);
  return nowMs >= targetAt;
}

function ensureBurstScheduler(enabled) {
  if (!enabled || !GLOBAL_BURST_CHECK_SECONDS || GLOBAL_BURST_CHECK_SECONDS <= 0) {
    if (burstInterval) {
      clearInterval(burstInterval);
      burstInterval = null;
      logAutoClaim("Burst scheduler stopped.");
    }
    return;
  }
  if (burstInterval) {
    return;
  }
  logAutoClaim(`Burst scheduler started: every ${GLOBAL_BURST_CHECK_SECONDS} seconds.`);
  burstInterval = setInterval(() => {
    runAutoClaimSweep().catch((error) => {
      console.error("Burst auto-claim sweep failed", error);
      notifyAdmins(`Burst 自动领券调度异常：${sanitizeInlineText(getErrorMessage(error), { maxLength: 400 })}`);
    });
  }, GLOBAL_BURST_CHECK_SECONDS * 1000);
}

async function runAutoClaimSweep() {
  if (autoClaimSweepInProgress) {
    logAutoClaimDebug("Sweep skipped: already in progress.");
    return;
  }
  autoClaimSweepInProgress = true;

  const sweepStartedAt = Date.now();
  let sweepEligible = 0;
  let sweepProcessed = 0;
  let sweepReason = "daily";
  let sweepError = "";

  try {
    const users = allUsers();
    const nowMs = Date.now();
    const burst = getActiveBurst();
    ensureBurstScheduler(Boolean(burst));
    sweepReason = burst ? "burst" : "daily";
    const today = getLocalDate(AUTO_CLAIM_TIMEZONE);
    const nowMinutes = getMinutesSinceMidnight(AUTO_CLAIM_TIMEZONE);
    if (!Number.isFinite(nowMinutes)) {
      sweepError = "invalid_time";
      return;
    }

    const tasks = [];
    const skipStats = {
      missingToken: 0,
      autoClaimDisabled: 0,
      burstAlreadyRan: 0,
      burstNotReady: 0,
      dailyAlreadyRan: 0,
      dailyNotDue: 0,
      inProgress: 0
    };
    let nextDailyTarget = null;
    let nextBurstTarget = null;

    logAutoClaimDebug(
      `Sweep start: reason=${sweepReason}, now=${new Date(nowMs).toISOString()}, today=${today}, now=${formatMinutesSinceMidnight(nowMinutes)}`
    );

    for (const [userId, user] of Object.entries(users)) {
      const accounts = user.accounts || {};
      for (const [accountId, account] of Object.entries(accounts)) {
        if (!account || !account.token) {
          skipStats.missingToken += 1;
          continue;
        }
        if (!account.autoClaimEnabled) {
          skipStats.autoClaimDisabled += 1;
          continue;
        }

        let targetMinute = null;
        let targetAt = null;

        if (burst) {
          if (account.lastBurstId === burst.id) {
            skipStats.burstAlreadyRan += 1;
            continue;
          }
          targetAt = getBurstTargetAt(userId, accountId, burst);
          if (nowMs < burst.startAt || nowMs > burst.endAt || nowMs < targetAt) {
            skipStats.burstNotReady += 1;
            if (Number.isFinite(targetAt) && (nextBurstTarget === null || targetAt < nextBurstTarget)) {
              nextBurstTarget = targetAt;
            }
            continue;
          }
        } else {
          const ranToday = account.lastAutoClaimDate === today;
          if (ranToday && !shouldRerunAutoClaim(account)) {
            skipStats.dailyAlreadyRan += 1;
            continue;
          }
          targetMinute = getDailyTargetMinute(userId, accountId, today);
          if (nowMinutes < targetMinute) {
            skipStats.dailyNotDue += 1;
            if (nextDailyTarget === null || targetMinute < nextDailyTarget) {
              nextDailyTarget = targetMinute;
            }
            continue;
          }
        }

        const taskKey = `${userId}:${accountId}`;
        if (autoClaimInProgress.has(taskKey)) {
          skipStats.inProgress += 1;
          continue;
        }

        const displayName = getAccountDisplayName(accountId, account);
        tasks.push({
          userId,
          accountId,
          account,
          displayName,
          reason: burst ? "burst" : "daily",
          targetMinute,
          targetAt
        });
      }
    }

    sweepEligible = tasks.length;
    logAutoClaimDebug(
      `Sweep eligibility: eligible=${sweepEligible}, skipped=${formatSkipStats(skipStats)}, nextDaily=${nextDailyTarget === null ? "n/a" : formatMinutesSinceMidnight(nextDailyTarget)}, nextBurst=${nextBurstTarget === null ? "n/a" : new Date(nextBurstTarget).toISOString()}`
    );
    if (tasks.length === 0) {
      return;
    }

    if (burst) {
      tasks.sort((a, b) => (a.targetAt || 0) - (b.targetAt || 0));
    } else {
      tasks.sort((a, b) => (a.targetMinute || 0) - (b.targetMinute || 0));
    }

    const maxPerSweep = AUTO_CLAIM_MAX_PER_SWEEP > 0 ? AUTO_CLAIM_MAX_PER_SWEEP : tasks.length;
    let remaining = maxPerSweep;
    let nextAllowedAt = getGlobalState().lastAutoClaimRequestAt || 0;

    for (const task of tasks) {
      if (remaining <= 0) {
        break;
      }

      if (AUTO_CLAIM_REQUEST_GAP_MS > 0) {
        const waitMs = nextAllowedAt - Date.now();
        if (waitMs > 0) {
          await sleep(waitMs);
        }
      }

      const taskKey = `${task.userId}:${task.accountId}`;
      autoClaimInProgress.add(taskKey);
      const requestAt = Date.now();
      if (AUTO_CLAIM_REQUEST_GAP_MS > 0) {
        nextAllowedAt = requestAt + AUTO_CLAIM_REQUEST_GAP_MS;
      }
      updateGlobalState({ lastAutoClaimRequestAt: requestAt });

      try {
        const result = await callKnownToolWithToken(task.account.token, "claimCoupons", {});
        const rawText = getToolRawText(result);
        const normalized = normalizeToolText(rawText);
        const simplified = simplifyClaimResultText(normalized);
        const claimed = hasClaimedCoupons(normalized);
        const claimedCount = getClaimedCouponCount(normalized);
        recordClaimedCoupons(normalized, {
          userId: task.userId,
          accountId: task.accountId,
          reason: task.reason
        });
        incrementUserStats(task.userId, { autoClaimRuns: 1, couponsClaimed: claimedCount });

        const safeDisplayName = safeHtmlText(task.displayName, { maxLength: 60 });
        const message = [
          `自动领券结果（${today}）- 账号：${safeDisplayName}`,
          "",
          formatTelegramHtml(stripImagesFromText(simplified))
        ].join("\n");

        if (task.account.autoClaimReportSuccess !== false && claimed) {
          await sendLongMessageToUser(task.userId, message);
        }
        logAutoClaimDebug(
          `Auto-claim success: account=${task.displayName}, claimed=${claimed ? claimedCount : 0}`
        );
        updateAccount(task.userId, task.accountId, {
          lastAutoClaimDate: today,
          lastAutoClaimAt: getLocalDateTime(AUTO_CLAIM_TIMEZONE),
          lastAutoClaimStatus: "成功",
          lastBurstId: task.reason === "burst" ? burst.id : task.account.lastBurstId,
          lastRerunAt: Date.now()
        });
      } catch (error) {
        const safeMessage = formatMcpErrorMessage(error);
        const authFailure = isAuthFailureMessage(safeMessage);
        const shouldNotifyAuthFailure =
          authFailure && task.account.lastAuthFailureNotifiedDate !== today;
        const accountUpdates = {
          lastAutoClaimDate: today,
          lastAutoClaimAt: getLocalDateTime(AUTO_CLAIM_TIMEZONE),
          lastAutoClaimStatus: `失败：${safeMessage}`,
          lastBurstId: task.reason === "burst" ? burst.id : task.account.lastBurstId,
          lastRerunAt: Date.now()
        };
        if (shouldNotifyAuthFailure) {
          accountUpdates.lastAuthFailureNotifiedDate = today;
        }
        updateAccount(task.userId, task.accountId, {
          ...accountUpdates
        });

        sweepError = safeMessage || sweepError;
        logAutoClaim(`Auto-claim failed: account=${task.displayName}, error=${safeMessage}`);
        await notifyAdmins(
          `自动领券失败（${today}）- Token：${maskToken(task.account.token)}\n原因：${safeMessage}`
        );

        if (authFailure) {
          if (shouldNotifyAuthFailure) {
            try {
              await sendLongMessageToUser(
                task.userId,
                [
                  `自动领券失败（${today}）- 账号：${safeHtmlText(task.displayName, { maxLength: 60 })}`,
                  "原因：鉴权失败，Token 已失效，请更新 Token。",
                  "可使用 /token 或 /account add 重新设置。"
                ].join("\n")
              );
            } catch (sendError) {
              console.error("Failed to send auth-failure notice to user", sendError);
            }
          }
        } else if (task.account.autoClaimReportFailure !== false) {
          try {
            await sendLongMessageToUser(
              task.userId,
              `自动领券失败（${today}）- 账号：${safeHtmlText(task.displayName, { maxLength: 60 })}\n${safeHtmlText(
                safeMessage,
                { maxLength: 400 }
              )}`
            );
          } catch (sendError) {
            console.error("Failed to send auto-claim error to user", sendError);
          }
        }
      } finally {
        autoClaimInProgress.delete(taskKey);
        remaining -= 1;
        sweepProcessed += 1;
      }
    }
  } catch (error) {
    sweepError = sanitizeInlineText(getErrorMessage(error), { maxLength: 400 }) || "未知错误";
    throw error;
  } finally {
    const finishedAt = Date.now();
    updateGlobalState({
      lastSweepStartedAt: sweepStartedAt,
      lastSweepFinishedAt: finishedAt,
      lastSweepDurationMs: finishedAt - sweepStartedAt,
      lastSweepEligible: sweepEligible,
      lastSweepProcessed: sweepProcessed,
      lastSweepReason: sweepReason,
      lastSweepError: sweepError
    });
    autoClaimSweepInProgress = false;
    logAutoClaim(
      `Sweep finished: reason=${sweepReason}, eligible=${sweepEligible}, processed=${sweepProcessed}, durationMs=${finishedAt - sweepStartedAt}, error=${sweepError || "none"}`
    );
  }
}

function startAutoClaimScheduler() {
  if (!AUTO_CLAIM_CHECK_MINUTES || AUTO_CLAIM_CHECK_MINUTES <= 0) {
    logAutoClaim("Scheduler disabled: AUTO_CLAIM_CHECK_MINUTES <= 0.");
    return;
  }
  logAutoClaim(`Scheduler started: every ${AUTO_CLAIM_CHECK_MINUTES} minutes.`);
  const trigger = () => {
    logAutoClaimDebug("Scheduler trigger fired.");
    runAutoClaimSweep().catch((error) => {
      console.error("Auto-claim sweep failed", error);
      notifyAdmins(`自动领券调度异常：${sanitizeInlineText(getErrorMessage(error), { maxLength: 400 })}`);
    });
  };
  trigger();
  autoClaimInterval = setInterval(trigger, AUTO_CLAIM_CHECK_MINUTES * 60 * 1000);
}

function startSweepWatchdog() {
  if (!SWEEP_WATCHDOG_SECONDS || SWEEP_WATCHDOG_SECONDS <= 0) {
    logAutoClaim("Sweep watchdog disabled: SWEEP_WATCHDOG_SECONDS <= 0.");
    return;
  }
  logAutoClaim(`Sweep watchdog started: every ${SWEEP_WATCHDOG_SECONDS} seconds.`);
  const check = () => {
    const today = getLocalDate(AUTO_CLAIM_TIMEZONE);
    getAdminSummaryBaseline(today);
    const state = getGlobalState();
    const lastFinished = state.lastSweepFinishedAt || state.lastSweepStartedAt || 0;
    const staleAfterMs =
      Math.max(AUTO_CLAIM_CHECK_MINUTES || 1, 1) * 60 * 1000 * Math.max(SWEEP_STALE_MULTIPLIER || 1, 1);
    const now = Date.now();
    const isStale = !autoClaimSweepInProgress && now - lastFinished > staleAfterMs;
    if (isStale) {
      console.warn("Sweep watchdog: detected stale scheduler, triggering sweep now.");
      logAutoClaim("Sweep watchdog triggered: scheduler stale, running sweep.");
      runAutoClaimSweep().catch((error) => {
        console.error("Sweep watchdog failed to trigger sweep", error);
        notifyAdmins(`Sweep watchdog异常：${sanitizeInlineText(getErrorMessage(error), { maxLength: 400 })}`);
      });
    }
  };
  check();
  watchdogInterval = setInterval(check, SWEEP_WATCHDOG_SECONDS * 1000);
}

function shutdown(signal) {
  if (autoClaimInterval) {
    clearInterval(autoClaimInterval);
    autoClaimInterval = null;
  }
  if (burstInterval) {
    clearInterval(burstInterval);
    burstInterval = null;
  }
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
  if (mcpHealthInterval) {
    clearInterval(mcpHealthInterval);
    mcpHealthInterval = null;
  }
  bot.stop(signal);
}

startMcpHealthMonitor();
startAutoClaimScheduler();
startSweepWatchdog();

bot.launch()
  .then(() => {
    console.log("Bot started.");
    bot.telegram.setMyCommands([
      { command: "menu", description: "打开按钮菜单" },
      { command: "token", description: "设置 MCP Token（默认账号）" },
      { command: "account", description: "账号管理" },
      { command: "calendar", description: "活动日历查询" },
      { command: "coupons", description: "可领优惠券列表" },
      { command: "claim", description: "一键领券" },
      { command: "mycoupons", description: "我的优惠券" },
      { command: "autoclaim", description: "每日自动领券开关" },
      { command: "autoclaimreport", description: "自动领券汇报开关(成/败)" },
      { command: "status", description: "查看账号状态" },
      { command: "stats", description: "查看我的领券统计" },
      { command: "cleartoken", description: "清空全部账号" },
      { command: "admin", description: "管理员统计" }
    ]).catch((error) => {
      console.error("Failed to set bot commands", error);
    });
  })
  .catch((error) => {
    console.error("Bot failed to start.", error);
    process.exit(1);
  });

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
