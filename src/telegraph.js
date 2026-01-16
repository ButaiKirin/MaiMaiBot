const fs = require("fs");
const path = require("path");

const TELEGRAPH_API = "https://api.telegra.ph";
const dataDir = path.join(__dirname, "..", "data");
const telegraphFile = path.join(dataDir, "telegraph.json");

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function loadTelegraphConfig() {
  ensureDataDir();
  if (!fs.existsSync(telegraphFile)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(telegraphFile, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function saveTelegraphConfig(config) {
  ensureDataDir();
  const tmp = `${telegraphFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, telegraphFile);
}

async function ensureTelegraphAccount() {
  const existing = loadTelegraphConfig();
  if (existing && existing.access_token) {
    return existing.access_token;
  }

  const shortName = process.env.TELEGRAPH_SHORT_NAME || "MaiMaiMCPBot";
  const authorName = process.env.TELEGRAPH_AUTHOR_NAME || "MaiMaiMCPBot";
  const authorUrl = process.env.TELEGRAPH_AUTHOR_URL || "";

  const params = new URLSearchParams({
    short_name: shortName,
    author_name: authorName
  });
  if (authorUrl) {
    params.append("author_url", authorUrl);
  }

  const response = await fetch(`${TELEGRAPH_API}/createAccount`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegraph createAccount failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  if (!data.ok || !data.result || !data.result.access_token) {
    throw new Error("Telegraph createAccount returned invalid response");
  }

  const config = {
    access_token: data.result.access_token,
    short_name: data.result.short_name,
    author_name: data.result.author_name,
    author_url: data.result.author_url || ""
  };
  saveTelegraphConfig(config);
  return config.access_token;
}

async function createTelegraphPage(title, nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("Telegraph content is empty");
  }

  const accessToken = await ensureTelegraphAccount();
  const params = new URLSearchParams({
    access_token: accessToken,
    title,
    content: JSON.stringify(nodes),
    return_content: "false"
  });

  const response = await fetch(`${TELEGRAPH_API}/createPage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegraph createPage failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  if (!data.ok || !data.result || !data.result.url) {
    throw new Error("Telegraph createPage returned invalid response");
  }

  return data.result.url;
}

module.exports = {
  createTelegraphPage
};
