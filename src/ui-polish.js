(() => {
  "use strict";

  const DOCK_ID = "cgo-performance-dock";
  const ARCHIVE_ID = "cgo-archive-viewer";
  const STYLE_ID = "cgo-ui-polish";

  const DOCK_CSS = `
    :host {
      --cgo-bg: rgba(250,250,249,.95);
      --cgo-soft: rgba(0,0,0,.045);
      --cgo-fg: #202123;
      --cgo-muted: #6f6f6f;
      --cgo-border: rgba(0,0,0,.11);
      --cgo-hover: rgba(0,0,0,.075);
      --cgo-accent: #10a37f;
      color-scheme: light;
    }
    :host([data-cgo-theme="dark"]) {
      --cgo-bg: rgba(31,31,31,.95);
      --cgo-soft: rgba(255,255,255,.065);
      --cgo-fg: #ececec;
      --cgo-muted: #a6a6a6;
      --cgo-border: rgba(255,255,255,.12);
      --cgo-hover: rgba(255,255,255,.10);
      color-scheme: dark;
    }
    .dock {
      width: 232px !important;
      border: 1px solid var(--cgo-border) !important;
      border-radius: 16px !important;
      background: var(--cgo-bg) !important;
      color: var(--cgo-fg) !important;
      box-shadow: 0 10px 36px rgba(0,0,0,.18) !important;
      backdrop-filter: blur(18px) saturate(1.12) !important;
      -webkit-backdrop-filter: blur(18px) saturate(1.12) !important;
      transition: width .16s ease, opacity .16s ease, transform .16s ease, border-radius .16s ease !important;
    }
    .dock:not(.open) {
      width: 40px !important;
      height: 42px !important;
      border-right: 0 !important;
      border-radius: 13px 0 0 13px !important;
      opacity: .56;
      overflow: hidden !important;
      box-shadow: 0 5px 18px rgba(0,0,0,.12) !important;
    }
    .dock:not(.open):hover,.dock:not(.open):focus-within { opacity: .96; }
    .dock.open { margin-right: 12px; opacity: 1; }
    .head { min-height: 42px; padding: 8px 10px !important; gap: 8px !important; }
    .dock:not(.open) .head {
      width: 40px; height: 42px; min-height: 42px;
      padding: 7px 7px 7px 8px !important; justify-content: center;
    }
    .dock:not(.open) .title,.dock:not(.open) .metric { display: none !important; }
    .bolt {
      width: 26px !important; height: 26px !important; flex: 0 0 26px;
      border-radius: 9px !important;
      background: color-mix(in srgb,var(--cgo-accent) 16%,transparent) !important;
      color: var(--cgo-accent) !important; font-size: 13px !important;
    }
    .title { font-size: 12px; font-weight: 680 !important; letter-spacing: -.01em; }
    .metric { color: var(--cgo-muted); font-size: 10px; opacity: 1 !important; }
    .body { padding: 0 9px 9px !important; }
    .stats { gap: 5px !important; margin: 2px 0 7px !important; }
    .stat {
      padding: 7px 8px !important; border: 1px solid var(--cgo-border);
      border-radius: 10px !important; background: var(--cgo-soft) !important;
    }
    .stat b { font-size: 13px !important; font-weight: 680; }
    .stat span { color: var(--cgo-muted); font-size: 9.5px; opacity: 1 !important; }
    .actions { gap: 5px !important; }
    button {
      min-height: 30px; border: 1px solid var(--cgo-border) !important;
      border-radius: 9px !important; padding: 6px 7px !important;
      background: transparent !important; color: var(--cgo-fg) !important;
      font-size: 10.5px !important; font-weight: 620 !important;
    }
    button:hover { background: var(--cgo-hover) !important; }
    button.primary {
      background: var(--cgo-accent) !important; color: #fff !important;
      border-color: transparent !important;
    }
    .note { margin-top: 7px !important; color: var(--cgo-muted); opacity: 1 !important; font-size: 9.5px !important; }
  `;

  const ARCHIVE_CSS = `
    :host {
      --cgo-bg: #fff; --cgo-panel: #fff; --cgo-soft: #f7f7f7;
      --cgo-fg: #202123; --cgo-muted: #6f6f6f; --cgo-border: rgba(0,0,0,.11);
      --cgo-accent: #10a37f; color-scheme: light;
    }
    :host([data-cgo-theme="dark"]) {
      --cgo-bg: #171717; --cgo-panel: #212121; --cgo-soft: #181818;
      --cgo-fg: #ececec; --cgo-muted: #a6a6a6; --cgo-border: rgba(255,255,255,.12);
      color-scheme: dark;
    }
    .backdrop { background: rgba(0,0,0,.48) !important; backdrop-filter: blur(2px) !important; }
    .panel {
      top: 14px !important; right: 14px !important; bottom: 14px !important;
      width: min(680px,calc(100vw - 28px)) !important;
      border: 1px solid var(--cgo-border) !important; border-radius: 18px !important;
      background: var(--cgo-panel) !important; color: var(--cgo-fg) !important;
      box-shadow: 0 24px 80px rgba(0,0,0,.36) !important;
    }
    .head,.foot { border-color: var(--cgo-border) !important; }
    .head { min-height: 52px; padding: 11px 14px !important; }
    .title { font-size: 13px !important; letter-spacing: -.01em; }
    .range { color: var(--cgo-muted); opacity: 1 !important; }
    .close { color: var(--cgo-muted) !important; border-radius: 8px; }
    .close:hover { background: var(--cgo-soft) !important; color: var(--cgo-fg) !important; }
    .list { background: var(--cgo-bg) !important; padding: 14px !important; }
    .msg {
      border: 1px solid var(--cgo-border) !important; border-radius: 13px !important;
      background: var(--cgo-panel) !important; padding: 12px 13px !important;
      box-shadow: none !important;
    }
    .role { color: var(--cgo-muted); opacity: 1 !important; }
    .more { color: var(--cgo-accent) !important; }
    .foot { padding: 10px 12px !important; background: var(--cgo-panel); }
    button.nav {
      border: 1px solid var(--cgo-border) !important; border-radius: 9px !important;
      background: transparent !important; color: var(--cgo-fg) !important;
      padding: 7px 10px !important;
    }
    button.nav:hover { background: var(--cgo-soft) !important; }
  `;

  function isDark() {
    const root = document.documentElement;
    const body = document.body;
    if (root.classList.contains("dark") || body?.classList.contains("dark")) return true;
    const scheme = getComputedStyle(root).colorScheme || "";
    if (scheme.includes("dark") && !scheme.includes("light")) return true;
    const sample = body || root;
    const match = getComputedStyle(sample).backgroundColor.match(/[\d.]+/g);
    if (match?.length >= 3) {
      const [r,g,b] = match.slice(0,3).map(Number);
      return (0.2126*r + 0.7152*g + 0.0722*b) < 128;
    }
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function injectStyle(shadow, css) {
    if (!shadow || shadow.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    shadow.append(style);
  }

  function applyTheme(host) {
    if (!host) return;
    host.setAttribute("data-cgo-theme", isDark() ? "dark" : "light");
  }

  function polishDock(host) {
    const shadow = host?.shadowRoot;
    if (!shadow) return;
    injectStyle(shadow, DOCK_CSS);
    host.style.right = "0";
    host.style.bottom = "104px";
    host.style.pointerEvents = "auto";
    host.style.transition = "opacity .16s ease";
    host.setAttribute("aria-label", "Thread Optimizer quick controls");
    applyTheme(host);

    const head = shadow.querySelector(".head");
    if (head) {
      head.setAttribute("role", "button");
      head.setAttribute("tabindex", "0");
      head.setAttribute("title", "Thread Optimizer");
      head.setAttribute("aria-label", "Open Thread Optimizer controls");
      if (head.dataset.cgoKeyboardBound !== "1") {
        head.dataset.cgoKeyboardBound = "1";
        head.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            head.click();
          }
        });
      }
    }
  }

  function polishArchive(host) {
    const shadow = host?.shadowRoot;
    if (!shadow) return;
    injectStyle(shadow, ARCHIVE_CSS);
    applyTheme(host);
  }

  function refresh() {
    polishDock(document.getElementById(DOCK_ID));
    polishArchive(document.getElementById(ARCHIVE_ID));
  }

  function collapseDock() {
    document.getElementById(DOCK_ID)?.shadowRoot?.querySelector(".dock.open")?.classList.remove("open");
  }

  document.addEventListener("pointerdown", (event) => {
    const host = document.getElementById(DOCK_ID);
    const open = host?.shadowRoot?.querySelector(".dock.open");
    if (!host || !open) return;
    if (!event.composedPath().includes(host)) open.classList.remove("open");
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") collapseDock();
  }, true);

  const hostObserver = new MutationObserver(refresh);
  hostObserver.observe(document.documentElement, { childList: true });

  const themeObserver = new MutationObserver(refresh);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  if (document.body) themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  else document.addEventListener("DOMContentLoaded", () => themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme"] }), { once: true });

  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", refresh);
  refresh();
})();
