require("dotenv").config();

const { Telegraf } = require("telegraf");
const { MCPClient } = require("./mcpClient");
const { TTLCache } = require("./cache");
const { getUser, upsertUser, deleteUser, allUsers } = require("./storage");
const { getLocalDate, getLocalHour, getLocalDateTime } = require("./time");

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

function formatToolResult(result) {
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

  return formatTelegramHtml(rawText);
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

function ensureToken(ctx) {
  const userId = String(ctx.from.id);
  const user = getUser(userId);
  if (!user || !user.token) {
    ctx.reply("请先使用 /token 设置 MCP Token。");
    return null;
  }
  return user;
}

async function callToolForUser(userId, toolName, args) {
  const user = getUser(userId);
  if (!user || !user.token) {
    throw new Error("缺少 MCP Token，请先使用 /token 设置。");
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
    token: user.token,
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
    "先获取麦当劳 MCP Token：",
    "1) 打开 https://open.mcd.cn/mcp/doc",
    "2) 右上角登录（手机号验证）",
    "3) 登录后点击“控制台”，点击激活申请 MCP Token",
    "4) 同意协议后复制 Token",
    "",
    "在这里发送：",
    "/token 你的MCP_TOKEN",
    "",
    "指令：",
    "/calendar [YYYY-MM-DD] - 活动日历查询",
    "/coupons - 麦麦省可领取券列表",
    "/claim - 麦麦省一键领券",
    "/mycoupons - 我的优惠券",
    "/time - 当前时间信息",
    "/autoclaim on|off - 每日自动领券",
    "/status - 查看账号状态",
    "/cleartoken - 删除已保存的 Token"
  ].join("\n");
  ctx.reply(message, { disable_web_page_preview: true });
});

bot.command(["token", "settoken"], (ctx) => {
  const text = ctx.message.text || "";
  const token = text.split(" ").slice(1).join(" ").trim();
  if (!token) {
    ctx.reply("用法：/token 你的MCP_TOKEN");
    return;
  }
  const userId = String(ctx.from.id);
  upsertUser(userId, { token });
  ctx.reply("Token 已保存，可以开始使用指令了。");
});

bot.command("cleartoken", (ctx) => {
  const userId = String(ctx.from.id);
  const existing = getUser(userId);
  if (!existing) {
    ctx.reply("未找到已保存的 Token。");
    return;
  }
  deleteUser(userId);
  ctx.reply("Token 已删除。");
});

bot.command("status", (ctx) => {
  const userId = String(ctx.from.id);
  const user = getUser(userId);
  if (!user) {
    ctx.reply("未保存 Token，请先使用 /token 设置。");
    return;
  }
  const autoClaimStatus = user.autoClaimEnabled ? "已开启" : "已关闭";
  const lastRun = user.lastAutoClaimAt || "从未执行";
  ctx.reply(
    `Token：${user.token ? "已设置" : "未设置"}\n自动领券：${autoClaimStatus}\n上次自动领券：${lastRun}`
  );
});

bot.command("calendar", async (ctx) => {
  const user = ensureToken(ctx);
  if (!user) return;

  const raw = (ctx.message.text || "").split(" ").slice(1).join(" ").trim();
  let args = {};
  if (raw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      ctx.reply("日期格式错误，请使用 YYYY-MM-DD。");
      return;
    }
    args = { specifiedDate: raw };
  }

  try {
    const result = await callToolForUser(String(ctx.from.id), "campaign-calender", args);
    const text = formatToolResult(result);
    await sendLongMessage(ctx, text || "未返回数据。");
  } catch (error) {
    ctx.reply(`活动日历查询失败：${error.message}`);
  }
});

bot.command("coupons", async (ctx) => {
  const user = ensureToken(ctx);
  if (!user) return;

  try {
    const result = await callToolForUser(String(ctx.from.id), "available-coupons", {});
    const text = formatToolResult(result);
    await sendLongMessage(ctx, text || "未返回数据。");
  } catch (error) {
    ctx.reply(`优惠券列表查询失败：${error.message}`);
  }
});

bot.command("claim", async (ctx) => {
  const user = ensureToken(ctx);
  if (!user) return;

  try {
    const result = await callToolForUser(String(ctx.from.id), "auto-bind-coupons", {});
    const text = formatToolResult(result);
    await sendLongMessage(ctx, text || "未返回数据。");
  } catch (error) {
    ctx.reply(`一键领券失败：${error.message}`);
  }
});

bot.command("mycoupons", async (ctx) => {
  const user = ensureToken(ctx);
  if (!user) return;

  try {
    const result = await callToolForUser(String(ctx.from.id), "my-coupons", {});
    const text = formatToolResult(result);
    await sendLongMessage(ctx, text || "未返回数据。");
  } catch (error) {
    ctx.reply(`我的优惠券查询失败：${error.message}`);
  }
});

bot.command("time", async (ctx) => {
  const user = ensureToken(ctx);
  if (!user) return;

  try {
    const result = await callToolForUser(String(ctx.from.id), "now-time-info", {});
    const text = formatToolResult(result);
    await sendLongMessage(ctx, text || "未返回数据。");
  } catch (error) {
    ctx.reply(`时间查询失败：${error.message}`);
  }
});

bot.command("autoclaim", (ctx) => {
  const userId = String(ctx.from.id);
  const user = getUser(userId);
  if (!user || !user.token) {
    ctx.reply("请先使用 /token 设置 MCP Token。");
    return;
  }

  const text = ctx.message.text || "";
  const arg = text.split(" ").slice(1).join(" ").trim().toLowerCase();
  if (!arg || (arg !== "on" && arg !== "off")) {
    ctx.reply("用法：/autoclaim on|off");
    return;
  }

  const enabled = arg === "on";
  upsertUser(userId, { autoClaimEnabled: enabled });
  ctx.reply(`自动领券已${enabled ? "开启" : "关闭"}。`);
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
    if (!user.autoClaimEnabled || !user.token) {
      continue;
    }
    if (user.lastAutoClaimDate === today) {
      continue;
    }
    if (autoClaimInProgress.has(userId)) {
      continue;
    }

    autoClaimInProgress.add(userId);
    try {
      const result = await callToolForUser(userId, "auto-bind-coupons", {});
      const message = [
        `自动领券结果（${today}）：`,
        "",
        formatToolResult(result)
      ].join("\n");

      await sendLongMessageToUser(userId, message);
      upsertUser(userId, {
        lastAutoClaimDate: today,
        lastAutoClaimAt: getLocalDateTime(AUTO_CLAIM_TIMEZONE),
        lastAutoClaimStatus: "成功"
      });
    } catch (error) {
      upsertUser(userId, {
        lastAutoClaimDate: today,
        lastAutoClaimAt: getLocalDateTime(AUTO_CLAIM_TIMEZONE),
        lastAutoClaimStatus: `失败：${error.message}`
      });

      try {
        await sendLongMessageToUser(
          userId,
          `自动领券失败（${today}）：${error.message}`
        );
      } catch (sendError) {
        console.error("Failed to send auto-claim error to user", sendError);
      }
    } finally {
      autoClaimInProgress.delete(userId);
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
