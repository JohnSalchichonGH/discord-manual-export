/*
 * Popup UI. Talks to the content script (the capture engine) via messaging.
 * All exports are built as strings by the content script and saved HERE, in the
 * popup's own context, so Discord's page DOM is never touched.
 */

const $ = (s) => document.querySelector(s);
let tabId = null;
let lastState = null;
let pollTimer = null;

function sendMsg(obj) {
  return new Promise((resolve) => {
    if (tabId == null) return resolve(null);
    chrome.tabs.sendMessage(tabId, obj, (resp) => {
      if (chrome.runtime.lastError) return resolve(null); // no content script here
      resolve(resp);
    });
  });
}
function send(type) {
  return sendMsg({ type });
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

const controls = [".toggle", ".dl", ".txt", ".dce", ".clr", ".fiber"];

function render(st) {
  lastState = st;
  const toggle = $(".toggle");
  if (!st) {
    $(".n").textContent = "—";
    $(".dot").classList.remove("on");
    $(".status").textContent = "Open a Discord tab to use this.";
    $(".fiberStatus").textContent = "";
    controls.forEach((s) => ($(s).disabled = true));
    return;
  }
  controls.forEach((s) => ($(s).disabled = false));
  $(".n").textContent = st.count;
  $(".dot").classList.toggle("on", st.capturing);
  toggle.textContent = st.capturing ? "Stop capture" : "Start capture";
  toggle.className = "toggle " + (st.capturing ? "stop" : "go");
  $(".fiber").checked = !!st.fiber;
  $(".status").textContent = st.warning || "";
  const transport = {
    MessagePort: "✓ via private channel",
    unavailable: "unavailable on this tab (DOM-only still active)",
    connecting: "connecting…",
  };
  $(".fiberStatus").textContent = st.fiber
    ? transport[st.fiberStatus] || ""
    : "";
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
function afterExport(r, mime) {
  if (!r) return;
  saveBlob(r.filename, r.text, mime);
  $(".exportInfo").textContent = r.summary || "";
}
$(".dl").addEventListener("click", async () =>
  afterExport(await send("buildJson"), "application/json")
);
$(".txt").addEventListener("click", async () =>
  afterExport(await send("buildText"), "text/plain")
);
$(".dce").addEventListener("click", async () =>
  afterExport(await send("buildDce"), "application/json")
);
$(".fiber").addEventListener("change", async (e) => {
  const on = e.target.checked;
  if (on) {
    // Random per-session nonce — no static marker on the wire.
    const nonce =
      (crypto.randomUUID && crypto.randomUUID()) ||
      Math.random().toString(36).slice(2) + Date.now().toString(36);
    // Inject the read-only fiber reader into the page's main world with the nonce.
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: fiberReaderMain,
        args: [nonce],
      });
    } catch (err) {
      e.target.checked = false;
      $(".fiberStatus").textContent = "Couldn't enable high-fidelity on this tab.";
      return;
    }
    $(".fiberStatus").textContent = "connecting…";
    const st = await sendMsg({ type: "setFiber", on: true, nonce });
    if (st) render(st);
  } else {
    const st = await sendMsg({ type: "setFiber", on: false });
    if (st) render(st);
  }
});

(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  await refresh();
  // Live counter while the popup is open.
  pollTimer = setInterval(refresh, 700);
})();

window.addEventListener("unload", () => clearInterval(pollTimer));
