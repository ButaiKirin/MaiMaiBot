#!/usr/bin/env node

const { bot, handleSyntheticMessage } = require("../src/index");
const { getUser, upsertUser, deleteUser } = require("../src/storage");

function parseArgs(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }
    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = "true";
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function getPayloadPreview(method, payload) {
  if (!payload || typeof payload !== "object") {
    return `${method}: <empty>`;
  }
  if (typeof payload.text === "string" && payload.text) {
    return `${method}: ${payload.text.slice(0, 120)}`;
  }
  if (typeof payload.caption === "string" && payload.caption) {
    return `${method}: ${payload.caption.slice(0, 120)}`;
  }
  if (payload.photo) {
    return `${method}: <photo>`;
  }
  return `${method}: <${Object.keys(payload).join(",")}>`;
}

function hasFailureText(entries) {
  return entries.some((entry) => {
    const text = String(entry.text || "");
    return (
      text.includes("Token 已保存，但暂时无法验证") ||
      text.includes("当前鉴权码不存在或已失效") ||
      text.includes("上游故障") ||
      /失败[:：]/.test(text)
    );
  });
}

function sanitizeCommandForLog(text) {
  return String(text || "").replace(/^\/token\s+\S+$/i, "/token <redacted>");
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv);
  const userId = String(args.user || "");
  const token = String(args.token || "");
  if (!userId || !token) {
    throw new Error("Usage: node scripts/synthetic-test.js --user <telegramUserId> --token <mcpToken>");
  }

  const originalUser = cloneValue(getUser(userId));
  const outbound = [];
  const originalCallApi = bot.telegram.callApi.bind(bot.telegram);

  bot.telegram.callApi = async (method, payload, signal) => {
    if (method.startsWith("send") || method.startsWith("edit")) {
      outbound.push({
        method,
        payload: cloneValue(payload),
        text: typeof payload?.text === "string" ? payload.text : typeof payload?.caption === "string" ? payload.caption : ""
      });
    }
    return originalCallApi(method, payload, signal);
  };

  let createdOrderId = "";
  const commandResults = [];

  async function runCommand(text, options = {}) {
    const start = outbound.length;
    await handleSyntheticMessage(userId, text, {
      firstName: "Henry",
      username: "henryvu"
    });
    await sleep(300);
    const entries = outbound.slice(start).map((entry) => ({
      method: entry.method,
      text: entry.text,
      preview: getPayloadPreview(entry.method, entry.payload)
    }));
    const combinedText = entries.map((entry) => entry.text).join("\n");
    const orderMatch = combinedText.match(/订单号[:：]\s*([0-9]{10,})/);
    if (orderMatch && !createdOrderId && text.startsWith("/order create ")) {
      createdOrderId = orderMatch[1];
    }
    const ok = entries.length > 0 && !hasFailureText(entries);
    commandResults.push({
      command: sanitizeCommandForLog(text),
      ok,
      messageCount: entries.length,
      preview: entries.map((entry) => entry.preview).join(" | ").slice(0, 400)
    });
    if (!ok && !options.allowFailure) {
      throw new Error(`Synthetic command failed: ${sanitizeCommandForLog(text)}`);
    }
    return entries;
  }

  try {
    await bot.telegram.sendMessage(
      userId,
      [
        "[自动测试] 开始线上受控测试。",
        "本轮消息由隔离副本发出，只针对你，不会动生产用户存储。",
        "其中 /order create 会创建一笔未支付测试订单；/deliveryadd 因为会写真实地址，本轮跳过。"
      ].join("\n")
    );

    await runCommand(`/token ${token}`);
    await runCommand("/status");
    await runCommand("/tools");
    await runCommand("/calendar");
    await runCommand("/coupons");
    await runCommand("/claim");
    await runCommand("/mycoupons");
    await runCommand("/points");
    await runCommand("/now");
    await runCommand("/nutrition 巨无霸");
    await runCommand("/deliveryaddrs mls");
    await runCommand("/deliveryaddrs group");
    await runCommand("/stores search 上海市 人民广场");
    await runCommand("/meals 1450713 pickup");
    await runCommand("/mealdetail 9900005466 1450713 pickup");
    await runCommand('/price {"storeCode":"1450713","orderType":"pickup","items":[{"productCode":"9900005466","quantity":1}]}');
    await runCommand('/order create {"storeCode":"1450713","orderType":"pickup","takeWayCode":"locker-out","items":[{"productCode":"9900005466","quantity":1}]}');
    if (createdOrderId) {
      await runCommand(`/order query ${createdOrderId}`);
    }
    await runCommand("/mall list");
    await runCommand("/mall detail 15865");

    const summaryLines = [
      "[自动测试] 已完成。",
      `命令数: ${commandResults.length}`,
      `失败数: ${commandResults.filter((item) => !item.ok).length}`,
      createdOrderId ? `测试订单号: ${createdOrderId}` : "测试订单号: 未获取"
    ];
    await bot.telegram.sendMessage(userId, summaryLines.join("\n"));
    console.log(JSON.stringify({ ok: true, createdOrderId, commandResults }, null, 2));
  } finally {
    bot.telegram.callApi = originalCallApi;
    if (originalUser) {
      deleteUser(userId);
      upsertUser(userId, originalUser);
    } else {
      deleteUser(userId);
    }
  }
}

main().catch(async (error) => {
  try {
    const args = parseArgs(process.argv);
    if (args.user) {
      await bot.telegram.sendMessage(String(args.user), `[自动测试] 失败：${String(error.message || error)}`);
    }
  } catch (notifyError) {
    console.error("Failed to notify user about synthetic test error", notifyError);
  }
  console.error(error);
  process.exit(1);
});
