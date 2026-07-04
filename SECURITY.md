# Security & threat model

A short, honest model of what this tool is and isn't.

## Assets (what an export can expose)

Message content, display names, user IDs, @handles, avatar/media URLs, timestamps, edit times, reactions, reply relationships, stickers, embeds, channel metadata.

## Non-goals (things this tool will not do)

- No automation: no auto-scroll, auto-click, or rate-limit bypass.
- No Discord API calls, token/cookie/credential access, or self-botting.
- No accessing deleted or never-loaded messages, or circumventing permissions/visibility.
- No automatic media downloading, cloud sync, analytics, remote config, or "stealth"/detection-evasion.
- No silent persistence — captured data lives in memory until you download an export.

## Trust boundaries

1. **Extension popup** (extension context) — builds/downloads files locally.
2. **Isolated-world content script** (`content.js`) — the default; reads the rendered DOM, invisible to page JS.
3. **Optional main-world reader** (`fiber-reader.js`) — only when High-fidelity is on; shares Discord's JS world to read React state, read-only. Data returns over a private `MessagePort` and never over the shared `window` bus; if the port transfer fails it is reported unavailable (fail closed).
4. **Discord page JavaScript** — untrusted from our perspective; we only read from it.
5. **The downloaded export file** — becomes your responsibility once saved.

## Known limitations

- **DOM/React fragility.** Selectors depend on Discord's current markup; a front-end update can break extraction. This is surfaced (not hidden) via the popup health warning and the `captureQuality` block in the JSON export, rather than silently producing bad data.
- **Media URLs expire.** Discord CDN links are signed with an expiry; exported URLs may stop working later. Download media separately for a durable archive.
- **Large captures.** Exports are built as a single string in memory, so extremely large captures (tens of thousands of messages) can be memory-heavy. Realistic manual-scroll captures are well within bounds; there is no chunked/streamed export.
- **Platform policy.** See the README — capturing/exporting may be restricted by Discord's Terms even for personal use.

## Enforcement

[`check-safety.js`](check-safety.js) is a source-level guardrail (regex heuristic, run via `npm test`, and in CI on every push/PR) that fails if a network/persistence/remote-code/privileged-API pattern appears in the shipped files. It is a regression guard, **not** a formal proof.

## Reporting a vulnerability

If you find a security or privacy issue, please report it **privately** — don't open a public issue.

- Preferred: GitHub's private vulnerability reporting — the **Security** tab → **Report a vulnerability** (opens a private advisory only the maintainer can see).
- Please include what you found, how to reproduce it, and the impact you have in mind.

Scope note: because the extension makes no network requests and stores nothing, the realistic issue classes are local (e.g. a way the capture could read more than the rendered DOM it's scoped to, or the High-fidelity reader leaking data off its private `MessagePort`). There's no server, backend, or hosted component to report against. This is a personal project with no SLA, but genuine reports will be looked at.
