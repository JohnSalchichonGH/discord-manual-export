# Discord Manual Export

A tiny Chrome extension that captures Discord messages **as you scroll a channel by hand**, then exports them to JSON or a clean text transcript.

It reads only what's already on your screen — no automation, no network requests, and no main-world page injection by default.

## Why it's safe

- **Nothing is sent anywhere.** Messages stay in memory until *you* export them to a local file.
- **No automation.** You scroll; it just watches. Same footprint as reading the channel normally.
- **No main-world injection or DOM modification** (by default). Only an isolated-world content script runs on Discord pages — it reads the rendered DOM and adds nothing to the page. The UI lives entirely in the toolbar popup.
- **Minimal permissions.** Only `scripting` + `activeTab` (used solely by the opt-in High-fidelity toggle below), plus a content script limited to Discord pages. With the toggle off, the extension is pure read-the-DOM and nothing extra runs.

## High-fidelity mode (optional, off by default)

A toggle in the popup that reads Discord's own in-page data (React state) to add **exact @handles** and **exact reply links — including replies to images/GIFs**, which the rendered page alone can't provide.

- It injects a small **read-only** script into the page **only while the toggle is on** (off = nothing in the page, same as the default).
- It makes **no network requests** and **patches nothing** — it only reads state Discord already loaded.
- It's written so it can **never** surface an error into Discord's telemetry (every path is wrapped; it never throws or logs).
- **Data flows over a private `MessagePort`, and only that.** No export data ever touches the shared `window` bus; the only thing on it is a **single, data-less handshake** keyed by a **random per-session nonce** (no static marker). If the cross-world port transfer fails, high-fidelity is simply reported **unavailable on that tab (fail closed)** and DOM-only capture continues — it never falls back to putting data on the window bus. Honest caveat: the handshake transfers the port, which is briefly exposed in the event's `ports` to any `message` listener, so this hides the *data* from passive listeners but isn't a hard boundary against page code that specifically hooks transferred ports.
- Turning it **off** stops further page-world reading, but fields it already enriched stay in the capture (and export) — this is reported in the JSON's `captureQuality.highFidelityDataCaptured`. Use **Clear** to drop them.
- Trade-off vs. the pure-DOM default: it runs in the page context, sharing Discord's JS environment. That's low-signal and non-specific in practice, but **not** the hard isolated-world guarantee of the default — anything Discord has already instrumented in the page (e.g. wrapped `addEventListener`) could in principle observe corresponding behavior, and it's more fragile to Discord front-end updates. **DOM-only (toggle off) remains the lowest-surface mode.**

## Safety contract

This extension will **never**:

- read Discord auth tokens or account credentials
- call Discord's API, or make **any** network request
- patch `fetch` / `XHR` / `WebSocket`, or other page APIs
- auto-scroll, auto-click, or bypass rate limits
- upload exports, send telemetry, or load remote code
- persist captured messages anywhere except a file **you** download

This is **guarded** (a regression guard, not a formal proof) by [`check-safety.js`](check-safety.js), which fails if any network / persistence / remote-code / privileged-API pattern appears in the shipped files. Run it with `node check-safety.js` (or `npm test`). See also [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

Exports may contain private messages, user IDs, media URLs, timestamps, reactions, and reply relationships. **Before exporting:** you're a participant (or have permission to archive), you understand exports include private content, and you won't redistribute other people's private messages without consent.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Pin the extension and open Discord.

## Usage

1. Open a channel or DM.
2. Click the extension icon → **Start capture**.
3. Scroll up through the history at your own pace.
4. Under **Export**, click **JSON**, **Text**, or **DCE** to download.

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

- **Media URLs can expire.** Attachment URLs are copied exactly as Discord renders them, and Discord's CDN links are signed with an expiry (`?ex=…&is=…&hm=…`). They work now but may stop working later — if you want a permanent archive, download the files separately while the links are valid.
- `authorId` is recovered from the avatar URL, so users on the default avatar (no custom image) won't have one (High-fidelity mode gets it for everyone).
- In DCE JSON, `author.name` is the account @handle and `nickname` is the display name. The handle is only scraped where Discord shows it (DM header, your account panel), so in server channels it falls back to the display name unless High-fidelity mode is on.
- Selectors follow Discord's current DOM, so a major Discord update may need a tweak.
- **Personal use — and still policy-sensitive.** Discord's Terms prohibit scraping the service without written consent (including via software/processes), so this **may violate Discord's Terms even for personal use** — understand the account/platform risk. Don't redistribute other people's private messages. Keep it an unpacked extension for yourself; public distribution would also need a privacy policy and disclosures.
