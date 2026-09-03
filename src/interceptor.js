(() => {
  "use strict";

  if (window.__CGO_FETCH_PATCHED__) return;

  const STORAGE_KEY = "cgo_config_v1";
  const OVERRIDES_KEY = "cgo_thread_overrides_v1";
  const BYPASS_KEY = "cgo_full_history_once";
  const CONFIG_EVENT = "cgo-config";
  const OVERRIDES_EVENT = "cgo-thread-overrides";
  const STATUS_EVENT = "cgo-status";
  const ARCHIVE_REQUEST_EVENT = "cgo-archive-request";
  const ARCHIVE_RESPONSE_EVENT = "cgo-archive-response";
  const FULL_HISTORY_EVENT = "cgo-full-history-once";
  const DEFAULT_CONFIG = Object.freeze({ enabled: true, mode: "turbo", keepCount: 30 });
  const archives = new Map();
  let latestConversationId = null;
  let config = readStoredConfig() || { ...DEFAULT_CONFIG };
  let threadOverrides = readStoredOverrides();
  let configResolved = Boolean(readStoredConfig());
  let resolveConfigReady;
  const configReady = new Promise((resolve) => { resolveConfigReady = resolve; });

  function readStoredConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return normalizeConfig(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  function normalizeOverrides(value) {
    const clean = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return clean;
    for (const [id, raw] of Object.entries(value)) {
      if (!id || typeof id !== "string") continue;
      const keepCount = Math.min(200, Math.max(1, Math.round(Number(raw) || 0)));
      if (Number.isFinite(keepCount) && keepCount >= 1) clean[id] = keepCount;
    }
    return clean;
  }

  function readStoredOverrides() {
    try {
      const raw = localStorage.getItem(OVERRIDES_KEY);
      if (!raw) return {};
      return normalizeOverrides(JSON.parse(raw));
    } catch {
      return {};
    }
  }

  function normalizeConfig(value) {
    return {
      enabled: value?.enabled !== false,
      mode: ["safe", "turbo", "extreme"].includes(value?.mode) ? value.mode : DEFAULT_CONFIG.mode,
      keepCount: Math.min(200, Math.max(1, Number(value?.keepCount) || DEFAULT_CONFIG.keepCount))
    };
  }

  function setConfig(next) {
    config = normalizeConfig(next);
    configResolved = true;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch {}
    resolveConfigReady?.();
    resolveConfigReady = null;
  }

  function setOverrides(next) {
    threadOverrides = normalizeOverrides(next);
    try { localStorage.setItem(OVERRIDES_KEY, JSON.stringify(threadOverrides)); } catch {}
  }

  function keepCountFor(conversationId) {
    const override = Number(threadOverrides?.[conversationId]);
    if (Number.isFinite(override) && override >= 1) return Math.min(200, Math.max(1, override));
    return config.keepCount;
  }

  async function ensureConfigReady() {
    if (configResolved) return;
    await Promise.race([configReady, new Promise((resolve) => setTimeout(resolve, 60))]);
    configResolved = true;
    resolveConfigReady?.();
    resolveConfigReady = null;
  }

  function requestInfo(input, init) {
    let urlString;
    let method;
    if (input instanceof Request) {
      urlString = input.url;
      method = String(init?.method || input.method || "GET").toUpperCase();
    } else if (input instanceof URL) {
      urlString = input.href;
      method = String(init?.method || "GET").toUpperCase();
    } else {
      urlString = String(input);
      method = String(init?.method || "GET").toUpperCase();
    }
    return { url: new URL(urlString, location.href), method };
  }

  function conversationIdFrom(url) {
    const match = url.pathname.match(/^\/backend-api\/(?:conversation|shared_conversation)\/([^/]+)\/?$/);
    return match?.[1] || null;
  }

  function isConversationGet(info) {
    return info.method === "GET" && Boolean(conversationIdFrom(info.url));
  }

  function isJson(response) {
    return (response.headers.get("content-type") || "").toLowerCase().includes("application/json");
  }

  function rewrittenResponse(original, data) {
    const headers = new Headers(original.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("content-type", "application/json; charset=utf-8");
    const response = new Response(JSON.stringify(data), {
      status: original.status,
      statusText: original.statusText,
      headers
    });
    try {
      Object.defineProperty(response, "url", { value: original.url });
      Object.defineProperty(response, "type", { value: original.type });
    } catch {}
    return response;
  }

  function dispatch(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(detail) }));
  }

  function archiveFor(conversationId, archive) {
    latestConversationId = conversationId;
    archives.set(conversationId, archive.map((item) => ({
      id: String(item.id || ""),
      role: String(item.role || "unknown"),
      text: String(item.text || ""),
      createTime: item.createTime ?? null
    })));
  }

  window.addEventListener(CONFIG_EVENT, (event) => {
    if (typeof event.detail !== "string") return;
    try { setConfig(JSON.parse(event.detail)); } catch {}
  });

  window.addEventListener(OVERRIDES_EVENT, (event) => {
    if (typeof event.detail !== "string") return;
    try { setOverrides(JSON.parse(event.detail)); } catch {}
  });

  window.addEventListener(ARCHIVE_REQUEST_EVENT, (event) => {
    if (typeof event.detail !== "string") return;
    let request;
    try { request = JSON.parse(event.detail); } catch { return; }
    const conversationId = request.conversationId || latestConversationId;
    const archive = archives.get(conversationId) || [];
    const limit = Math.min(100, Math.max(1, Number(request.limit) || 10));
    const offset = Math.max(0, Number(request.offset) || 0);
    const end = Math.max(0, archive.length - offset);
    const start = Math.max(0, end - limit);
    dispatch(ARCHIVE_RESPONSE_EVENT, {
      requestId: request.requestId,
      conversationId,
      total: archive.length,
      start,
      end,
      hasOlder: start > 0,
      hasNewer: end < archive.length,
      items: archive.slice(start, end)
    });
  });

  window.addEventListener(FULL_HISTORY_EVENT, () => {
    try { sessionStorage.setItem(BYPASS_KEY, "1"); } catch {}
    location.reload();
  });

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    let info;
    try { info = requestInfo(args[0], args[1]); } catch { return nativeFetch(...args); }
    if (!isConversationGet(info)) return nativeFetch(...args);

    await ensureConfigReady();
    const response = await nativeFetch(...args);
    const conversationId = conversationIdFrom(info.url);
    if (!conversationId || !response.ok || !isJson(response)) return response;

    const effectiveKeepCount = keepCountFor(conversationId);
    const threadOverride = Object.prototype.hasOwnProperty.call(threadOverrides, conversationId);

    let bypass = false;
    try {
      bypass = sessionStorage.getItem(BYPASS_KEY) === "1";
      if (bypass) sessionStorage.removeItem(BYPASS_KEY);
    } catch {}

    if (!config.enabled || config.mode === "safe" || bypass) {
      dispatch(STATUS_EVENT, {
        source: "network",
        conversationId,
        trimmed: false,
        bypassed: bypass,
        keepCount: effectiveKeepCount,
        threadOverride
      });
      return response;
    }

    try {
      const data = await response.clone().json();
      const result = window.__CGO_TRIMMER__?.trimConversation(data, effectiveKeepCount);
      if (!result) return response;

      archiveFor(conversationId, result.archive || []);
      dispatch(STATUS_EVENT, {
        source: "network",
        conversationId,
        trimmed: Boolean(result.changed),
        total: result.visibleTotal,
        kept: result.visibleKept,
        removed: Math.max(0, result.visibleTotal - result.visibleKept),
        keepCount: effectiveKeepCount,
        threadOverride,
        archiveCount: result.archive?.length || 0
      });

      if (!result.changed) return response;
      return rewrittenResponse(response, {
        ...data,
        mapping: result.mapping,
        current_node: result.currentNode,
        root: result.root
      });
    } catch (error) {
      dispatch(STATUS_EVENT, {
        source: "network",
        conversationId,
        trimmed: false,
        error: String(error?.message || error),
        keepCount: effectiveKeepCount,
        threadOverride
      });
      return response;
    }
  };

  window.__CGO_FETCH_PATCHED__ = true;
  dispatch("cgo-proxy-ready", { ready: true });
})();