# Discord Manual Export

A tiny Chrome extension that captures Discord messages **as you scroll a channel by hand**, then exports them to JSON or a clean text transcript.

It reads only what's already on your screen — no automation, no network requests, no page injection.

## Why it's safe

- **Nothing is sent anywhere.** Messages stay in memory until *you* export them to a local file.
- **No automation.** You scroll; it just watches. Same footprint as reading the channel normally.
- **No page injection** (by default). The UI lives entirely in the toolbar popup — nothing is added to Discord's page.
- **Minimal permissions.** Only `scripting` + `activeTab` (used solely by the opt-in High-fidelity toggle below), plus a content script limited to Discord pages. With the toggle off, the extension is pure read-the-DOM and nothing extra runs.

## High-fidelity mode (optional, off by default)

A toggle in the popup that reads Discord's own in-page data (React state) to add **exact @handles** and **exact reply links — including replies to images/GIFs**, which the rendered page alone can't provide.

- It injects a small **read-only** script into the page **only while the toggle is on** (off = nothing in the page, same as the default).
- It makes **no network requests** and **patches nothing** — it only reads state Discord already loaded.
- It's written so it can **never** surface an error into Discord's telemetry (every path is wrapped; it never throws or logs).
- **Data flows over a private `MessagePort`.** No export data is broadcast over repeated `window.postMessage`; the only thing on the shared bus is a **single, data-less handshake** keyed by a **random per-session nonce** (no static marker). Honest caveat: that handshake transfers the port, which is briefly exposed in the event's `ports` to any `message` listener — so this hides the data from *passive/ordinary* listeners, but it is **not** a hard confidentiality boundary against page code that specifically hooks transferred ports. Real data only touches the window bus at all if the cross-world port transfer fails (a timeout-gated fallback).
- Trade-off vs. the pure-DOM default: it runs in the page context, sharing Discord's JS environment. That's low-signal and non-specific in practice, but **not** the hard isolated-world guarantee of the default — anything Discord has already instrumented in the page (e.g. wrapped `addEventListener`) could in principle observe corresponding behavior, and it's more fragile to Discord front-end updates. **DOM-only (toggle off) remains the lowest-surface mode.**

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Pin the extension and open Discord.

## Usage

1. Open a channel or DM.
2. Click the extension icon → **Start capture**.
3. Scroll up through the history at your own pace.
4. Click **Download JSON** or **Download Text**.

The counter updates live while the popup is open, and capture keeps running in the tab even if you close it.

## Export formats

**JSON** — structured, with CDN urls + filenames for media:

```json
{
  "author": "k",
  "authorId": "123456789012345678",
  "timestamp": "2025-07-12T06:50:03.120Z",
  "editedTimestamp": null,
  "content": "won't happen again",
  "media": [{ "type": "image", "url": "https://cdn.discordapp.com/.../pic.png", "filename": "pic.png" }],
  "stickers": [{ "id": "144...", "name": "smirking chess guy", "format": "Png", "url": "https://media.discordapp.net/stickers/144....webp" }],
  "embeds": [{ "title": "...", "url": "https://...", "description": "...", "provider": "..." }],
  "mentions": ["tetron"],
  "reactions": [{ "emoji": "👍", "count": 1 }],
  "replyTo": { "author": "tetron", "content": "jesus christ its annoying", "messageId": "123..." }
}
```

(`username` is added when High-fidelity mode is on.)

**Text** — a readable transcript:

```
=== Saturday, Jul 12, 2025 ===

[1:50 AM] k:
  greetings

[+1m] k:
  > tetron: jesus christ its annoying
  won't happen again ^{👍:1}
  [IMG]
```

A `=== date ===` header is emitted per day; the first message of a day shows an absolute time, later ones a relative delta (`+4s`, `+1m`, `+2h`). Same-author runs are grouped; replies quote the original; media becomes `[IMG]` / `[VIDEO]` / `[GIF]` / `[FILE]`.

**DCE JSON** — a best-effort match of [DiscordChatExporter](https://github.com/Tyrrrz/DiscordChatExporter)'s schema, so it drops into tools that read DCE exports (test against your consumer). Includes role colors, embeds, stickers, and mentions. Attachment sizes/ids are left empty. Reply links resolve from the DOM, and exactly — including replies to media — in High-fidelity mode.

## Notes

- `authorId` is recovered from the avatar URL, so users on the default avatar (no custom image) won't have one.
- In DCE JSON, `author.name` is the account @handle and `nickname` is the display name. The handle is only scraped where Discord shows it (DM header, your account panel), so in server channels it falls back to the display name.
- Selectors follow Discord's current DOM, so a major Discord update may need a tweak.
- For personal use. Automating exports pushes against Discord's ToS — keep it as an unpacked extension rather than publishing it.
