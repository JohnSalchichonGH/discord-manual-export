/*
 * Discord Manual Export — content script (capture engine only)
 *
 * SAFETY / PRIVACY:
 *   - Makes ZERO network requests. Captured data never leaves your machine; it
 *     lives only in the in-memory `store` Map until you export it from the popup.
 *   - Does NOT patch fetch/XHR, does NOT scroll/click for you.
 *   - Injects NOTHING into Discord's page DOM. All UI lives in the extension
 *     popup. The only thing running in the page is a passive MutationObserver,
 *     which is invisible to page JS. Nothing here is observable by Discord.
 *
 * You scroll the channel by hand; the observer notices when Discord renders new
 * messages and harvests them from the DOM. Deduped by message id.
 */

(() => {
  "use strict";
  if (window.__discordManualExport) return;
  window.__discordManualExport = true;

  const store = new Map(); // messageId -> record
  let observer = null;
  let debounceTimer = null;
  let capturing = false;

  /* ---------------- extraction helpers ---------------- */

  function extractText(node) {
    if (!node) return "";
    const clone = node.cloneNode(true);
    clone.querySelectorAll("img[alt]").forEach((img) => {
      img.replaceWith(document.createTextNode(img.getAttribute("alt") || ""));
    });
    return clone.textContent.replace(/​/g, "").trim();
  }

  function isInReplyContext(el) {
    return !!(
      el.closest('[id^="message-reply-context-"]') ||
      el.closest('[class*="repliedMessage"]')
    );
  }

  function getAuthorEl(li) {
    const els = li.querySelectorAll('[class*="username"]');
    for (const el of els) {
      if (isInReplyContext(el)) continue;
      return el;
    }
    return null;
  }

  function getTimestamp(li) {
    const times = li.querySelectorAll("time[datetime]");
    for (const t of times) {
      if (isInReplyContext(t)) continue;
      return t.getAttribute("datetime");
    }
    return times[0] ? times[0].getAttribute("datetime") : null;
  }

  function getReactions(li) {
    const out = [];
    const cont = li.querySelector('[class*="reactions"]');
    if (!cont) return out;
    cont.querySelectorAll('[class*="reactionInner"]').forEach((inner) => {
      const img = inner.querySelector("img[alt]");
      let emoji = img ? img.getAttribute("alt") || "" : "";
      if (!emoji) {
        const lbl = inner.getAttribute("aria-label") || inner.textContent || "";
        emoji = lbl.trim();
      }
      const countEl = inner.querySelector('[class*="reactionCount"]');
      const count = countEl
        ? parseInt((countEl.textContent || "").replace(/\D/g, ""), 10) || 1
        : 1;
      if (emoji) out.push({ emoji, count });
    });
    return out;
  }

  function getReply(li) {
    const ctx =
      li.querySelector('[id^="message-reply-context-"]') ||
      li.querySelector('[class*="repliedMessage"]');
    if (!ctx) return null;
    const authEl = ctx.querySelector('[class*="username"]');
    const contentEl =
      ctx.querySelector('[class*="repliedTextContent"]') ||
      ctx.querySelector('[class*="repliedTextPreview"]');
    const author = authEl ? extractText(authEl) : null;
    const content = contentEl ? extractText(contentEl) : null;
    if (!author && !content) return null;
    return { author, content };
  }

  // Attachments/media live in <div id="message-accessories-…">. We only trust
  // Discord's own CDN/proxy hosts, which filters out UI icons and external links.
  const MEDIA_HOST = /(^|\.)discordapp\.(com|net)$/;

  function fileNameFromUrl(u) {
    try {
      const p = new URL(u, location.href).pathname;
      const base = p.substring(p.lastIndexOf("/") + 1);
      return decodeURIComponent(base) || null;
    } catch (e) {
      return null;
    }
  }

  function getMedia(li) {
    const acc = li.querySelector('[id^="message-accessories-"]');
    if (!acc) return [];
    const byKey = new Map(); // dedupe by URL pathname (proxy + original are one file)
    const prio = { video: 3, image: 2, file: 1 };

    const consider = (type, rawUrl, filename) => {
      if (!rawUrl) return;
      let url;
      try {
        url = new URL(rawUrl, location.href);
      } catch (e) {
        return;
      }
      if (!MEDIA_HOST.test(url.hostname)) return;
      const key = url.pathname;
      const fname = filename || fileNameFromUrl(rawUrl);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { type, url: rawUrl, filename: fname });
        return;
      }
      if (prio[type] > prio[existing.type]) existing.type = type;
      if (
        /cdn\.discordapp\.com/.test(rawUrl) &&
        !/cdn\.discordapp\.com/.test(existing.url)
      )
        existing.url = rawUrl;
      if (!existing.filename && fname) existing.filename = fname;
    };

    acc.querySelectorAll("video").forEach((v) => {
      const s = v.querySelector("source");
      consider("video", v.getAttribute("src") || (s && s.getAttribute("src")), null);
    });
    acc.querySelectorAll("img[src]").forEach((img) =>
      consider("image", img.getAttribute("src"), img.getAttribute("alt") || null)
    );
    acc.querySelectorAll("a[href]").forEach((a) =>
      consider("file", a.getAttribute("href"), a.getAttribute("title") || null)
    );

    return [...byKey.values()];
  }

  function mediaTag(m) {
    if (m.type === "image") return "[IMG]";
    if (m.type === "video") return "[VIDEO]";
    if (m.type === "file") return "[FILE]";
    return "[MEDIA]";
  }

  // Discord's reply preview reuses the referenced message's message-content div
  // (rendered BEFORE the body), so skip anything inside the reply context.
  function getContentEl(li) {
    const els = li.querySelectorAll('[id^="message-content-"]');
    for (const el of els) {
      if (isInReplyContext(el)) continue;
      return el;
    }
    return null;
  }

  function getMessageId(li, contentEl) {
    const m = (li.id || "").match(/(\d+)$/);
    if (m) return m[1];
    if (contentEl && contentEl.id)
      return contentEl.id.replace("message-content-", "");
    return li.id || null;
  }

  /* ---------------- capture ---------------- */

  function getList() {
    return document.querySelector('[data-list-id="chat-messages"]');
  }

  function capture() {
    const list = getList();
    if (!list) return;
    const items = list.querySelectorAll('li[id^="chat-messages-"]');
    let currentAuthor = null;

    items.forEach((li) => {
      const authEl = getAuthorEl(li);
      if (authEl) currentAuthor = extractText(authEl);

      const contentEl = getContentEl(li);
      const id = getMessageId(li, contentEl);
      if (!id) return;

      const record = {
        id,
        author: currentAuthor,
        timestamp: getTimestamp(li),
        content: contentEl ? extractText(contentEl) : "",
        media: getMedia(li),
        reactions: getReactions(li),
        replyTo: getReply(li),
      };

      const existing = store.get(id);
      if (existing) {
        if (!existing.author && record.author) existing.author = record.author;
        if (!existing.timestamp && record.timestamp)
          existing.timestamp = record.timestamp;
        if (record.reactions.length) existing.reactions = record.reactions;
        if (record.media.length && !existing.media.length)
          existing.media = record.media;
        if (record.content && !existing.content)
          existing.content = record.content;
      } else {
        store.set(id, record);
      }
    });
  }

  const debouncedCapture = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(capture, 150);
  };

  function start() {
    if (capturing) return;
    capturing = true;
    capture();
    const list = getList();
    const target =
      (list && (list.closest('[class*="scroller"]') || list.parentElement)) ||
      document.getElementById("app-mount") ||
      document.body;
    observer = new MutationObserver(debouncedCapture);
    observer.observe(target, { childList: true, subtree: true });
  }

  function stop() {
    capturing = false;
    if (observer) observer.disconnect();
    observer = null;
  }

  function clearAll() {
    store.clear();
  }

  /* ---------------- export builders (return strings; popup saves them) ---------------- */

  function channelInfo() {
    const m = location.pathname.match(/channels\/([^/]+)\/([^/]+)/);
    const id = m ? m[2] : null;
    let name = null;
    const titleEl =
      document.querySelector('[class*="title_"] h1') ||
      document.querySelector('h1[class*="title"]') ||
      document.querySelector('[class*="titleWrapper"]');
    if (titleEl) name = titleEl.textContent.trim();
    if (!name) name = document.title.replace(/^\(\d+\)\s*/, "").trim();
    return { id, name, url: location.href };
  }

  function sortedMessages() {
    return [...store.values()].sort((a, b) =>
      (a.timestamp || "").localeCompare(b.timestamp || "")
    );
  }

  function exportName(ext) {
    const ch = channelInfo();
    return `discord-export-${ch.id || "channel"}-${Date.now()}.${ext}`;
  }

  function buildJsonString() {
    const messages = sortedMessages();
    return JSON.stringify(
      {
        channel: channelInfo(),
        capturedAt: new Date().toISOString(),
        messageCount: messages.length,
        messages,
      },
      null,
      2
    );
  }

  /* transcript */

  function fmtTime(d) {
    let h = d.getHours();
    const m = d.getMinutes();
    const ap = h < 12 ? "AM" : "PM";
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, "0")} ${ap}`;
  }

  function fmtDate(d) {
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function fmtDelta(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `+${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `+${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `+${h}h`;
    return `+${Math.floor(h / 24)}d`;
  }

  function dayKey(d) {
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function oneLine(s) {
    return (s || "").replace(/\s*\n\s*/g, " ").trim();
  }

  function messageLines(msg) {
    const out = [];
    if (msg.replyTo) {
      const who = msg.replyTo.author || "?";
      out.push(`  > ${who}: ${oneLine(msg.replyTo.content)}`.trimEnd());
    }
    const reactions = (msg.reactions || [])
      .map((r) => `^{${r.emoji}:${r.count}}`)
      .join(" ");
    const body = [];
    if ((msg.content || "") !== "")
      msg.content.split("\n").forEach((l) => body.push(l));
    (msg.media || []).forEach((m) => body.push(mediaTag(m)));

    if (body.length === 0) {
      if (reactions) out.push(`  ${reactions}`);
    } else {
      body.forEach((line, i) => {
        const isLast = i === body.length - 1;
        out.push(`  ${line}${isLast && reactions ? " " + reactions : ""}`);
      });
    }
    return out;
  }

  function buildTranscript() {
    const messages = sortedMessages().filter((m) => m.timestamp);
    const lines = [];
    let prevDate = null;
    let prevDayKey = null;
    let curAuthor = null;

    messages.forEach((msg) => {
      const d = new Date(msg.timestamp);
      const newDay = dayKey(d) !== prevDayKey;

      if (newDay) {
        if (lines.length) lines.push("");
        lines.push(`=== ${fmtDate(d)} ===`);
        prevDayKey = dayKey(d);
        curAuthor = null;
      }

      const startNew = newDay || msg.author !== curAuthor || !!msg.replyTo;
      if (startNew) {
        lines.push("");
        const stamp = prevDate && !newDay ? fmtDelta(d - prevDate) : fmtTime(d);
        lines.push(`[${stamp}] ${msg.author || "Unknown"}:`);
        curAuthor = msg.author;
      }

      messageLines(msg).forEach((l) => lines.push(l));
      prevDate = d;
    });

    return lines.join("\n").replace(/^\n+/, "") + "\n";
  }

  /* ---------------- popup messaging ---------------- */

  function state() {
    return { capturing, count: store.size };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case "getState":
        sendResponse(state());
        break;
      case "start":
        start();
        sendResponse(state());
        break;
      case "stop":
        stop();
        sendResponse(state());
        break;
      case "clear":
        clearAll();
        sendResponse(state());
        break;
      case "buildJson":
        sendResponse({ filename: exportName("json"), text: buildJsonString() });
        break;
      case "buildText":
        sendResponse({ filename: exportName("txt"), text: buildTranscript() });
        break;
      default:
        sendResponse(null);
    }
    return true;
  });
})();
