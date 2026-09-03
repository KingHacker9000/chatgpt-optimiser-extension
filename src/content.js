(() => {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    mode: "turbo", // safe | turbo | extreme
    keepCount: 30,
    batchSize: 10,
    autoCollapseTraces: true,
    longResponseVirtualization: true,
    pauseHiddenRendering: true,
    showDock: true
  });

  const THREAD_OVERRIDES_KEY = "threadKeepCounts";
  const CONFIG_EVENT = "cgo-config";
  const STATUS_EVENT = "cgo-status";
  const PROXY_READY_EVENT = "cgo-proxy-ready";
  const ARCHIVE_REQUEST_EVENT = "cgo-archive-request";
  const ARCHIVE_RESPONSE_EVENT = "cgo-archive-response";
  const FULL_HISTORY_EVENT = "cgo-full-history-once";

  const TURN_SELECTORS = [
    'main section[data-testid^="conversation-turn-"]',
    'main article[data-testid^="conversation-turn-"]',
    'main [data-testid^="conversation-turn-"]',
    'main section[data-turn="user"], main section[data-turn="assistant"]',
    'main article[data-turn-id]'
  ];

  const TRACE_LABEL_RE = /(?:thinking|reasoning|thought|analy[sz]|research|search(?:ed|ing)?|brows(?:ed|ing)|tool|terminal|python|code interpreter|read\b|open(?:ed|ing)?|fetch(?:ed|ing)?|check(?:ed|ing)?|process(?:ed|ing)?|work(?:ed|ing)?|ran\b|running|execut(?:ed|ing)?)/i;
  const COMPRESS_MIN_CHARS = 20_000;
  const RECONCILE_DELAY = 420;
  const TRACE_SCAN_INTERVAL = 1400;

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

  function runIdle(callback) {
    if ("requestIdleCallback" in window) return requestIdleCallback(callback, { timeout: 1800 });
    return setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 0 }), 60);
  }

  function cancelIdle(handle) {
    if ("cancelIdleCallback" in window) cancelIdleCallback(handle);
    else clearTimeout(handle);
  }

  async function gzipString(text) {
    if (!("CompressionStream" in window)) return null;
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function gunzipString(bytes) {
    if (!("DecompressionStream" in window)) return null;
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }

  function restoreSanitizedHtml(target, html) {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    parsed.querySelectorAll("script,iframe,object,embed,meta,link").forEach((node) => node.remove());
    for (const element of parsed.body.querySelectorAll("*")) {
      for (const attr of [...element.attributes]) {
        if (/^on/i.test(attr.name)) element.removeAttribute(attr.name);
        if ((attr.name === "href" || attr.name === "src") && /^\s*javascript:/i.test(attr.value)) element.removeAttribute(attr.name);
      }
    }
    const fragment = document.createDocumentFragment();
    for (const node of [...parsed.body.childNodes]) fragment.append(document.importNode(node, true));
    target.replaceChildren(fragment);
  }

  class Optimizer {
    constructor() {
      this.settings = { ...DEFAULT_SETTINGS };
      this.threadOverrides = {};
      this.snapshots = new Map();
      this.hibernated = new Set();
      this.pinned = new Set();
      this.compressQueue = [];
      this.compressHandle = null;
      this.network = { total: 0, kept: 0, removed: 0, archiveCount: 0, conversationId: null, trimmed: false };
      this.domStats = { turns: 0, nodesPruned: 0, tracesCollapsed: 0 };
      this.observer = null;
      this.reconcileTimer = null;
      this.lastTraceScan = 0;
      this.route = location.href;
      this.dockHost = null;
      this.dockShadow = null;
      this.archiveHost = null;
      this.archiveShadow = null;
      this.archiveOffset = 0;
      this.archiveRequests = new Map();
      this.mutating = 0;
    }

    async init() {
      this.installBridgeListeners();
      const [syncSettings, localSettings] = await Promise.all([
        chrome.storage.sync.get(DEFAULT_SETTINGS),
        chrome.storage.local.get({ [THREAD_OVERRIDES_KEY]: {} })
      ]);
      this.settings = { ...DEFAULT_SETTINGS, ...syncSettings };
      this.threadOverrides = localSettings[THREAD_OVERRIDES_KEY] || {};
      this.sendConfig();
      this.applyRootClasses();
      this.installPageListeners();
      this.installObserver();
      this.ensureDock();
      this.scheduleReconcile(0);
    }

    installBridgeListeners() {
      window.addEventListener(PROXY_READY_EVENT, () => this.sendConfig());
      window.addEventListener(STATUS_EVENT, (event) => {
        if (typeof event.detail !== "string") return;
        try {
          const status = JSON.parse(event.detail);
          if (status.source !== "network") return;
          this.network = { ...this.network, ...status };
          this.updateDock();
        } catch {}
      });
      window.addEventListener(ARCHIVE_RESPONSE_EVENT, (event) => {
        if (typeof event.detail !== "string") return;
        try {
          const response = JSON.parse(event.detail);
          const pending = this.archiveRequests.get(response.requestId);
          if (!pending) return;
          this.archiveRequests.delete(response.requestId);
          pending.resolve(response);
        } catch {}
      });
    }

    installPageListeners() {
      document.addEventListener("visibilitychange", () => this.applyVisibilityState());
      document.addEventListener("click", (event) => this.onPageClick(event), true);
      window.addEventListener("popstate", () => this.onRouteMaybeChanged());

      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[THREAD_OVERRIDES_KEY]) {
          this.threadOverrides = changes[THREAD_OVERRIDES_KEY].newValue || {};
          this.scheduleReconcile(0);
          return;
        }
        if (area !== "sync") return;
        let changed = false;
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
          if (!changes[key]) continue;
          this.settings[key] = changes[key].newValue;
          changed = true;
        }
        if (!changed) return;
        this.sendConfig();
        this.applyRootClasses();
        this.ensureDock();
        this.scheduleReconcile(0);
      });

      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        this.handleRuntimeMessage(message).then(sendResponse).catch((error) => {
          sendResponse({ ok: false, error: String(error?.message || error) });
        });
        return true;
      });
    }

    installObserver() {
      this.observer = new MutationObserver((mutations) => {
        if (location.href !== this.route) this.onRouteMaybeChanged();
        if (this.mutating > 0) return;

        let relevant = false;
        for (const mutation of mutations) {
          const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
          if (!target) continue;
          if (target.closest?.("#cgo-performance-dock,#cgo-archive-viewer")) continue;
          relevant = true;
          break;
        }
        if (!relevant) return;

        this.scheduleReconcile();
        const now = performance.now();
        if (this.settings.autoCollapseTraces && now - this.lastTraceScan > TRACE_SCAN_INTERVAL) {
          this.lastTraceScan = now;
          setTimeout(() => this.collapseHeavyTraces(), 40);
        }
      });
      this.observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    currentConversationId() {
      try {
        const match = location.pathname.match(/\/c\/([^/?#]+)/) || location.pathname.match(/\/share\/([^/?#]+)/);
        return match?.[1] || this.network.conversationId || null;
      } catch {
        return this.network.conversationId || null;
      }
    }

    effectiveKeepCount() {
      const conversationId = this.currentConversationId();
      const override = conversationId ? Number(this.threadOverrides?.[conversationId]) : NaN;
      if (Number.isFinite(override) && override >= 1) return clamp(Math.round(override), 1, 200);
      return clamp(Number(this.settings.keepCount) || 30, 1, 200);
    }

    sendConfig() {
      window.dispatchEvent(new CustomEvent(CONFIG_EVENT, {
        detail: JSON.stringify({
          enabled: this.settings.enabled,
          mode: this.settings.mode,
          keepCount: clamp(Number(this.settings.keepCount) || 30, 1, 200)
        })
      }));
    }

    applyRootClasses() {
      const root = document.documentElement;
      root.classList.toggle("cgo-enabled", Boolean(this.settings.enabled));
      root.classList.toggle("cgo-long-response-virtualization", Boolean(this.settings.enabled && this.settings.longResponseVirtualization));
      root.classList.toggle("cgo-mode-extreme", this.settings.enabled && this.settings.mode === "extreme");
      this.applyVisibilityState();
    }

    applyVisibilityState() {
      document.documentElement.classList.toggle(
        "cgo-tab-hidden",
        Boolean(this.settings.enabled && this.settings.pauseHiddenRendering && document.hidden)
      );
    }

    onRouteMaybeChanged() {
      if (location.href === this.route) return;
      this.route = location.href;
      this.snapshots.clear();
      this.hibernated.clear();
      this.pinned.clear();
      this.network = { total: 0, kept: 0, removed: 0, archiveCount: 0, conversationId: null, trimmed: false };
      this.archiveOffset = 0;
      this.closeArchive();
      this.scheduleReconcile(80);
    }

    getTurns() {
      for (const selector of TURN_SELECTORS) {
        const nodes = [...document.querySelectorAll(selector)];
        if (nodes.length) return [...new Set(nodes)];
      }
      return [...document.querySelectorAll("main article, main section")].filter((node) =>
        node.querySelector('[data-message-author-role="user"],[data-message-author-role="assistant"]')
      );
    }

    turnKey(turn, index) {
      const stable = turn.getAttribute("data-testid") || turn.getAttribute("data-turn-id");
      if (stable) return stable;
      if (!turn.dataset.cgoKey) turn.dataset.cgoKey = `fallback:${Date.now()}:${index}:${Math.random().toString(36).slice(2, 8)}`;
      return turn.dataset.cgoKey;
    }

    isGenerating() {
      return Boolean(document.querySelector('button[data-testid="stop-button"],button[aria-label*="Stop generating" i],button[aria-label="Stop" i]'));
    }

    scheduleReconcile(delay = RECONCILE_DELAY) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = setTimeout(() => this.reconcile(), delay);
    }

    async reconcile() {
      const turns = this.getTurns();
      this.domStats.turns = turns.length;
      turns.forEach((turn, index) => {
        turn.dataset.cgoTurn = "1";
        turn.dataset.cgoIndex = String(index);
      });

      if (!this.settings.enabled || this.settings.mode === "safe") {
        await this.restoreAllFallback();
        this.recalculateDomStats();
        this.updateDock();
        return;
      }

      const keep = this.effectiveKeepCount();
      if (turns.length > keep) {
        const cutoff = Math.max(0, turns.length - keep);
        const generating = this.isGenerating();
        for (let index = 0; index < cutoff; index += 1) {
          const turn = turns[index];
          const key = this.turnKey(turn, index);
          if (this.pinned.has(key)) continue;
          if (generating && index >= turns.length - 2) continue;
          if (!this.hibernated.has(key)) this.hibernateTurn(turn, key, index);
          if (index > 0 && index % 15 === 0) await nextFrame();
        }
      }

      this.recalculateDomStats();
      this.updateDock();
    }

    hibernateTurn(turn, key, index) {
      if (turn.dataset.cgoHibernated === "1") return;
      const nodeCount = turn.getElementsByTagName("*").length;
      const text = (turn.innerText || turn.textContent || "").trim();
      const excerpt = text.replace(/\s+/g, " ").slice(0, 170);
      const role = turn.querySelector('[data-message-author-role="user"],[data-turn="user"]') ? "You" : "ChatGPT";

      let snapshot = this.snapshots.get(key);
      if (!snapshot) {
        snapshot = this.settings.mode === "extreme"
          ? { type: "text", text, role, excerpt, nodeCount }
          : { type: "html", html: turn.innerHTML, compressed: null, compressing: false, role, excerpt, nodeCount };
        this.snapshots.set(key, snapshot);
      }

      const box = document.createElement("div");
      box.className = "cgo-placeholder";
      const top = document.createElement("div");
      top.className = "cgo-placeholder__top";
      const label = document.createElement("span");
      label.className = "cgo-placeholder__label";
      label.textContent = `${role} · message ${index + 1} · optimized`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cgo-placeholder__button";
      button.dataset.cgoAction = "restore-turn";
      button.textContent = "Show";
      top.append(label, button);
      const excerptEl = document.createElement("div");
      excerptEl.className = "cgo-placeholder__excerpt";
      excerptEl.textContent = excerpt || "Older message";
      box.append(top, excerptEl);

      this.mutating += 1;
      try { turn.replaceChildren(box); } finally { this.mutating -= 1; }
      turn.dataset.cgoHibernated = "1";
      this.hibernated.add(key);

      if (snapshot.type === "html" && snapshot.html?.length >= COMPRESS_MIN_CHARS && !snapshot.compressed) {
        this.compressQueue.push(key);
        this.scheduleCompression();
      }
    }

    scheduleCompression() {
      if (this.compressHandle !== null || !this.compressQueue.length) return;
      this.compressHandle = runIdle(async () => {
        this.compressHandle = null;
        const key = this.compressQueue.shift();
        const snapshot = this.snapshots.get(key);
        if (snapshot?.type === "html" && snapshot.html && !snapshot.compressed && !snapshot.compressing) {
          snapshot.compressing = true;
          try {
            const bytes = await gzipString(snapshot.html);
            if (bytes && bytes.byteLength < snapshot.html.length * 0.92) {
              snapshot.compressed = bytes;
              snapshot.html = null;
            }
          } catch {} finally {
            snapshot.compressing = false;
          }
        }
        if (this.compressQueue.length) this.scheduleCompression();
      });
    }

    async restoreTurn(turn, key, pin = true) {
      const snapshot = this.snapshots.get(key);
      if (!snapshot || turn.dataset.cgoHibernated !== "1") return;
      if (pin) this.pinned.add(key);
      this.mutating += 1;
      try {
        if (snapshot.type === "text") {
          const text = document.createElement("div");
          text.className = "cgo-static-snapshot";
          text.textContent = snapshot.text;
          turn.replaceChildren(text);
          turn.dataset.cgoStaticSnapshot = "1";
        } else {
          const html = snapshot.html || (snapshot.compressed ? await gunzipString(snapshot.compressed) : null);
          if (html) restoreSanitizedHtml(turn, html);
        }
        delete turn.dataset.cgoHibernated;
        this.hibernated.delete(key);
      } finally {
        this.mutating -= 1;
      }
    }

    async restoreAllFallback() {
      const turns = this.getTurns();
      for (let index = 0; index < turns.length; index += 1) {
        const turn = turns[index];
        const key = this.turnKey(turn, index);
        if (this.hibernated.has(key)) await this.restoreTurn(turn, key, false);
        if (index > 0 && index % 10 === 0) await nextFrame();
      }
    }

    async showOlderFallback() {
      const turns = this.getTurns();
      const batch = clamp(Number(this.settings.batchSize) || 10, 1, 50);
      const candidates = [];
      for (let index = turns.length - 1; index >= 0 && candidates.length < batch; index -= 1) {
        const turn = turns[index];
        const key = this.turnKey(turn, index);
        if (this.hibernated.has(key)) candidates.unshift([turn, key]);
      }
      for (const [turn, key] of candidates) await this.restoreTurn(turn, key, true);
      candidates[0]?.[0]?.scrollIntoView({ block: "start", behavior: "smooth" });
      this.recalculateDomStats();
      this.updateDock();
    }

    collapseHeavyTraces() {
      if (!this.settings.enabled || !this.settings.autoCollapseTraces) return;
      const turns = this.getTurns().slice(-2);
      const threshold = this.settings.mode === "extreme" ? 70 : 170;

      for (const turn of turns) {
        if (turn.dataset.cgoHibernated === "1") continue;
        for (const details of turn.querySelectorAll("details[open]")) {
          const label = (details.querySelector(":scope > summary")?.textContent || "").trim();
          if (!TRACE_LABEL_RE.test(label)) continue;
          if (details.getElementsByTagName("*").length < threshold && (details.textContent?.length || 0) < 7_000) continue;
          details.open = false;
          this.domStats.tracesCollapsed += 1;
        }

        for (const button of turn.querySelectorAll('button[aria-expanded="true"]')) {
          if (button.dataset.cgoCollapsed === "1") continue;
          const label = (button.innerText || button.getAttribute("aria-label") || "").trim();
          if (!label || label.length > 160 || !TRACE_LABEL_RE.test(label)) continue;
          const container = button.parentElement?.parentElement || button.parentElement;
          if (!container) continue;
          const heavy = container.getElementsByTagName("*").length >= threshold || (container.textContent?.length || 0) >= 7_000;
          if (!heavy) continue;
          button.dataset.cgoCollapsed = "1";
          button.click();
          this.domStats.tracesCollapsed += 1;
        }
      }
      this.updateDock();
    }

    onPageClick(event) {
      const button = event.target instanceof Element ? event.target.closest('[data-cgo-action="restore-turn"]') : null;
      if (!button) return;
      const turn = button.closest('[data-cgo-turn="1"]');
      if (!turn) return;
      event.preventDefault();
      event.stopPropagation();
      const turns = this.getTurns();
      const index = turns.indexOf(turn);
      const key = this.turnKey(turn, index);
      this.restoreTurn(turn, key, true).then(() => {
        this.recalculateDomStats();
        this.updateDock();
      });
    }

    requestArchive(offset = 0) {
      const requestId = `req:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const limit = clamp(Number(this.settings.batchSize) || 10, 1, 50);
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          this.archiveRequests.delete(requestId);
          resolve({ requestId, total: 0, items: [], timeout: true });
        }, 900);
        this.archiveRequests.set(requestId, {
          resolve: (value) => { clearTimeout(timeout); resolve(value); }
        });
        window.dispatchEvent(new CustomEvent(ARCHIVE_REQUEST_EVENT, {
          detail: JSON.stringify({ requestId, offset, limit, conversationId: this.network.conversationId })
        }));
      });
    }

    async openArchive(offset = 0) {
      const result = await this.requestArchive(offset);
      if (!result?.items?.length && !(result?.total > 0)) {
        await this.showOlderFallback();
        return;
      }
      this.archiveOffset = offset;
      this.ensureArchiveViewer();
      this.renderArchive(result);
    }

    ensureArchiveViewer() {
      if (this.archiveHost?.isConnected) return;
      const host = document.createElement("div");
      host.id = "cgo-archive-viewer";
      host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483001;pointer-events:auto";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          :host{color-scheme:light dark}.backdrop{position:absolute;inset:0;background:rgba(0,0,0,.42);backdrop-filter:blur(4px)}.panel{position:absolute;top:18px;right:18px;bottom:18px;width:min(720px,calc(100vw - 36px));display:flex;flex-direction:column;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:20px;background:Canvas;color:CanvasText;box-shadow:0 24px 70px rgba(0,0,0,.3);font:13px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}.head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent)}.title{font-weight:750;font-size:14px}.range{margin-left:auto;opacity:.55;font-size:11px}.close{border:0;background:transparent;color:inherit;font-size:20px;cursor:pointer}.list{flex:1;overflow:auto;padding:14px;background:color-mix(in srgb,Canvas 97%,currentColor 3%)}.msg{content-visibility:auto;contain-intrinsic-size:auto 180px;margin:0 auto 12px;max-width:620px;padding:13px 14px;border:1px solid color-mix(in srgb,currentColor 10%,transparent);border-radius:14px;background:Canvas}.role{font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.55;margin-bottom:6px}.text{white-space:pre-wrap;overflow-wrap:anywhere}.more{margin-top:8px;border:0;background:transparent;color:#10a37f;font:inherit;font-weight:700;cursor:pointer;padding:0}.foot{display:flex;align-items:center;gap:8px;padding:11px 14px;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent)}button.nav{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:10px;padding:7px 10px;background:color-mix(in srgb,Canvas 90%,currentColor 10%);color:inherit;font:inherit;font-weight:700;cursor:pointer}button.nav:disabled{opacity:.35;cursor:not-allowed}.spacer{flex:1}.danger{opacity:.7}
        </style>
        <div class="backdrop" data-action="close"></div>
        <section class="panel" role="dialog" aria-modal="true" aria-label="Optimized older ChatGPT messages">
          <header class="head"><span>⚡</span><span class="title">Optimized history</span><span class="range">—</span><button class="close" data-action="close" aria-label="Close">×</button></header>
          <div class="list"></div>
          <footer class="foot"><button class="nav" data-action="older">← Earlier</button><button class="nav" data-action="newer">Newer →</button><span class="spacer"></span><button class="nav danger" data-action="full">Full ChatGPT history ↻</button></footer>
        </section>`;

      shadow.addEventListener("click", async (event) => {
        const actionEl = event.target instanceof Element ? event.target.closest("[data-action]") : null;
        if (!actionEl) return;
        const action = actionEl.getAttribute("data-action");
        const batch = clamp(Number(this.settings.batchSize) || 10, 1, 50);
        if (action === "close") this.closeArchive();
        if (action === "older") await this.openArchive(this.archiveOffset + batch);
        if (action === "newer") await this.openArchive(Math.max(0, this.archiveOffset - batch));
        if (action === "full") window.dispatchEvent(new CustomEvent(FULL_HISTORY_EVENT));
        if (action === "expand") {
          const index = Number(actionEl.getAttribute("data-index"));
          const textEl = shadow.querySelector(`[data-text-index="${index}"]`);
          const fullText = actionEl.__fullText;
          if (textEl && typeof fullText === "string") {
            textEl.textContent = fullText;
            actionEl.remove();
          }
        }
      });

      document.documentElement.append(host);
      this.archiveHost = host;
      this.archiveShadow = shadow;
    }

    renderArchive(result) {
      if (!this.archiveShadow) return;
      const list = this.archiveShadow.querySelector(".list");
      const range = this.archiveShadow.querySelector(".range");
      const older = this.archiveShadow.querySelector('[data-action="older"]');
      const newer = this.archiveShadow.querySelector('[data-action="newer"]');
      list.replaceChildren();

      result.items.forEach((item, index) => {
        const card = document.createElement("article");
        card.className = "msg";
        const role = document.createElement("div");
        role.className = "role";
        role.textContent = item.role === "user" ? "You" : item.role === "assistant" ? "ChatGPT" : item.role;
        const text = document.createElement("div");
        text.className = "text";
        text.dataset.textIndex = String(index);
        const full = String(item.text || "");
        const limit = 18_000;
        text.textContent = full.length > limit ? `${full.slice(0, limit)}\n\n…` : full || "(No text content)";
        card.append(role, text);
        if (full.length > limit) {
          const more = document.createElement("button");
          more.className = "more";
          more.dataset.action = "expand";
          more.dataset.index = String(index);
          more.textContent = `Show remaining ${(full.length - limit).toLocaleString()} characters`;
          more.__fullText = full;
          card.append(more);
        }
        list.append(card);
      });

      range.textContent = result.total ? `${result.start + 1}–${result.end} of ${result.total} optimized messages` : "No optimized history";
      older.disabled = !result.hasOlder;
      newer.disabled = !result.hasNewer;
      list.scrollTop = 0;
    }

    closeArchive() {
      this.archiveHost?.remove();
      this.archiveHost = null;
      this.archiveShadow = null;
    }

    recalculateDomStats() {
      let nodes = 0;
      for (const key of this.hibernated) nodes += this.snapshots.get(key)?.nodeCount || 0;
      this.domStats.nodesPruned = nodes;
    }

    getStatus() {
      this.recalculateDomStats();
      const liveDom = Math.max(0, this.domStats.turns - this.hibernated.size);
      const total = this.network.total || this.domStats.turns;
      const conversationId = this.currentConversationId();
      return {
        ok: true,
        enabled: this.settings.enabled,
        mode: this.settings.mode,
        keepCount: this.effectiveKeepCount(),
        threadOverride: Boolean(conversationId && Object.prototype.hasOwnProperty.call(this.threadOverrides, conversationId)),
        generating: this.isGenerating(),
        turns: this.domStats.turns,
        liveDom,
        domHibernated: this.hibernated.size,
        approxNodesSaved: this.domStats.nodesPruned,
        tracesCollapsed: this.domStats.tracesCollapsed,
        networkTotal: total,
        networkKept: this.network.kept || this.domStats.turns,
        networkRemoved: this.network.removed || 0,
        archiveCount: this.network.archiveCount || 0,
        networkTrimmed: Boolean(this.network.trimmed)
      };
    }

    async handleRuntimeMessage(message) {
      switch (message?.type) {
        case "CGO_GET_STATUS": return this.getStatus();
        case "CGO_OPTIMIZE_NOW":
          this.pinned.clear();
          await this.reconcile();
          return this.getStatus();
        case "CGO_OPEN_ARCHIVE":
          await this.openArchive(0);
          return this.getStatus();
        case "CGO_SHOW_LATEST":
          this.closeArchive();
          this.getTurns().at(-1)?.scrollIntoView({ block: "end", behavior: "smooth" });
          return this.getStatus();
        case "CGO_FULL_HISTORY":
          window.dispatchEvent(new CustomEvent(FULL_HISTORY_EVENT));
          return { ok: true, reloading: true };
        default: return { ok: false, error: "Unknown optimizer message" };
      }
    }

    ensureDock() {
      if (!this.settings.enabled || !this.settings.showDock) {
        this.dockHost?.remove();
        this.dockHost = null;
        this.dockShadow = null;
        return;
      }
      if (this.dockHost?.isConnected) return this.updateDock();

      const host = document.createElement("div");
      host.id = "cgo-performance-dock";
      host.style.cssText = "all:initial;position:fixed;right:18px;bottom:92px;z-index:2147483000;pointer-events:auto";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          :host{color-scheme:light dark}.dock{width:252px;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:16px;background:color-mix(in srgb,Canvas 94%,transparent);color:CanvasText;box-shadow:0 12px 32px rgba(0,0,0,.14);backdrop-filter:blur(14px);font:12px/1.35 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}.head{display:flex;align-items:center;gap:8px;padding:9px 10px;cursor:pointer;user-select:none}.bolt{display:grid;place-items:center;width:22px;height:22px;border-radius:7px;background:color-mix(in srgb,#10a37f 18%,Canvas);font-size:13px}.title{font-weight:700;flex:1}.metric{opacity:.66;font-variant-numeric:tabular-nums}.body{display:none;padding:0 10px 10px}.dock.open .body{display:block}.stats{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:3px 0 9px}.stat{padding:7px 8px;border-radius:10px;background:color-mix(in srgb,currentColor 6%,transparent)}.stat b{display:block;font-size:14px}.stat span{opacity:.62}.actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}button{appearance:none;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:10px;padding:7px 8px;background:color-mix(in srgb,Canvas 90%,currentColor 10%);color:inherit;font:inherit;font-weight:650;cursor:pointer}button:hover{background:color-mix(in srgb,Canvas 82%,currentColor 18%)}button.primary{background:#10a37f;color:white;border-color:transparent}.note{margin-top:8px;opacity:.55;font-size:11px}
        </style>
        <div class="dock"><div class="head" data-action="toggle"><span class="bolt">⚡</span><span class="title">Thread Optimizer</span><span class="metric">—</span></div><div class="body"><div class="stats"><div class="stat"><b data-stat="live">—</b><span>live React turns</span></div><div class="stat"><b data-stat="saved">—</b><span>history trimmed</span></div></div><div class="actions"><button data-action="older">Older history</button><button data-action="latest">Latest</button><button data-action="optimize" class="primary">Optimize now</button><button data-action="full">Full history ↻</button></div><div class="note" data-stat="mode">—</div></div></div>`;
      shadow.addEventListener("click", async (event) => {
        const actionEl = event.target instanceof Element ? event.target.closest("[data-action]") : null;
        if (!actionEl) return;
        const action = actionEl.getAttribute("data-action");
        if (action === "toggle") shadow.querySelector(".dock")?.classList.toggle("open");
        if (action === "older") await this.openArchive(0);
        if (action === "latest") await this.handleRuntimeMessage({ type: "CGO_SHOW_LATEST" });
        if (action === "optimize") await this.handleRuntimeMessage({ type: "CGO_OPTIMIZE_NOW" });
        if (action === "full") window.dispatchEvent(new CustomEvent(FULL_HISTORY_EVENT));
      });
      document.documentElement.append(host);
      this.dockHost = host;
      this.dockShadow = shadow;
      this.updateDock();
    }

    updateDock() {
      if (!this.dockShadow) return;
      const status = this.getStatus();
      const metric = this.dockShadow.querySelector(".metric");
      const live = this.dockShadow.querySelector('[data-stat="live"]');
      const saved = this.dockShadow.querySelector('[data-stat="saved"]');
      const note = this.dockShadow.querySelector('[data-stat="mode"]');
      if (metric) metric.textContent = `${status.liveDom}/${status.networkTotal || status.turns}`;
      if (live) live.textContent = status.liveDom.toLocaleString();
      if (saved) saved.textContent = (status.networkRemoved + status.domHibernated).toLocaleString();
      if (note) {
        const source = status.networkTrimmed ? "pre-React trim active" : status.mode === "safe" ? "containment only" : "DOM fallback active";
        note.textContent = `${status.mode[0].toUpperCase()}${status.mode.slice(1)} · ${source}${status.threadOverride ? ` · ${status.keepCount}-message thread limit` : ""}${status.generating ? " · streaming" : ""}`;
      }
    }
  }

  const optimizer = new Optimizer();
  optimizer.init().catch((error) => console.error("[ChatGPT Thread Optimizer] init failed", error));
})();