require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const { MCPClient } = require("./mcpClient");
const { TTLCache } = require("./cache");
const { getUser, upsertUser, deleteUser, allUsers } = require("./storage");
const { getLocalDate, getLocalHour, getLocalDateTime } = require("./time");
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
  (process.env.CACHEABLE_TOOLS || "campaign-calender,now-time-info")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

const AUTO_CLAIM_CHECK_MINUTES = Number(process.env.AUTO_CLAIM_CHECK_MINUTES || 10);
const AUTO_CLAIM_HOUR = Number(process.env.AUTO_CLAIM_HOUR || 9);
const AUTO_CLAIM_TIMEZONE = process.env.AUTO_CLAIM_TIMEZONE || "Asia/Shanghai";

const cache = new TTLCache(CACHE_TTL_SECONDS * 1000);
const bot = new Telegraf(BOT_TOKEN);
let autoClaimInterval = null;

const TOKEN_GUIDE_MESSAGE = [
  "先获取麦当劳 MCP Token：",
  "1) 打开 https://open.mcd.cn/mcp/doc",
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
  "提示：名称不要包含空格"
].join("\n");

const MAIN_MENU = Markup.inlineKeyboard([
  [Markup.button.callback("活动日历（本月）", "menu_calendar"), Markup.button.callback("当前时间", "menu_time")],
  [Markup.button.callback("可领优惠券", "menu_available"), Markup.button.callback("一键领券", "menu_claim")],
  [Markup.button.callback("我的优惠券", "menu_mycoupons"), Markup.button.callback("账号状态", "menu_status")],
  [Markup.button.callback("开启自动领券", "menu_autoclaim_on"), Markup.button.callback("关闭自动领券", "menu_autoclaim_off")],
  [Markup.button.callback("账号管理", "menu_accounts"), Markup.button.callback("Token 获取指引", "menu_token_help")]
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

  return rawText.replace(/\\\\\s*$/gm, "");
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
  const rawText = getToolRawText(result);
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
    const report = account.autoClaimReport ? "开" : "关";
    const nameWithId = name === accountId ? name : `${name}（${accountId}）`;
    return `${active} ${nameWithId} ｜自动领券:${autoClaim} ｜汇报:${report}`;
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
    autoClaimReport: typeof existing.autoClaimReport === "boolean" ? existing.autoClaimReport : true
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

async function callToolWithToken(token, toolName, args) {
  if (!token) {
    throw new Error("缺少 MCP Token，请先设置。");
  }

  const cacheKey = `${toolName}:${JSON.stringify(args || {})}`;
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
    "/time - 当前时间信息",
    "/autoclaim on|off [账号名] - 每日自动领券",
    "/autoclaimreport on|off [账号名] - 自动领券结果汇报",
    "/account add 名称 Token - 添加账号",
    "/account use 名称 - 切换账号",
    "/account list - 查看账号",
    "/account del 名称 - 删除账号",
    "/status - 查看账号状态",
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
  const reportStatus = activeAccount && activeAccount.autoClaimReport ? "已开启" : "已关闭";
  const lastRun = activeAccount && activeAccount.lastAutoClaimAt ? activeAccount.lastAutoClaimAt : "从未执行";
  const listText = buildAccountListText(user);

  ctx.reply(
    [
      `当前账号：${activeName}`,
      `自动领券：${autoClaimStatus}`,
      `结果汇报：${reportStatus}`,
      `上次自动领券：${lastRun}`,
      "",
      "账号列表：",
      listText
    ].join("\n")
  );
}

bot.command("status", sendStatus);

function sendTokenGuide(ctx) {
  ctx.reply(TOKEN_GUIDE_MESSAGE, { disable_web_page_preview: true });
}

async function sendTelegraphArticle(ctx, title, rawText, fallbackPrefix) {
  const nodes = buildTelegraphNodes(rawText);
  if (!nodes.length) {
    await sendLongMessage(ctx, "未返回数据。");
    return;
  }

  try {
    const url = await createTelegraphPage(title, nodes);
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
    const title = specifiedDate ? `麦当劳活动日历（${specifiedDate}）` : "麦当劳活动日历";
    await sendTelegraphArticle(ctx, title, rawText, "活动日历已生成");
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
    await sendTelegraphArticle(ctx, "麦麦省优惠券列表", rawText, "优惠券列表已生成");
  } catch (error) {
    ctx.reply(`优惠券列表查询失败：${error.message}`);
  }
}

async function handleClaimCoupons(ctx) {
  const info = ensureAccount(ctx);
  if (!info) return;

  try {
    const result = await callToolWithToken(info.account.token, "auto-bind-coupons", {});
    const text = formatToolResult(result);
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

async function handleTimeInfo(ctx) {
  const info = ensureAccount(ctx);
  if (!info) return;

  try {
    const result = await callToolWithToken(info.account.token, "now-time-info", {});
    const text = formatToolResult(result);
    await sendLongMessage(ctx, text || "未返回数据。");
  } catch (error) {
    ctx.reply(`时间查询失败：${error.message}`);
  }
}

function handleAutoClaimSetting(ctx, enabled, accountId) {
  const info = ensureAccount(ctx, accountId);
  if (!info) return;
  updateAccount(info.userId, info.accountId, { autoClaimEnabled: enabled });
  ctx.reply(`账号 ${info.displayName} 自动领券已${enabled ? "开启" : "关闭"}。`);
}

function handleAutoClaimReportSetting(ctx, enabled, accountId) {
  const info = ensureAccount(ctx, accountId);
  if (!info) return;
  updateAccount(info.userId, info.accountId, { autoClaimReport: enabled });
  ctx.reply(`账号 ${info.displayName} 自动汇报已${enabled ? "开启" : "关闭"}。`);
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

bot.command("time", async (ctx) => {
  await handleTimeInfo(ctx);
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
  const setting = args[0] ? args[0].toLowerCase() : "";
  const accountId = args[1];
  if (!setting || (setting !== "on" && setting !== "off")) {
    ctx.reply("用法：/autoclaimreport on|off [账号名]");
    return;
  }
  handleAutoClaimReportSetting(ctx, setting === "on", accountId);
});

bot.action("menu_calendar", async (ctx) => {
  await ctx.answerCbQuery();
  await handleCalendar(ctx, null);
});

bot.action("menu_time", async (ctx) => {
  await ctx.answerCbQuery();
  await handleTimeInfo(ctx);
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

bot.action("menu_accounts", async (ctx) => {
  await ctx.answerCbQuery();
  sendAccountHelp(ctx);
});

bot.action("menu_token_help", async (ctx) => {
  await ctx.answerCbQuery();
  sendTokenGuide(ctx);
});

const autoClaimInProgress = new Set();

async function runAutoClaimSweep() {
  const users = allUsers();
  const today = getLocalDate(AUTO_CLAIM_TIMEZONE);
  const currentHour = getLocalHour(AUTO_CLAIM_TIMEZONE);

  if (Number.isNaN(currentHour) || currentHour < AUTO_CLAIM_HOUR) {
    return;
  }

  for (const [userId, user] of Object.entries(users)) {
    const accounts = user.accounts || {};
    for (const [accountId, account] of Object.entries(accounts)) {
      if (!account || !account.token) {
        continue;
      }
      if (!account.autoClaimEnabled) {
        continue;
      }
      if (account.lastAutoClaimDate === today) {
        continue;
      }

      const taskKey = `${userId}:${accountId}`;
      if (autoClaimInProgress.has(taskKey)) {
        continue;
      }

      autoClaimInProgress.add(taskKey);
      const displayName = getAccountDisplayName(accountId, account);
      try {
        const result = await callToolWithToken(account.token, "auto-bind-coupons", {});
        const message = [
          `自动领券结果（${today}）- 账号：${displayName}`,
          "",
          formatToolResult(result)
        ].join("\n");

        if (account.autoClaimReport !== false) {
          await sendLongMessageToUser(userId, message);
        }
        updateAccount(userId, accountId, {
          lastAutoClaimDate: today,
          lastAutoClaimAt: getLocalDateTime(AUTO_CLAIM_TIMEZONE),
          lastAutoClaimStatus: "成功"
        });
      } catch (error) {
        updateAccount(userId, accountId, {
          lastAutoClaimDate: today,
          lastAutoClaimAt: getLocalDateTime(AUTO_CLAIM_TIMEZONE),
          lastAutoClaimStatus: `失败：${error.message}`
        });

        if (account.autoClaimReport !== false) {
          try {
            await sendLongMessageToUser(
              userId,
              `自动领券失败（${today}）- 账号：${displayName}\n${error.message}`
            );
          } catch (sendError) {
            console.error("Failed to send auto-claim error to user", sendError);
          }
        }
      } finally {
        autoClaimInProgress.delete(taskKey);
      }
    }
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
      { command: "time", description: "当前时间信息" },
      { command: "autoclaim", description: "每日自动领券开关" },
      { command: "autoclaimreport", description: "自动领券结果汇报开关" },
      { command: "status", description: "查看账号状态" },
      { command: "cleartoken", description: "清空全部账号" }
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
  bot.stop(signal);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
