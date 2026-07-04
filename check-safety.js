/*
 * Safety guardrail (not a proof). Fails if any shipped file contains a
 * network / persistence / remote-code / privileged-API pattern. This backs the
 * README's "will never" contract. Run: `node check-safety.js` (or `npm test`).
 *
 * It is a regex heuristic over the source — a guardrail against regressions and
 * obvious exfiltration, not a formal security proof.
 */
const fs = require("fs");
const path = require("path");

const files = [
  "manifest.json",
  "popup.html",
  "lib.js",
  "content.js",
  "popup.js",
  "fiber-reader.js",
];

const forbidden = [
  [/\bfetch\s*\(/, "fetch()"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bWebSocket\b/, "WebSocket"],
  [/\bEventSource\b/, "EventSource"],
  [/\bsendBeacon\b/, "navigator.sendBeacon"],
  [/\bnew\s+Image\b/, "new Image()"],
  [/createElement\(\s*["']script["']/i, "dynamic <script> creation"],
  [/\bimport\s*\(/, "dynamic import()"],
  [/discord(app)?\.com\/api/i, "Discord API endpoint"],
  [/src\s*=\s*["']https?:/i, "remote src="],
  [/href\s*=\s*["']https?:/i, "remote href="],
  [/\blocalStorage\b/, "localStorage"],
  [/\bsessionStorage\b/, "sessionStorage"],
  [/\bindexedDB\b/, "indexedDB"],
  [/\bchrome\.storage\b/, "chrome.storage"],
  [/\bchrome\.downloads\b/, "chrome.downloads"],
  [/\bchrome\.cookies\b/, "chrome.cookies"],
  [/\bchrome\.identity\b/, "chrome.identity"],
  [/\bchrome\.webRequest\b/, "chrome.webRequest"],
  [/\bchrome\.debugger\b/, "chrome.debugger"],
  [/\bimportScripts\b/, "importScripts"],
  [/\beval\s*\(/, "eval()"],
  [/new\s+Function\s*\(/, "new Function()"],
];

let failed = false;
for (const f of files) {
  const src = fs.readFileSync(path.join(__dirname, f), "utf8");
  for (const [re, label] of forbidden) {
    if (re.test(src)) {
      console.error(`FAIL: ${f} contains forbidden pattern: ${label}`);
      failed = true;
    }
  }
}

// Manifest can't quietly gain broader capabilities.
try {
  const m = JSON.parse(
    fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8")
  );
  const bannedFields = [
    "host_permissions",
    "background",
    "externally_connectable",
    "web_accessible_resources",
    "optional_permissions",
    "optional_host_permissions",
  ];
  for (const key of bannedFields) {
    if (key in m) {
      console.error(`FAIL: manifest.json has forbidden field: ${key}`);
      failed = true;
    }
  }
  const perms = JSON.stringify((m.permissions || []).slice().sort());
  if (perms !== JSON.stringify(["activeTab", "scripting"])) {
    console.error(`FAIL: manifest permissions drifted: ${JSON.stringify(m.permissions)}`);
    failed = true;
  }
  const allowedMatch = /^https:\/\/(discord|canary\.discord|ptb\.discord)\.com\/\*$/;
  for (const cs of m.content_scripts || []) {
    for (const mt of cs.matches || []) {
      if (!allowedMatch.test(mt)) {
        console.error(`FAIL: unexpected content-script match: ${mt}`);
        failed = true;
      }
    }
  }
} catch (e) {
  console.error("FAIL: could not parse manifest.json:", e.message);
  failed = true;
}

if (failed) {
  console.error("\nSafety guardrail tripped — see above.");
  process.exit(1);
}
console.log(
  "Safety guardrail OK: no network / persistence / remote-code / privileged-API patterns found."
);
