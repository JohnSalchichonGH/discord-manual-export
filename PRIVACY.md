# Privacy

Plain-language summary of how this extension handles data.

- It reads Discord message content that is **already rendered in your browser tab**, and only while you have pressed **Start capture**.
- Captured messages are held **in memory in that tab** (a JavaScript `Map`). Nothing is written to disk unless **you** click an export button, which saves a file locally.
- It makes **no network requests** of its own — no servers, no analytics, no telemetry, no error reporting, no remote code.
- It does **not** read tokens, cookies, passwords, or credentials, and does **not** call Discord's API.
- It does **not** persist anything across sessions (no `localStorage`, `sessionStorage`, `IndexedDB`, or `chrome.storage`). Close the tab and the in-memory capture is gone.

## What an export can contain

A downloaded export may include: message text, display names, user IDs, @handles (in High-fidelity mode), avatar/media URLs, timestamps, edit times, reactions, reply relationships, stickers, embeds, and channel metadata. Treat exports as sensitive and don't redistribute other people's messages.

## High-fidelity mode

The optional High-fidelity toggle injects a **read-only** script into the page's main JavaScript world to read Discord's own message objects (React state). It still makes no network requests and stores nothing — but it is a different trust boundary than the default isolated-world mode. It is **off by default**.

This is enforced as far as source review can: see [`check-safety.js`](check-safety.js), a guardrail that fails if any network/persistence/remote-code API appears in the scripts.
