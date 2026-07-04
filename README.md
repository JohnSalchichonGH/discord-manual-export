# Discord Manual Export

A tiny Chrome extension that captures Discord messages **as you scroll a channel by hand**, then exports them to JSON or a clean text transcript.

It reads only what's already on your screen — no automation, no network requests, no page injection.

## Why it's safe

- **Nothing is sent anywhere.** Messages stay in memory until *you* export them to a local file.
- **No automation.** You scroll; it just watches. Same footprint as reading the channel normally.
- **No page injection.** The UI lives entirely in the toolbar popup — nothing is added to Discord's page.
- **No permissions.** The manifest requests none, so the page can't even tell it's installed.

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
  "timestamp": "2025-07-12T06:50:03.120Z",
  "content": "won't happen again",
  "media": [{ "type": "image", "url": "https://cdn.discordapp.com/.../pic.png", "filename": "pic.png" }],
  "reactions": [{ "emoji": "👍", "count": 1 }],
  "replyTo": { "author": "tetron", "content": "jesus christ its annoying" }
}
```

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

A `=== date ===` header is emitted per day; the first message of a day shows an absolute time, later ones a relative delta (`+4s`, `+1m`, `+2h`). Same-author runs are grouped; replies quote the original; media becomes `[IMG]` / `[VIDEO]` / `[FILE]`.

## Notes

- `author` is the display name — Discord doesn't expose user IDs in the DOM.
- Selectors follow Discord's current DOM, so a major Discord update may need a tweak.
- For personal use. Automating exports pushes against Discord's ToS — keep it as an unpacked extension rather than publishing it.
