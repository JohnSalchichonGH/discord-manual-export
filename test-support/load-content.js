/*
 * Faithful headless loader for the REAL content.js.
 *
 * Why this exists: content.js's export builders live inside a closed IIFE and
 * read module-private state (store / fiberStore / captureCtx). To capture a
 * golden baseline of their output WITHOUT editing the shipped file, we load the
 * exact source in a vm sandbox and append a tiny epilogue (in memory only) that
 * re-exports the internals we need. The committed content.js stays byte-identical.
 *
 * The same loader is reused by the golden test so that as later phases move code
 * out of content.js, the builders' output is re-checked against the frozen
 * goldens — any drift fails the test.
 *
 * Determinism: TZ is pinned to UTC and Date is frozen, because buildTranscript
 * formats timestamps in local time and the JSON/DCE builders stamp new Date().
 */

process.env.TZ = "UTC"; // pin before any Date use (transcript uses local time)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const FROZEN_NOW = "2026-07-10T00:00:00.000Z";

// Freeze "now" so capturedAt / exportedAt are stable, while real Date parsing
// (new Date(isoString), Date.parse, getHours, …) still works for the fixtures.
const RealDate = Date;
class MockDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(new RealDate(FROZEN_NOW).getTime());
    else super(...args);
  }
  static now() {
    return new RealDate(FROZEN_NOW).getTime();
  }
}

// The builders only touch the DOM via healthCheck() -> getList(). Returning a
// list with one message node keeps healthCheck() quiet (no spurious warning).
function makeDomStub() {
  const fakeList = {
    querySelectorAll: () => ({ length: 1, forEach() {} }),
    closest: () => null,
    parentElement: null,
  };
  return {
    querySelector: () => fakeList,
    getElementById: () => null,
    querySelectorAll: () => ({ length: 1, forEach() {} }),
    title: "",
  };
}

// Read content.js and append an epilogue that re-exports internals. We inject it
// right before the IIFE's trailing `})();` so it runs inside the same closure.
function instrumentedSource() {
  const src = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
  const marker = "})();";
  const idx = src.lastIndexOf(marker);
  if (idx === -1) throw new Error("content.js: could not find IIFE close `})();`");
  const epilogue = `
  try {
    globalThis.__DME_TEST__ = {
      store: store,
      fiberStore: fiberStore,
      buildJsonString: buildJsonString,
      buildDceJson: buildDceJson,
      buildTranscript: buildTranscript,
      setState: function (s) {
        if ("ctx" in s) captureCtx = s.ctx;
        if ("startedAt" in s) captureStartedAt = s.startedAt;
        if ("stoppedAt" in s) captureStoppedAt = s.stoppedAt;
        if ("stoppedReason" in s) stoppedReason = s.stoppedReason;
        if ("channelKey" in s) storeChannelKey = s.channelKey;
        if ("fiberEnabled" in s) fiberEnabled = s.fiberEnabled;
        if ("capturing" in s) capturing = s.capturing;
      },
    };
  } catch (e) {}
`;
  return src.slice(0, idx) + epilogue + src.slice(idx);
}

/**
 * Load content.js and return its internal export API in a fresh sandbox.
 * @returns {{store: Map, fiberStore: Map, buildJsonString: Function,
 *   buildDceJson: Function, buildTranscript: Function, setState: Function}}
 */
function loadContent() {
  const sandbox = {
    window: {},
    document: makeDomStub(),
    location: {
      pathname: "/channels/111/222",
      href: "https://discord.com/channels/111/222",
      origin: "https://discord.com",
    },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    console,
    Date: MockDate,
    URL,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    MessageChannel: class {
      constructor() {
        this.port1 = { postMessage() {}, start() {}, close() {} };
        this.port2 = {};
      }
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  sandbox.globalThis = sandbox;
  sandbox.window.window = sandbox.window;

  // If lib.js already exists (Phase 1+), expose it the way content.js expects.
  const libPath = path.join(ROOT, "lib.js");
  if (fs.existsSync(libPath)) {
    try {
      sandbox.window.__DME = require(libPath);
    } catch (e) {}
  }

  vm.createContext(sandbox);
  vm.runInContext(instrumentedSource(), sandbox, { filename: "content.js" });
  const api = sandbox.__DME_TEST__;
  if (!api) throw new Error("content.js loader: __DME_TEST__ was not exported");
  return api;
}

/**
 * Seed the loaded content.js with a fixture session, then return the three
 * export strings exactly as the popup would receive them.
 * @param {{records: object[], fiber: object, ctx: object, session: object}} fx
 */
function buildExports(fx) {
  const api = loadContent();
  for (const r of fx.records) api.store.set(r.id, r);
  for (const [id, f] of Object.entries(fx.fiber || {})) api.fiberStore.set(id, f);
  api.setState({
    ctx: fx.ctx,
    startedAt: fx.session.startedAt,
    stoppedAt: fx.session.stoppedAt,
    stoppedReason: fx.session.stoppedReason,
    channelKey: fx.session.channelKey,
    capturing: false,
    fiberEnabled: false,
  });
  return {
    json: api.buildJsonString(),
    dce: api.buildDceJson(),
    transcript: api.buildTranscript(),
  };
}

module.exports = { loadContent, buildExports, FROZEN_NOW };
