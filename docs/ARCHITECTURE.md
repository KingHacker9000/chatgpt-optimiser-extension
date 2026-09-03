# Architecture

The extension uses a layered approach because long ChatGPT tabs have two different failure modes: huge reopened histories and a single live response that grows for a long time.

## 1. Pre-React history trimming

`src/interceptor.js` runs at `document_start` in Chrome's `MAIN` world and wraps `window.fetch` before the ChatGPT application starts loading conversation history. For GET requests matching `/backend-api/conversation/{id}` (and shared-conversation equivalents), it:

1. Clones and parses the JSON response.
2. Walks the active branch backward from `current_node`.
3. Counts visible user/assistant role transitions rather than raw internal nodes.
4. Keeps the configured tail while preserving hidden system/tool/thinking nodes that belong to the surviving suffix.
5. Rebuilds parent/children links and returns the smaller response to ChatGPT.
6. Keeps the removed visible text as an in-memory archive for the lazy history viewer.

If parsing or tree validation fails, the original response is returned untouched.

## 2. Lazy optimized history viewer

Removed history is never pushed back into React. The isolated content script requests small batches from the MAIN-world archive and renders them inside a Shadow DOM drawer as plain text. Only the current page of old messages exists as DOM.

## 3. DOM fallback

If a tab was already open before the extension loaded, or the conversation grows beyond the configured live window after initial load, `src/content.js` can replace old turn contents with tiny placeholders. Turbo keeps sanitized/restorable HTML snapshots and compresses large snapshots with `CompressionStream`; Extreme keeps text-only snapshots.

This fallback mainly reduces live layout/paint complexity. The pre-React interceptor is the primary RAM optimization because it prevents old React components from being created at all.

## 4. Giant single-response protection

A single assistant turn can become expensive even when history is short. The extension therefore:

- applies `content-visibility: auto` to individual Markdown blocks;
- adds containment around tool/reasoning sections;
- periodically collapses only very large expanded thinking/tool sections through ChatGPT's own UI controls;
- uses `content-visibility: hidden` for conversation turns while the tab itself is hidden;
- disables turn animations/transitions in Extreme mode.

## 5. Worlds and communication

The fetch proxy must run in `MAIN` world to patch the page's own `window.fetch`. The UI/content script stays in Chrome's default isolated world so extension APIs remain separated from page JavaScript. The two sides exchange JSON strings through narrowly named `CustomEvent`s.
