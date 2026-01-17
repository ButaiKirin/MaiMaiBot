const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "..", "data");
const usersFile = path.join(dataDir, "users.json");

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function loadStore() {
  ensureDataDir();
  if (!fs.existsSync(usersFile)) {
    return { users: {}, global: {} };
  }
  try {
    const raw = fs.readFileSync(usersFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { users: {}, global: {} };
    }
    if (!parsed.users || typeof parsed.users !== "object") {
      parsed.users = {};
    }
    if (!parsed.global || typeof parsed.global !== "object") {
      parsed.global = {};
    }
    return parsed;
  } catch (error) {
    return { users: {}, global: {} };
  }
}

function saveStore(store) {
  ensureDataDir();
  const tmpPath = `${usersFile}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2));
  fs.renameSync(tmpPath, usersFile);
}

const store = loadStore();

function normalizeGlobal(globalState) {
  let changed = false;
  let normalized = globalState;

  if (!normalized || typeof normalized !== "object") {
    normalized = {};
    changed = true;
  }

  if (!normalized.knownCoupons || typeof normalized.knownCoupons !== "object") {
    normalized.knownCoupons = {};
    changed = true;
  }

  if (normalized.burst && typeof normalized.burst !== "object") {
    normalized.burst = null;
    changed = true;
  }

  if (typeof normalized.lastAutoClaimRequestAt !== "number") {
    normalized.lastAutoClaimRequestAt = 0;
    changed = true;
  }

  if (changed) {
    store.global = normalized;
    saveStore(store);
  }

  return normalized;
}

function normalizeUser(user, userId) {
  let changed = false;

  if (!user.accounts || typeof user.accounts !== "object") {
    user.accounts = {};
    changed = true;
  }

  if (user.token) {
    const legacyAccountId = user.activeAccountId || "default";
    if (!user.accounts[legacyAccountId]) {
      user.accounts[legacyAccountId] = {
        token: user.token,
        label: legacyAccountId === "default" ? "默认账号" : legacyAccountId,
        autoClaimEnabled: Boolean(user.autoClaimEnabled),
        autoClaimReportSuccess: user.autoClaimReport !== false,
        autoClaimReportFailure: user.autoClaimReport !== false,
        lastAutoClaimDate: user.lastAutoClaimDate,
        lastAutoClaimAt: user.lastAutoClaimAt,
        lastAutoClaimStatus: user.lastAutoClaimStatus
      };
      changed = true;
    } else if (!user.accounts[legacyAccountId].token) {
      user.accounts[legacyAccountId].token = user.token;
      changed = true;
    }

    user.activeAccountId = legacyAccountId;
    delete user.token;
    delete user.autoClaimEnabled;
    delete user.autoClaimReport;
    delete user.lastAutoClaimDate;
    delete user.lastAutoClaimAt;
    delete user.lastAutoClaimStatus;
    changed = true;
  }

  if (!user.activeAccountId) {
    const firstId = Object.keys(user.accounts)[0];
    if (firstId) {
      user.activeAccountId = firstId;
      changed = true;
    }
  }

  for (const [accountId, account] of Object.entries(user.accounts)) {
    if (!account || typeof account !== "object") {
      user.accounts[accountId] = { token: "" };
      changed = true;
      continue;
    }
    if (!account.label) {
      account.label = accountId === "default" ? "默认账号" : accountId;
      changed = true;
    }
    if (typeof account.autoClaimEnabled !== "boolean") {
      account.autoClaimEnabled = false;
      changed = true;
    }
    if (typeof account.autoClaimReportSuccess !== "boolean") {
      if (typeof account.autoClaimReport === "boolean") {
        account.autoClaimReportSuccess = account.autoClaimReport;
      } else {
        account.autoClaimReportSuccess = true;
      }
      changed = true;
    }
    if (typeof account.autoClaimReportFailure !== "boolean") {
      if (typeof account.autoClaimReport === "boolean") {
        account.autoClaimReportFailure = account.autoClaimReport;
      } else {
        account.autoClaimReportFailure = true;
      }
      changed = true;
    }
    if (account.autoClaimReport !== undefined) {
      delete account.autoClaimReport;
      changed = true;
    }
  }

  if (changed) {
    store.users[userId] = user;
    saveStore(store);
  }

  return user;
}

function getUser(userId) {
  const user = store.users[userId];
  if (!user) {
    return null;
  }
  return normalizeUser(user, userId);
}

function getGlobalState() {
  if (!store.global || typeof store.global !== "object") {
    store.global = {};
  }
  return normalizeGlobal(store.global);
}

function updateGlobalState(updates) {
  const current = getGlobalState();
  store.global = {
    ...current,
    ...updates
  };
  saveStore(store);
  return store.global;
}

function upsertUser(userId, updates) {
  const existing = store.users[userId] || {};
  store.users[userId] = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString()
  };
  saveStore(store);
  return store.users[userId];
}

function deleteUser(userId) {
  if (store.users[userId]) {
    delete store.users[userId];
    saveStore(store);
  }
}

function allUsers() {
  const normalized = {};
  for (const [userId, user] of Object.entries(store.users)) {
    normalized[userId] = normalizeUser(user, userId);
  }
  return normalized;
}

module.exports = {
  getUser,
  getGlobalState,
  updateGlobalState,
  upsertUser,
  deleteUser,
  allUsers
};
