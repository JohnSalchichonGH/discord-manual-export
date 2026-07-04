/*
 * Popup UI. Talks to the content script (the capture engine) via messaging.
 * All exports are built as strings by the content script and saved HERE, in the
 * popup's own context, so Discord's page DOM is never touched.
 */

const $ = (s) => document.querySelector(s);
let tabId = null;
let lastState = null;
let pollTimer = null;

function send(type) {
  return new Promise((resolve) => {
    if (tabId == null) return resolve(null);
    chrome.tabs.sendMessage(tabId, { type }, (resp) => {
      if (chrome.runtime.lastError) return resolve(null); // no content script here
      resolve(resp);
    });
  });
}

function saveBlob(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const controls = [".toggle", ".dl", ".txt", ".clr"];

function render(st) {
  lastState = st;
  const toggle = $(".toggle");
  if (!st) {
    $(".n").textContent = "—";
    $(".dot").classList.remove("on");
    $(".status").textContent = "Open a Discord tab to use this.";
    controls.forEach((s) => ($(s).disabled = true));
    return;
  }
  $(".status").textContent = "";
  controls.forEach((s) => ($(s).disabled = false));
  $(".n").textContent = st.count;
  $(".dot").classList.toggle("on", st.capturing);
  toggle.textContent = st.capturing ? "Stop capture" : "Start capture";
  toggle.className = "toggle " + (st.capturing ? "stop" : "go");
}

async function refresh() {
  render(await send("getState"));
}

$(".toggle").addEventListener("click", async () => {
  render(await send(lastState && lastState.capturing ? "stop" : "start"));
});
$(".clr").addEventListener("click", async () => {
  render(await send("clear"));
});
$(".dl").addEventListener("click", async () => {
  const r = await send("buildJson");
  if (r) saveBlob(r.filename, r.text, "application/json");
});
$(".txt").addEventListener("click", async () => {
  const r = await send("buildText");
  if (r) saveBlob(r.filename, r.text, "text/plain");
});

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  await refresh();
  // Live counter while the popup is open.
  pollTimer = setInterval(refresh, 700);
})();

window.addEventListener("unload", () => clearInterval(pollTimer));
