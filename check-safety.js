/*
 * Safety-contract check. Fails if the extension's scripts contain any
 * network / persistence / remote-code API. This encodes the promise that the
 * extension is local-only and never phones home. Run: `node check-safety.js`.
 */
const fs = require("fs");
const path = require("path");

const files = ["content.js", "popup.js", "fiber-reader.js"];
const forbidden = [
  [/\bfetch\s*\(/, "fetch()"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bWebSocket\b/, "WebSocket"],
  [/\bEventSource\b/, "EventSource"],
  [/\bsendBeacon\b/, "navigator.sendBeacon"],
  [/discord(app)?\.com\/api/i, "Discord API endpoint"],
  [/\blocalStorage\b/, "localStorage"],
  [/\bsessionStorage\b/, "sessionStorage"],
  [/\bchrome\.storage\b/, "chrome.storage"],
  [/\bindexedDB\b/, "indexedDB"],
  [/\bimportScripts\b/, "importScripts"],
  [/\beval\s*\(/, "eval()"],
  [/new\s+Function\s*\(/, "new Function()"],
];

let failed = false;
for (const f of files) {
  const src = fs.readFileSync(path.join(__dirname, f), "utf8");
  for (const [re, label] of forbidden) {
    if (re.test(src)) {
      console.error(`FAIL: ${f} contains forbidden API: ${label}`);
      failed = true;
    }
  }
}

if (failed) {
  console.error("\nSafety contract violated — see above.");
  process.exit(1);
}
console.log("Safety contract OK: no network / persistence / remote-code APIs found.");
