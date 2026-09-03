# Privacy

ChatGPT Thread Optimizer is designed to be local-only.

- It runs only on `chatgpt.com` and the legacy `chat.openai.com` domain.
- It makes **no external network requests** of its own.
- It has no analytics, telemetry, tracking, ads, or remote code.
- Extension preferences are stored with `chrome.storage.sync` so they can follow your Chrome profile.
- When a long conversation is trimmed, the extension keeps only a lightweight in-memory text archive of the removed visible messages so you can browse them lazily. That archive is not written to extension storage and disappears when the page is closed or reloaded.
- The extension does not modify or delete the conversation stored by ChatGPT on the server. It only changes the history response that the browser-side ChatGPT app receives for rendering.

## Permissions

`storage` is used for extension preferences. `activeTab` is used by the popup to talk to the currently open ChatGPT tab. Host access is limited to ChatGPT domains so the content scripts can optimize those pages.
