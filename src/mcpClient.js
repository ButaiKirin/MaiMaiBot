const DEFAULT_ACCEPT = "application/json, text/event-stream";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_RETRY_OPTIONS = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 5000,
  jitterMs: 200,
  retryOnStatus: [502, 503, 504],
  retryOnTimeout: true,
  retryOnNetworkError: true
};

function normalizeRetryOptions(options) {
  const source = options && typeof options === "object" ? options : {};
  const maxRetries = Number.isFinite(source.maxRetries)
    ? Math.max(0, Math.floor(source.maxRetries))
    : DEFAULT_RETRY_OPTIONS.maxRetries;
  const baseDelayMs = Number.isFinite(source.baseDelayMs)
    ? Math.max(0, source.baseDelayMs)
    : DEFAULT_RETRY_OPTIONS.baseDelayMs;
  const maxDelayMs = Number.isFinite(source.maxDelayMs)
    ? Math.max(0, source.maxDelayMs)
    : DEFAULT_RETRY_OPTIONS.maxDelayMs;
  const jitterMs = Number.isFinite(source.jitterMs)
    ? Math.max(0, source.jitterMs)
    : DEFAULT_RETRY_OPTIONS.jitterMs;
  const retryOnTimeout =
    typeof source.retryOnTimeout === "boolean" ? source.retryOnTimeout : DEFAULT_RETRY_OPTIONS.retryOnTimeout;
  const retryOnNetworkError =
    typeof source.retryOnNetworkError === "boolean"
      ? source.retryOnNetworkError
      : DEFAULT_RETRY_OPTIONS.retryOnNetworkError;
  const rawStatus =
    source.retryOnStatus || source.retryOnStatusCodes || DEFAULT_RETRY_OPTIONS.retryOnStatus;
  const statusValues = Array.isArray(rawStatus)
    ? rawStatus
    : rawStatus instanceof Set
      ? Array.from(rawStatus)
      : [];
  const retryOnStatus = new Set(
    statusValues
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
  );

  return {
    maxRetries,
    baseDelayMs,
    maxDelayMs,
    jitterMs,
    retryOnTimeout,
    retryOnNetworkError,
    retryOnStatus
  };
}

function computeBackoffMs(attempt, options) {
  const exp = Math.pow(2, Math.max(0, attempt - 1));
  const baseDelay = options.baseDelayMs * exp;
  const capped = Math.min(options.maxDelayMs, baseDelay);
  if (options.jitterMs > 0) {
    return capped + Math.floor(Math.random() * options.jitterMs);
  }
  return capped;
}

function shouldRetryError(error, options) {
  if (!error || !options) {
    return false;
  }
  if (error.code === "MCP_SESSION_EXPIRED") {
    return false;
  }
  if (error.isTimeout || error.code === "MCP_TIMEOUT") {
    return options.retryOnTimeout;
  }
  if (error.isNetworkError || error.code === "MCP_NETWORK_ERROR") {
    return options.retryOnNetworkError;
  }
  if (Number.isFinite(error.status)) {
    return options.retryOnStatus.has(error.status);
  }
  const match = String(error.message || "").match(/MCP request failed \((\d+)\)/);
  if (match) {
    const status = Number(match[1]);
    if (Number.isFinite(status)) {
      return options.retryOnStatus.has(status);
    }
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MCPClient {
  constructor({
    baseUrl,
    token,
    protocolVersion = DEFAULT_PROTOCOL_VERSION,
    clientInfo,
    requestTimeoutMs,
    retryOptions
  }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.protocolVersion = protocolVersion;
    this.requestTimeoutMs = Number.isFinite(requestTimeoutMs) ? requestTimeoutMs : null;
    this.retryOptions = normalizeRetryOptions(retryOptions);
    this.clientInfo = clientInfo || {
      name: "MaiMaiTelegramBot",
      title: "MaiMai Telegram Bot",
      version: "1.0.0"
    };
    this.sessionId = null;
    this.initialized = false;
    this.initializing = null;
    this.nextRequestId = 1;
  }

  async callTool(name, args) {
    await this.initialize();
    const message = {
      jsonrpc: "2.0",
      id: this._nextId(),
      method: "tools/call",
      params: {
        name,
        arguments: args || {}
      }
    };

    try {
      const response = await this._sendRpc(message, { expectResponse: true });
      return this._unwrapResult(response);
    } catch (error) {
      if (error && error.code === "MCP_SESSION_EXPIRED") {
        this.initialized = false;
        this.sessionId = null;
        await this.initialize();
        const retryResponse = await this._sendRpc(message, { expectResponse: true });
        return this._unwrapResult(retryResponse);
      }
      throw error;
    }
  }

  async listTools() {
    await this.initialize();
    const tools = [];
    let cursor = undefined;

    while (true) {
      const message = {
        jsonrpc: "2.0",
        id: this._nextId(),
        method: "tools/list",
        params: cursor ? { cursor } : {}
      };

      let response;
      try {
        response = await this._sendRpc(message, { expectResponse: true });
      } catch (error) {
        if (error && error.code === "MCP_SESSION_EXPIRED") {
          this.initialized = false;
          this.sessionId = null;
          await this.initialize();
          response = await this._sendRpc(message, { expectResponse: true });
        } else {
          throw error;
        }
      }

      const result = this._unwrapResult(response) || {};
      const pageTools = Array.isArray(result.tools) ? result.tools : Array.isArray(result) ? result : [];
      if (pageTools.length) {
        tools.push(...pageTools);
      }
      if (!result.nextCursor) {
        break;
      }
      cursor = result.nextCursor;
    }

    return tools;
  }

  async initialize() {
    if (this.initialized) {
      return;
    }
    if (this.initializing) {
      await this.initializing;
      return;
    }

    this.initializing = (async () => {
      const initMessage = {
        jsonrpc: "2.0",
        id: this._nextId(),
        method: "initialize",
        params: {
          protocolVersion: this.protocolVersion,
          capabilities: {},
          clientInfo: this.clientInfo
        }
      };

      const response = await this._sendRpc(initMessage, {
        expectResponse: true
      });

      if (!response || response.error) {
        const message = response && response.error && response.error.message
          ? response.error.message
          : "Failed to initialize MCP session";
        throw new Error(message);
      }

      if (response.result && response.result.protocolVersion) {
        this.protocolVersion = response.result.protocolVersion;
      }

      const initializedNotification = {
        jsonrpc: "2.0",
        method: "notifications/initialized"
      };

      await this._sendRpc(initializedNotification, { expectResponse: false });
      this.initialized = true;
    })();

    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  _nextId() {
    return this.nextRequestId++;
  }

  async _sendRpc(message, options = {}) {
    const retryOptions = options.retryOptions
      ? normalizeRetryOptions(options.retryOptions)
      : this.retryOptions;
    const shouldRetry = options.retry !== false && retryOptions.maxRetries > 0;
    let attempts = 0;
    while (true) {
      try {
        return await this._sendRpcOnce(message, options);
      } catch (error) {
        if (!shouldRetry || attempts >= retryOptions.maxRetries || !shouldRetryError(error, retryOptions)) {
          throw error;
        }
        attempts += 1;
        const delayMs = computeBackoffMs(attempts, retryOptions);
        if (delayMs > 0) {
          await sleep(delayMs);
        }
      }
    }
  }

  async _sendRpcOnce(message, options = {}) {
    const expectResponse = options.expectResponse ?? !!message.id;
    const headers = {
      Accept: DEFAULT_ACCEPT,
      "Content-Type": "application/json"
    };

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    if (options.includeProtocolHeader !== false && this.protocolVersion) {
      headers["MCP-Protocol-Version"] = this.protocolVersion;
    }

    const controller = new AbortController();
    let timeoutId = null;
    if (this.requestTimeoutMs && this.requestTimeoutMs > 0) {
      timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    }

    let response;
    try {
      response = await fetch(this.baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal
      });
    } catch (error) {
      if (error && error.name === "AbortError") {
        const timeoutError = new Error(`MCP request timed out after ${this.requestTimeoutMs}ms`);
        timeoutError.code = "MCP_TIMEOUT";
        timeoutError.isTimeout = true;
        timeoutError.isUpstream = true;
        throw timeoutError;
      }
      if (error && typeof error === "object") {
        if (!error.code) {
          error.code = "MCP_NETWORK_ERROR";
        }
        error.isNetworkError = true;
        error.isUpstream = true;
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }

    if (!expectResponse) {
      if (![200, 202, 204].includes(response.status)) {
        const body = await safeReadText(response);
        const error = new Error(`MCP notification rejected (${response.status}): ${body}`);
        error.status = response.status;
        error.body = body;
        error.isUpstream = response.status >= 500;
        throw error;
      }
      return null;
    }

    if (response.status === 404 && this.sessionId) {
      const error = new Error("MCP session expired");
      error.code = "MCP_SESSION_EXPIRED";
      error.status = response.status;
      throw error;
    }

    if (!response.ok) {
      const body = await safeReadText(response);
      const error = new Error(`MCP request failed (${response.status}): ${body}`);
      error.status = response.status;
      error.body = body;
      error.isUpstream = response.status >= 500;
      throw error;
    }

    const newSessionId = response.headers.get("mcp-session-id");
    if (newSessionId && !this.sessionId) {
      this.sessionId = newSessionId;
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      const text = await response.text();
      return parseSseForResponse(text, message.id);
    }

    return response.json();
  }

  _unwrapResult(response) {
    if (!response) {
      throw new Error("Empty MCP response");
    }
    if (response.error) {
      throw new Error(response.error.message || "MCP error");
    }
    return response.result ?? response;
  }
}

function parseSseForResponse(text, requestId) {
  const events = [];
  let dataLines = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    } else if (line.trim() === "") {
      if (dataLines.length) {
        events.push(dataLines.join("\n"));
        dataLines = [];
      }
    }
  }

  if (dataLines.length) {
    events.push(dataLines.join("\n"));
  }

  let lastEvent = null;
  for (const payload of events) {
    try {
      const parsed = JSON.parse(payload);
      lastEvent = parsed;
      if (requestId !== undefined && parsed.id === requestId) {
        return parsed;
      }
    } catch (error) {
      continue;
    }
  }

  if (lastEvent) {
    return lastEvent;
  }

  throw new Error("No JSON-RPC response found in SSE stream");
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch (error) {
    return "";
  }
}

module.exports = {
  MCPClient
};
