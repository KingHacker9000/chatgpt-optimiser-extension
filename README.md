# ⚡ ChatGPT Thread Optimizer

A Chrome MV3 extension for people with **very long ChatGPT conversations** that eventually eat gigabytes of RAM, make typing/scrolling lag, or crash the tab.

Instead of merely hiding old messages with CSS, the optimizer trims old history **before ChatGPT's React app renders it**, keeps only the last N visible messages live, and exposes older history through a lightweight lazy viewer. It also has a separate set of protections for the other bad case: one enormous assistant response with lots of thinking/tool activity.

> Unofficial community extension. Not affiliated with or endorsed by OpenAI.

## What it does

### 1. Prevents huge histories from entering React

On a conversation history GET, the extension intercepts the browser-side response at `document_start`, follows the active conversation branch, and keeps only the configured tail (30 visible messages by default).

The conversation stored on ChatGPT's servers is not deleted or shortened. Only the copy being handed to the browser UI is trimmed.

### 2. Lazy-loads old history without re-bloating ChatGPT

Trimmed messages are reduced to a lightweight in-memory text archive. Click **Older history** to browse them in batches in a Shadow DOM drawer. Going farther back replaces the current batch instead of mounting hundreds of React components.

### 3. Handles a single gigantic live reply

Long tool/reasoning runs can lag even with a short thread. The extension also:

- virtualizes individual off-screen Markdown blocks with `content-visibility`;
- auto-collapses only **large** expanded thinking/tool trace sections using ChatGPT's own controls;
- adds CSS containment around tool/reasoning sections;
- skips conversation rendering entirely while the tab is hidden (generation can continue);
- removes turn animations/transitions in Extreme mode.

### 4. Falls back on already-loaded tabs

If a thread was already open before the pre-React proxy got a chance to trim it, the content script can hibernate excess old turn contents into tiny placeholders. Turbo keeps compressed/restorable HTML snapshots; Extreme keeps text-only snapshots for lower memory use.

## Modes

| Mode | Pre-React trim | Old-history viewer | DOM fallback | Best for |
| --- | --- | --- | --- | --- |
| **Safe** | No | No trim archive | No destructive pruning | Maximum compatibility; paint/layout relief only |
| **Turbo** | Yes | Yes | Restorable + compressed snapshots | Recommended default |
| **Extreme** | Yes | Yes | Text-only snapshots + aggressive trace compaction | Worst-case tabs / minimum RAM |

## Install from source

1. Download or clone this repository.
2. Open `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this repository folder.
6. Reload any ChatGPT tabs that were already open so the `document_start` fetch proxy can activate before ChatGPT loads the thread.

No build step or dependencies are required to run the extension.

## Usage

Open the extension popup while on ChatGPT:

- **Messages kept in React** controls the live history window (5–200).
- **Older history** opens the lazy archive viewer.
- **Optimize now** hibernates excess DOM that accumulated after page load.
- **Jump latest** closes the archive viewer and returns to the current response.
- **Full history ↻** bypasses trimming for one reload and asks ChatGPT to render the complete history. Use this sparingly on huge threads because it intentionally brings the original performance problem back.

The optional in-page dock exposes the same high-frequency actions without opening the popup.

## Why this is stronger than `display: none`

CSS can skip paint/layout, and `content-visibility` is very useful for that, but keeping thousands of mounted React components still costs memory. The primary optimization therefore acts one level earlier: it rewrites only the browser's conversation-history response so old nodes never enter the React tree in the first place.

The DOM hibernator is deliberately a fallback rather than the main mechanism.

## Fail-safe behavior

ChatGPT is a private, frequently changing web app, so the extension treats every optimization as optional:

- only exact conversation-history GET routes are intercepted;
- non-JSON and unrecognized payloads pass through untouched;
- malformed or cyclic conversation mappings pass through untouched;
- non-conversation `/backend-api/*` calls are ignored;
- full-history mode is available as a one-reload escape hatch;
- the stable `data-testid` / `data-message-author-role` attributes are preferred over volatile CSS classes for DOM fallbacks.

## Privacy

No analytics, telemetry, ads, trackers, or external network requests. Settings are stored with Chrome Sync. Removed old-message text is held only in page memory for the lazy viewer and disappears on reload/close. See [PRIVACY.md](PRIVACY.md).

## Development

There is no bundler. Source files are plain JavaScript so the unpacked extension is the same code you review in GitHub.

```bash
npm test
npm run check
```

`npm test` exercises active-branch trimming, hidden-node preservation, archive behavior, and malformed-payload fail-safes with Node's built-in test runner.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the detailed design.

## Current limitations

- ChatGPT can change private endpoints or DOM structure without notice; this may require selector/route updates.
- The lazy older-history viewer is intentionally text-first. It does not recreate every interactive widget, image, citation card, or tool UI from old messages.
- A tab that has already loaded the full React history cannot retroactively get the same RAM reduction as a fresh pre-React trim without reloading. The DOM fallback still reduces live rendering complexity.
- **Full history** intentionally disables the main optimization for one reload and can become slow on very large conversations.

## License

MIT
