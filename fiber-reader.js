/*
 * Discord Manual Export — React fiber reader (MAIN world; opt-in "High-fidelity").
 *
 * Injected on demand via chrome.scripting ONLY while the toggle is on. Defined as
 * a single self-contained function so the popup can inject it with a per-session
 * random `nonce` argument (there is NO static marker string anywhere).
 *
 * It reads Discord's own message objects from each message node's React fiber and
 * returns a few fields to the extension. It NEVER: patches anything, makes a
 * network request, adds a global, or mutates page state — it only reads.
 *
 * Channel: it hands data back over a private MessagePort received in a single
 * nonce-keyed handshake, so the payloads never ride the shared `window` message
 * bus. If the cross-world port transfer doesn't take, it answers nonce-keyed
 * `window` requests instead (graceful fallback).
 *
 * SENTRY SAFETY: every function body and callback is wrapped in try/catch, it
 * never calls console.*, and it uses no promises — so it can never surface an
 * uncaught error, rejection, or log into Discord's telemetry.
 */
function fiberReaderMain(nonce) {
  try {
    var thePort = null;

    function fiberOf(el) {
      try {
        var keys = Object.keys(el);
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].indexOf("__reactFiber$") === 0) return el[keys[i]];
        }
      } catch (e) {}
      return null;
    }

    function liId(el) {
      try {
        var m = (el.id || "").match(/(\d+)$/);
        return m ? m[1] : null;
      } catch (e) {
        return null;
      }
    }

    // Walk up the fiber to the message record whose id matches this <li> (so we
    // never pick up a nested referenced_message, which also has author/id/content).
    function messageOf(el) {
      try {
        var want = liId(el);
        var node = fiberOf(el);
        var fallback = null;
        for (var i = 0; node && i < 80; i++) {
          var p = node.memoizedProps;
          if (p) {
            for (var k in p) {
              var v = p[k];
              if (v && typeof v === "object" && v.author && v.id != null && "content" in v) {
                if (String(v.id) === want) return v;
                if (!fallback) fallback = v;
              }
            }
          }
          node = node.return;
        }
        return fallback;
      } catch (e) {
        return null;
      }
    }

    function isoOrNull(t) {
      try {
        if (!t) return null;
        if (typeof t.toISOString === "function") return t.toISOString();
        return String(t);
      } catch (e) {
        return null;
      }
    }

    function extract(m) {
      try {
        var a = m.author || {};
        var ref = m.messageReference;
        var refId = ref ? ref.messageId || ref.message_id : null;
        return {
          id: String(m.id),
          type: typeof m.type === "number" ? m.type : null,
          referenceId: refId ? String(refId) : null,
          authorId: a.id ? String(a.id) : null,
          username: a.username || null,
          discriminator: a.discriminator || null,
          editedTimestamp: isoOrNull(m.editedTimestamp),
        };
      } catch (e) {
        return null;
      }
    }

    function readVisible() {
      var out = [];
      try {
        var lis = document.querySelectorAll('li[id^="chat-messages-"]');
        for (var i = 0; i < lis.length; i++) {
          try {
            var m = messageOf(lis[i]);
            if (m) {
              var e = extract(m);
              if (e) out.push(e);
            }
          } catch (e2) {}
        }
      } catch (e) {}
      return out;
    }

    function teardown() {
      try {
        if (thePort) {
          try {
            thePort.close();
          } catch (e) {}
          thePort = null;
        }
      } catch (e) {}
      try {
        window.removeEventListener("message", onWin);
      } catch (e) {}
    }

    // Private port: preferred. Payloads never touch the window bus.
    function onPort(e) {
      try {
        var d = e.data || {};
        if (d.cmd === "read") {
          try {
            thePort.postMessage({ r: readVisible() });
          } catch (e2) {}
        } else if (d.cmd === "portOk") {
          try {
            window.removeEventListener("message", onWin);
          } catch (e2) {}
        } else if (d.cmd === "disable") {
          teardown();
        }
      } catch (e) {}
    }

    function adoptPort(port) {
      try {
        thePort = port;
        port.onmessage = onPort;
        try {
          port.start();
        } catch (e) {}
      } catch (e) {}
    }

    // Window bus: only the one-time handshake, plus nonce-keyed fallback requests.
    function onWin(ev) {
      try {
        if (ev.source !== window) return;
        var d = ev.data;
        if (!d || d.k !== nonce) return;
        if (d.h && ev.ports && ev.ports[0]) {
          adoptPort(ev.ports[0]);
          return;
        }
        if (d.cmd === "read") {
          try {
            window.postMessage({ k: nonce, r: readVisible() }, location.origin);
          } catch (e2) {}
        } else if (d.cmd === "disable") {
          teardown();
        }
      } catch (e) {}
    }

    try {
      window.addEventListener("message", onWin);
    } catch (e) {}
  } catch (e) {}
}
