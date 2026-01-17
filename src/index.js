require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const { MCPClient } = require("./mcpClient");
const { TTLCache } = require("./cache");
const { getUser, getGlobalState, updateGlobalState, upsertUser, deleteUser, allUsers } = require("./storage");
const { getLocalDate, getMinutesSinceMidnight, getLocalDateTime } = require("./time");
const { createTelegraphPage } = require("./telegraph");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in environment.");
  process.exit(1);
}

const MCP_URL = process.env.MCD_MCP_URL || "https://mcp.mcd.cn/mcp-servers/mcd-mcp";
const MCP_PROTOCOL_VERSION = process.env.MCP_PROTOCOL_VERSION || "2025-06-18";

const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 300);
const CACHEABLE_TOOLS = new Set(
  (process.env.CACHEABLE_TOOLS || "campaign-calender,available-coupons")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

const AUTO_CLAIM_CHECK_MINUTES = Number(process.env.AUTO_CLAIM_CHECK_MINUTES || 10);
const AUTO_CLAIM_HOUR = Number(process.env.AUTO_CLAIM_HOUR || 9);
const AUTO_CLAIM_TIMEZONE = process.env.AUTO_CLAIM_TIMEZONE || "Asia/Shanghai";
const AUTO_CLAIM_SPREAD_MINUTES = Number(process.env.AUTO_CLAIM_SPREAD_MINUTES || 600);
const AUTO_CLAIM_MAX_PER_SWEEP = Number(process.env.AUTO_CLAIM_MAX_PER_SWEEP || 10);
const AUTO_CLAIM_REQUEST_GAP_MS = Number(process.env.AUTO_CLAIM_REQUEST_GAP_MS || 1500);
const GLOBAL_BURST_WINDOW_MINUTES = Number(process.env.GLOBAL_BURST_WINDOW_MINUTES || 30);
const GLOBAL_BURST_CHECK_SECONDS = Number(process.env.GLOBAL_BURST_CHECK_SECONDS || 60);
const ADMIN_TELEGRAM_IDS = new Set(
  (process.env.ADMIN_TELEGRAM_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

const cache = new TTLCache(CACHE_TTL_SECONDS * 1000);
const telegraphCache = new TTLCache(CACHE_TTL_SECONDS * 1000);
const bot = new Telegraf(BOT_TOKEN);
let autoClaimInterval = null;
let burstInterval = null;

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
  [Markup.button.callback("账号状态", "menu_status"), Markup.button.callback("账号管理", "menu_accounts")],
  [Markup.button.callback("开启自动领券", "menu_autoclaim_on"), Markup.button.callback("关闭自动领券", "menu_autoclaim_off")],
  [Markup.button.callback("开启成功汇报", "menu_report_success_on"), Markup.button.callback("关闭成功汇报", "menu_report_success_off")],
  [Markup.button.callback("开启失败汇报", "menu_report_fail_on"), Markup.button.callback("关闭失败汇报", "menu_report_fail_off")],
  [Markup.button.callback("Token 获取指引", "menu_token_help")]
]);

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
  if (account && account.label) {
    return account.label;
  }
  if (accountId === "default") {
    return "默认账号";
  }
  return accountId;
}

function buildAccountListText(user) {
  const entries = user && user.accounts ? Object.entries(user.accounts) : [];
  if (entries.length === 0) {
    return "暂无账号，请先使用 /account add 添加账号。";
  }
  const lines = entries.map(([accountId, account]) => {
    const name = getAccountDisplayName(accountId, account);
    const active = user.activeAccountId === accountId ? "✅" : "▫️";
    const autoClaim = account.autoClaimEnabled ? "开" : "关";
    const reportSuccess = account.autoClaimReportSuccess ? "开" : "关";
    const reportFail = account.autoClaimReportFailure ? "开" : "关";
    const nameWithId = name === accountId ? name : `${name}（${accountId}）`;
    return `${active} ${nameWithId} ｜自动领券:${autoClaim} ｜汇报(成):${reportSuccess} ｜汇报(败):${reportFail}`;
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
  const existing = accounts[accountId] || {};
  const updated = {
    ...existing,
    token,
    label: label || existing.label || accountId,
    autoClaimEnabled: typeof existing.autoClaimEnabled === "boolean" ? existing.autoClaimEnabled : false,
    autoClaimReportSuccess: typeof existing.autoClaimReportSuccess === "boolean" ? existing.autoClaimReportSuccess : true,
    autoClaimReportFailure: typeof existing.autoClaimReportFailure === "boolean" ? existing.autoClaimReportFailure : true
  };

  accounts[accountId] = updated;
  const activeAccountId = user.activeAccountId || accountId;
  upsertUser(userId, { accounts, activeAccountId });
  return existing && existing.token;
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

function getToolCacheKey(toolName, args) {
  return `${toolName}:${JSON.stringify(args || {})}`;
}

async function callToolWithToken(token, toolName, args) {
  if (!token) {
    throw new Error("缺少 MCP Token，请先设置。");
  }

  const cacheKey = getToolCacheKey(toolName, args);
  const useCache = CACHEABLE_TOOLS.has(toolName);
  if (useCache) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const client = new MCPClient({
    baseUrl: MCP_URL,
    token,
    protocolVersion: MCP_PROTOCOL_VERSION
  });

  const result = await client.callTool(toolName, args || {});
  if (useCache) {
    cache.set(cacheKey, result);
  }
  return result;
}

bot.catch((error, ctx) => {
  console.error("Bot error", error);
  if (ctx && ctx.reply) {
    ctx.reply("出错了，请稍后再试。");
  }
});

bot.start((ctx) => {
  const message = [
    "欢迎使用麦麦 MCP 机器人。",
    "",
    TOKEN_GUIDE_MESSAGE,
    "",
    "在这里发送：",
    "/token 你的MCP_TOKEN（首次会创建默认账号）",
    "",
    "指令：",
    "/calendar [YYYY-MM-DD] - 活动日历查询",
    "/coupons - 麦麦省可领取券列表",
    "/claim - 麦麦省一键领券",
    "/mycoupons - 我的优惠券",
    "/autoclaim on|off [账号名] - 每日自动领券",
    "/autoclaimreport success|fail on|off [账号名] - 自动领券结果汇报",
    "/account add 名称 Token - 添加账号",
    "/account use 名称 - 切换账号",
    "/account list - 查看账号",
    "/account del 名称 - 删除账号",
    "/status - 查看账号状态",
    "/stats - 我的领券统计",
    "/cleartoken - 清空全部账号"
  ].join("\n");
  ctx.reply(message, { disable_web_page_preview: true, ...MAIN_MENU });
});

bot.command("menu", (ctx) => {
  ctx.reply("请选择功能：", { disable_web_page_preview: true, ...MAIN_MENU });
});

function sendAccountHelp(ctx) {
  const userId = String(ctx.from.id);
  const user = getUser(userId);
  const listText = user ? buildAccountListText(user) : "暂无账号，请先使用 /account add 添加账号。";
  ctx.reply(`${ACCOUNT_HELP_MESSAGE}\n\n${listText}`);
}

function handleAccountCommand(ctx, args) {
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
    const accountId = args[1];
    const token = args.slice(2).join(" ").trim();
    if (!accountId || !token) {
      ctx.reply("用法：/account add 名称 Token");
      return;
    }
    const existed = addOrUpdateAccount(userId, accountId, token, accountId);
    ctx.reply(existed ? `账号 ${accountId} 已更新。` : `账号 ${accountId} 已添加。`);
    return;
  }

  if (sub === "use") {
    const accountId = args[1];
    if (!accountId) {
      ctx.reply("用法：/account use 名称");
      return;
    }
    const user = getUser(userId);
    if (!user || !user.accounts || !user.accounts[accountId]) {
      ctx.reply(`账号不存在：${accountId}`);
      return;
    }
    upsertUser(userId, { activeAccountId: accountId });
    ctx.reply(`已切换到账号：${getAccountDisplayName(accountId, user.accounts[accountId])}`);
    return;
  }

  if (sub === "del" || sub === "delete" || sub === "rm") {
    const accountId = args[1];
    if (!accountId) {
      ctx.reply("用法：/account del 名称");
      return;
    }
    const removed = removeAccount(userId, accountId);
    ctx.reply(removed ? `账号 ${accountId} 已删除。` : `账号不存在：${accountId}`);
    return;
  }

  ctx.reply("未知子命令。\n" + ACCOUNT_HELP_MESSAGE);
}

bot.command(["token", "settoken"], (ctx) => {
  const args = parseCommandArgs(ctx);
  const sub = args[0] ? args[0].toLowerCase() : "";
  if (["add", "use", "list", "del", "delete", "rm", "help"].includes(sub)) {
    handleAccountCommand(ctx, args);
    return;
  }

  const token = args.join(" ").trim();
  if (!token) {
    ctx.reply("用法：/token 你的MCP_TOKEN");
    return;
  }

  const userId = String(ctx.from.id);
  const user = getUser(userId);
  const accountId = user && user.activeAccountId ? user.activeAccountId : "default";
  const existed = addOrUpdateAccount(userId, accountId, token, accountId === "default" ? "默认账号" : accountId);
  ctx.reply(existed ? "Token 已更新，可以继续使用。" : "Token 已保存，可以开始使用指令了。");
});

bot.command(["account", "accounts"], (ctx) => {
  const args = parseCommandArgs(ctx);
  handleAccountCommand(ctx, args);
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
  const listText = buildAccountListText(user);

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

bot.command("stats", (ctx) => {
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
});

bot.command("admin", (ctx) => {
  if (!ensureAdmin(ctx)) {
    return;
  }
  const args = parseCommandArgs(ctx);
  const sub = args[0] ? args[0].toLowerCase() : "users";

  if (sub === "users" || sub === "stats" || sub === "count") {
    const users = allUsers();
    const userCount = Object.keys(users).length;
    let accountCount = 0;
    let autoClaimEnabledCount = 0;
    let totalAutoClaimRuns = 0;
    let totalManualClaimRuns = 0;
    let totalCouponsClaimed = 0;
    for (const user of Object.values(users)) {
      const accounts = user.accounts || {};
      const entries = Object.values(accounts);
      accountCount += entries.length;
      autoClaimEnabledCount += entries.filter((account) => account && account.autoClaimEnabled).length;
      const stats = user.stats || {};
      totalAutoClaimRuns += Number(stats.autoClaimRuns) || 0;
      totalManualClaimRuns += Number(stats.manualClaimRuns) || 0;
      totalCouponsClaimed += Number(stats.couponsClaimed) || 0;
    }
    ctx.reply(
      [
        "管理员统计：",
        `用户数：${userCount}`,
        `账号数：${accountCount}`,
        `已开启自动领券账号数：${autoClaimEnabledCount}`,
        `自动领券次数总计：${totalAutoClaimRuns}`,
        `手动领券次数总计：${totalManualClaimRuns}`,
        `累计领取优惠券总计：${totalCouponsClaimed}`
      ].join("\n")
    );
    return;
  }

  ctx.reply("用法：/admin users");
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
        const message = `${fallbackPrefix}：<a href="${escapeHtml(cached)}">点击查看</a>`;
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
    const message = `${fallbackPrefix}：<a href="${escapeHtml(url)}">点击查看</a>`;
    await ctx.reply(message, {
      disable_web_page_preview: false,
      parse_mode: "HTML"
    });
  } catch (error) {
    const warning = `${fallbackPrefix} Telegraph 生成失败，已改用文本展示：${error.message}`;
    await sendLongMessage(ctx, warning + "\n\n" + formatTelegramHtml(stripImagesFromText(rawText)));
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
    const result = await callToolWithToken(info.account.token, "campaign-calender", args);
    const rawText = getToolRawText(result);
    const cleaned = normalizeCalendarText(rawText);
    const title = specifiedDate ? `麦当劳活动日历（${specifiedDate}）` : "麦当劳活动日历";
    const cacheKey = getToolCacheKey("campaign-calender", args);
    await sendTelegraphArticle(ctx, title, cleaned, "活动日历已生成", cacheKey);
  } catch (error) {
    ctx.reply(`活动日历查询失败：${error.message}`);
  }
}

async function handleAvailableCoupons(ctx) {
  const info = ensureAccount(ctx);
  if (!info) return;

  try {
    const result = await callToolWithToken(info.account.token, "available-coupons", {});
    const rawText = getToolRawText(result);
    const cleaned = normalizeCouponListText(rawText);
    const cacheKey = getToolCacheKey("available-coupons", {});
    await sendTelegraphArticle(ctx, "麦麦省优惠券列表", cleaned, "优惠券列表已生成", cacheKey);
  } catch (error) {
    ctx.reply(`优惠券列表查询失败：${error.message}`);
  }
}

async function handleClaimCoupons(ctx) {
  const info = ensureAccount(ctx);
  if (!info) return;

  try {
    const result = await callToolWithToken(info.account.token, "auto-bind-coupons", {});
    const rawText = getToolRawText(result);
    const normalized = normalizeToolText(rawText);
    const simplified = simplifyClaimResultText(normalized);
    const claimedCount = getClaimedCouponCount(normalized);
    recordClaimedCoupons(normalized, { userId: info.userId, accountId: info.accountId, reason: "manual" });
    incrementUserStats(info.userId, { manualClaimRuns: 1, couponsClaimed: claimedCount });
    const text = formatTelegramHtml(stripImagesFromText(simplified));
    await sendLongMessage(ctx, text || "未返回数据。");
  } catch (error) {
    ctx.reply(`一键领券失败：${error.message}`);
  }
}

async function handleMyCoupons(ctx) {
  const info = ensureAccount(ctx);
  if (!info) return;

  try {
    const result = await callToolWithToken(info.account.token, "my-coupons", {});
    const text = formatToolResult(result);
    await sendLongMessage(ctx, text || "未返回数据。");
  } catch (error) {
    ctx.reply(`我的优惠券查询失败：${error.message}`);
  }
}

function handleAutoClaimSetting(ctx, enabled, accountId) {
  const info = ensureAccount(ctx, accountId);
  if (!info) return;
  updateAccount(info.userId, info.accountId, { autoClaimEnabled: enabled });
  ctx.reply(`账号 ${info.displayName} 自动领券已${enabled ? "开启" : "关闭"}。`);
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

bot.command("autoclaim", (ctx) => {
  const args = parseCommandArgs(ctx);
  const setting = args[0] ? args[0].toLowerCase() : "";
  const accountId = args[1];
  if (!setting || (setting !== "on" && setting !== "off")) {
    ctx.reply("用法：/autoclaim on|off [账号名]");
    return;
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

bot.action("menu_status", async (ctx) => {
  await ctx.answerCbQuery();
  sendStatus(ctx);
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

bot.action("menu_token_help", async (ctx) => {
  await ctx.answerCbQuery();
  sendTokenGuide(ctx);
});

const autoClaimInProgress = new Set();
let autoClaimSweepInProgress = false;

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
    }
    return;
  }
  if (burstInterval) {
    return;
  }
  burstInterval = setInterval(() => {
    runAutoClaimSweep().catch((error) => {
      console.error("Burst auto-claim sweep failed", error);
    });
  }, GLOBAL_BURST_CHECK_SECONDS * 1000);
}

async function runAutoClaimSweep() {
  if (autoClaimSweepInProgress) {
    return;
  }
  autoClaimSweepInProgress = true;

  try {
    const users = allUsers();
    const nowMs = Date.now();
    const burst = getActiveBurst();
    ensureBurstScheduler(Boolean(burst));
    const today = getLocalDate(AUTO_CLAIM_TIMEZONE);
    const nowMinutes = getMinutesSinceMidnight(AUTO_CLAIM_TIMEZONE);
    if (!Number.isFinite(nowMinutes)) {
      return;
    }

    const tasks = [];

    for (const [userId, user] of Object.entries(users)) {
      const accounts = user.accounts || {};
      for (const [accountId, account] of Object.entries(accounts)) {
        if (!account || !account.token) {
          continue;
        }
        if (!account.autoClaimEnabled) {
          continue;
        }

        if (burst) {
          if (account.lastBurstId === burst.id) {
            continue;
          }
          if (!shouldRunBurst(userId, accountId, burst, nowMs)) {
            continue;
          }
        } else {
          if (account.lastAutoClaimDate === today) {
            continue;
          }
          if (!shouldRunAutoClaim(userId, accountId, today, nowMinutes)) {
            continue;
          }
        }

        const taskKey = `${userId}:${accountId}`;
        if (autoClaimInProgress.has(taskKey)) {
          continue;
        }

        const displayName = getAccountDisplayName(accountId, account);
        const targetMinute = burst ? null : getDailyTargetMinute(userId, accountId, today);
        const targetAt = burst ? getBurstTargetAt(userId, accountId, burst) : null;
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
        const result = await callToolWithToken(task.account.token, "auto-bind-coupons", {});
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

        const message = [
          `自动领券结果（${today}）- 账号：${task.displayName}`,
          "",
          formatTelegramHtml(stripImagesFromText(simplified))
        ].join("\n");

        if (task.account.autoClaimReportSuccess !== false && claimed) {
          await sendLongMessageToUser(task.userId, message);
        }
        updateAccount(task.userId, task.accountId, {
          lastAutoClaimDate: today,
          lastAutoClaimAt: getLocalDateTime(AUTO_CLAIM_TIMEZONE),
          lastAutoClaimStatus: "成功",
          lastBurstId: task.reason === "burst" ? burst.id : task.account.lastBurstId
        });
      } catch (error) {
        updateAccount(task.userId, task.accountId, {
          lastAutoClaimDate: today,
          lastAutoClaimAt: getLocalDateTime(AUTO_CLAIM_TIMEZONE),
          lastAutoClaimStatus: `失败：${error.message}`,
          lastBurstId: task.reason === "burst" ? burst.id : task.account.lastBurstId
        });

        if (task.account.autoClaimReportFailure !== false) {
          try {
            await sendLongMessageToUser(
              task.userId,
              `自动领券失败（${today}）- 账号：${task.displayName}\n${error.message}`
            );
          } catch (sendError) {
            console.error("Failed to send auto-claim error to user", sendError);
          }
        }
      } finally {
        autoClaimInProgress.delete(taskKey);
        remaining -= 1;
      }
    }
  } finally {
    autoClaimSweepInProgress = false;
  }
}

function startAutoClaimScheduler() {
  if (!AUTO_CLAIM_CHECK_MINUTES || AUTO_CLAIM_CHECK_MINUTES <= 0) {
    return;
  }
  autoClaimInterval = setInterval(() => {
    runAutoClaimSweep().catch((error) => {
      console.error("Auto-claim sweep failed", error);
    });
  }, AUTO_CLAIM_CHECK_MINUTES * 60 * 1000);
}

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
    runAutoClaimSweep().catch((error) => {
      console.error("Initial auto-claim sweep failed", error);
    });
    startAutoClaimScheduler();
  })
  .catch((error) => {
    console.error("Bot failed to start.", error);
    process.exit(1);
  });

function shutdown(signal) {
  if (autoClaimInterval) {
    clearInterval(autoClaimInterval);
    autoClaimInterval = null;
  }
  if (burstInterval) {
    clearInterval(burstInterval);
    burstInterval = null;
  }
  bot.stop(signal);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
