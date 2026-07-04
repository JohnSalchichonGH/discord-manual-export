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
 * Channel: it hands data back ONLY over a private MessagePort received in a
 * single nonce-keyed handshake, so the payloads never ride the shared `window`
 * message bus. If the cross-world port transfer doesn't take, high-fidelity is
 * reported unavailable (fail closed) — captured data is never sent over the
 * window bus.
 *
 * SENTRY SAFETY: every function body and callback is wrapped in try/catch, it
 * never calls console.*, and it uses no promises — written to avoid surfacing
 * uncaught errors, rejections, or logs into Discord's telemetry.
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
        if (!want) return null;
        var node = fiberOf(el);
        for (var i = 0; node && i < 80; i++) {
          var p = node.memoizedProps;
          if (p) {
            for (var k in p) {
              var v = p[k];
              // Exact id match only — fail closed rather than risk enriching a
              // visible message with a nested referenced_message's data.
              if (
                v &&
                typeof v === "object" &&
                v.author &&
                v.id != null &&
                "content" in v &&
                String(v.id) === want
              ) {
                return v;
              }
            }
          }
          node = node.return;
        }
      } catch (e) {}
      return null;
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
          globalName: a.globalName || a.global_name || null,
          nick: typeof m.nick === "string" ? m.nick : null,
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

    // Window bus is used ONLY to receive the one-time port handshake (and a
    // disable signal). Data is NEVER sent back over the window — only the port.
    function onWin(ev) {
      try {
        if (ev.source !== window) return;
        var d = ev.data;
        if (!d || d.k !== nonce) return;
        if (d.h && ev.ports && ev.ports[0]) {
          adoptPort(ev.ports[0]);
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
