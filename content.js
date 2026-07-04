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

  // Opt-in high-fidelity layer: the MAIN-world fiber reader (injected by the
  // popup only when enabled) returns richer per-message data. Data flows over a
  // private MessagePort; a nonce-keyed window channel is the fallback only.
  let fiberEnabled = false;
  let fiberNonce = null;
  let fiberChannel = null;
  let fiberPort = null;
  let portConfirmed = false;
  let portFailed = false; // set only if the private port never answers
  let fiberTimer = null;
  const fiberStore = new Map(); // messageId -> { referenceId, username, ... }

  function mergeFiber(arr) {
    for (const fm of arr) {
      if (!fm || !fm.id) continue;
      const ex = fiberStore.get(fm.id) || {};
      ["referenceId", "username", "globalName", "discriminator", "editedTimestamp"].forEach(
        (k) => {
          if (fm[k]) ex[k] = fm[k];
        }
      );
      if (typeof fm.type === "number") ex.type = fm.type; // 0 is valid, don't skip
      fiberStore.set(fm.id, ex);
    }
  }

  function setupFiberChannel() {
    try {
      fiberChannel = new MessageChannel();
      fiberPort = fiberChannel.port1;
      portConfirmed = false;
      portFailed = false;
      fiberPort.onmessage = (e) => {
        try {
          const d = e.data || {};
          if (Array.isArray(d.r)) {
            if (!portConfirmed) {
              portConfirmed = true;
              clearTimeout(fiberTimer);
              try {
                fiberPort.postMessage({ cmd: "portOk" }); // reader can drop window listener
              } catch (er) {}
            }
            mergeFiber(d.r);
          }
        } catch (er) {}
      };
      try {
        fiberPort.start();
      } catch (er) {}
      // One data-less, random-keyed handshake hands the reader its port.
      window.postMessage({ k: fiberNonce, h: 1 }, location.origin, [fiberChannel.port2]);
      // If the port never answers, THEN (and only then) fall back to the window
      // bus — so real data is never broadcast while the private port is working.
      clearTimeout(fiberTimer);
      fiberTimer = setTimeout(() => {
        if (fiberEnabled && !portConfirmed) {
          portFailed = true;
          requestFiber();
        }
      }, 800);
    } catch (e) {}
  }

  function requestFiber() {
    if (!fiberEnabled || !fiberNonce) return;
    try {
      if (fiberPort) {
        try {
          fiberPort.postMessage({ cmd: "read" });
        } catch (e) {}
      }
      // Window bus is used ONLY after the private port is confirmed to have
      // failed — otherwise no export data ever touches the shared bus.
      if (portFailed && !portConfirmed) {
        try {
          window.postMessage({ k: fiberNonce, cmd: "read" }, location.origin);
        } catch (e) {}
      }
    } catch (e) {}
  }

  function teardownFiber() {
    fiberEnabled = false;
    clearTimeout(fiberTimer);
    try {
      if (fiberPort) fiberPort.postMessage({ cmd: "disable" });
    } catch (e) {}
    try {
      if (fiberNonce) window.postMessage({ k: fiberNonce, cmd: "disable" }, location.origin);
    } catch (e) {}
    try {
      if (fiberPort) fiberPort.close();
    } catch (e) {}
    fiberPort = null;
    fiberChannel = null;
    portConfirmed = false;
    portFailed = false;
    fiberNonce = null;
  }

  // Fallback receive path: reader responses over the window bus, used only if the
  // private port didn't come through. Nonce-keyed; anything else is ignored.
  window.addEventListener("message", (ev) => {
    try {
      if (ev.source !== window || !fiberNonce) return;
      const d = ev.data;
      if (!d || d.k !== fiberNonce) return;
      if (Array.isArray(d.r)) mergeFiber(d.r);
    } catch (e) {}
  });

  /* ---------------- extraction helpers ---------------- */

  function extractText(node) {
    if (!node) return "";
    const clone = node.cloneNode(true);
    // Drop the "(edited)" indicator and any screen-reader-only text (Discord's
    // hiddenVisually spans carry things like the edit-tooltip date and the
    // "<guild>:" prefix in channel headers).
    clone
      .querySelectorAll('[class*="edited"], [class*="hiddenVisually"]')
      .forEach((e) => e.remove());
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

  function getAvatarUrl(li) {
    const imgs = li.querySelectorAll('img[class*="avatar"]');
    for (const img of imgs) {
      if (isInReplyContext(img)) continue;
      const src = img.getAttribute("src");
      if (src) return src;
    }
    return null;
  }

  // Role color is an inline color on the name element (only set for colored
  // roles). Convert Discord's "rgb(r, g, b)" to the hex DCE expects, else null.
  function rgbToHex(rgb) {
    const m = (rgb || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    const h = (n) => Number(n).toString(16).padStart(2, "0");
    return "#" + h(m[1]) + h(m[2]) + h(m[3]);
  }

  function getRoleColor(authEl) {
    return authEl && authEl.style ? rgbToHex(authEl.style.color) : null;
  }

  // Custom-avatar URLs embed the numeric user id:
  //   cdn.discordapp.com/avatars/<userId>/<hash>.webp
  //   cdn.discordapp.com/guilds/<gid>/users/<userId>/avatars/<hash>.webp
  // Default avatars (embed/avatars/<n>.png) carry no id, so this returns null.
  function userIdFromAvatar(url) {
    if (!url) return null;
    let m = url.match(/\/users\/(\d+)\/avatars\//);
    if (m) return m[1];
    m = url.match(/\/avatars\/(\d+)\//);
    return m ? m[1] : null;
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
      // Custom-emoji reaction images embed the emoji id: /emojis/<id>.<ext>
      let id = "";
      let url = "";
      if (img) {
        const src = img.getAttribute("src") || "";
        const m = src.match(/\/emojis\/(\d+)\./);
        if (m) {
          id = m[1];
          url = src;
        }
      }
      const countEl = inner.querySelector('[class*="reactionCount"]');
      const count = countEl
        ? parseInt((countEl.textContent || "").replace(/\D/g, ""), 10) || 1
        : 1;
      if (emoji) out.push({ emoji, count, id, url });
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
    // The preview reuses the referenced message's own message-content-<id>
    // element, so its id is the exact replied-to message id.
    const idEl = ctx.querySelector('[id^="message-content-"]');
    const messageId = idEl ? idEl.id.replace("message-content-", "") : null;
    const author = authEl ? extractText(authEl) : null;
    const content = contentEl ? extractText(contentEl) : null;
    if (!author && !content && !messageId) return null;
    return { author, content, messageId };
  }

  // Reply previews load lazily; a message snapshotted too early shows a
  // placeholder ("Message could not be loaded") or an unresolved "@unknown-user"
  // mention. Score completeness so a later, fuller capture can replace it.
  function replyScore(r) {
    if (!r) return -1;
    const c = (r.content || "").trim();
    let s = 0;
    if (r.messageId) s += 3; // the authoritative signal — weight it highest
    if (r.author) s += 1;
    if (c) s += 1;
    if (c && !/could not be loaded|unknown-user/i.test(c)) s += 1;
    return s;
  }

  // Attachments/media live in <div id="message-accessories-…">. We only trust
  // Discord's own CDN/proxy hosts, which filters out UI icons and external links.
  const MEDIA_HOST = /(^|\.)discordapp\.(com|net)$/;
  const GIF_HOST = /(^|\.)(tenor|giphy|klipy|gfycat)\.com$/;

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
    const prio = { gif: 4, video: 3, image: 2, file: 1 };

    const consider = (elType, rawUrl, filename) => {
      if (!rawUrl || rawUrl.startsWith("data:")) return; // skip lazy-load placeholders
      let url;
      try {
        url = new URL(rawUrl, location.href);
      } catch (e) {
        return;
      }
      const isUpload =
        MEDIA_HOST.test(url.hostname) &&
        /\/(attachments|stickers)\//.test(url.pathname);
      const isGif = GIF_HOST.test(url.hostname);
      // Trust real Discord uploads, known GIF hosts, or any actual <video>. This
      // skips link-preview thumbnails, avatars, and emoji while catching media.
      if (!isUpload && !isGif && elType !== "video") return;

      const type = isGif ? "gif" : elType;
      const key = url.pathname;
      // Prefer the real filename from the URL path — Discord's <img alt> is a
      // generic "Image", so trusting it would drop the extension.
      const fname = fileNameFromUrl(rawUrl) || filename;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { type, url: rawUrl, filename: fname });
        return;
      }
      if ((prio[type] || 0) > (prio[existing.type] || 0)) existing.type = type;
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

    let items = [...byKey.values()];
    // A GIF embed yields both the real media file and its source-page link
    // (e.g. klipy.com/gifs/x). If we captured an actual file, drop gif page links.
    const MEDIA_EXT = /\.(mp4|webm|mov|gif|png|jpe?g|webp|apng)$/i;
    const hasRealFile = items.some((i) => MEDIA_EXT.test(i.filename || ""));
    if (hasRealFile) {
      items = items.filter(
        (i) => !(i.type === "gif" && !MEDIA_EXT.test(i.filename || ""))
      );
    }
    return items;
  }

  function mediaTag(m) {
    if (m.type === "gif") return "[GIF]";
    if (m.type === "image") return "[IMG]";
    if (m.type === "video") return "[VIDEO]";
    if (m.type === "file") return "[FILE]";
    return "[MEDIA]";
  }

  // Exact edit time: the "(edited)" marker is wrapped in a <time datetime=…>.
  function getEditedTimestamp(li) {
    const contentEl = getContentEl(li);
    const ed = contentEl && contentEl.querySelector('[class*="edited"]');
    const t = ed && ed.closest("time[datetime]");
    return t ? t.getAttribute("datetime") : null;
  }

  // @-mentions in the message body (display names; user IDs aren't in the DOM).
  function getMentions(li) {
    const contentEl = getContentEl(li);
    if (!contentEl) return [];
    const out = [];
    const seen = new Set();
    contentEl.querySelectorAll('[class*="mention"]').forEach((m) => {
      let t = (m.textContent || "").trim();
      if (t[0] !== "@") return; // skip #channel and non-user mentions
      t = t.slice(1).trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    });
    return out;
  }

  const STICKER_FORMAT = { 1: "Png", 2: "Apng", 3: "Lottie", 4: "Gif" };
  function getStickers(li) {
    const acc = li.querySelector('[id^="message-accessories-"]');
    if (!acc) return [];
    const out = [];
    const seen = new Set();
    // Sticker assets carry clean data-* attributes (data-id / data-name / format).
    acc
      .querySelectorAll('[data-type="sticker"], [class*="stickerAsset"]')
      .forEach((el) => {
        const d = el.hasAttribute("data-id") ? el : el.closest("[data-id]");
        const id = d ? d.getAttribute("data-id") : null;
        let name = d ? d.getAttribute("data-name") : null;
        const fmt = d ? d.getAttribute("data-format-type") : null;
        const url = el.getAttribute ? el.getAttribute("src") : null;
        if (!name) {
          const alt = el.getAttribute && el.getAttribute("alt");
          if (alt) name = alt.replace(/^Sticker,\s*/i, "").replace(/,\s*$/, "").trim();
        }
        const key = id || name || url;
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push({
          id: id || null,
          name: name || null,
          format: fmt ? STICKER_FORMAT[fmt] || fmt : null,
          url: url || null,
        });
      });
    return out;
  }

  // Rich embeds (link previews / bot embeds). Skips pure-media (gifv) embeds,
  // which are already captured as media. Emits nothing unless a title/desc is found.
  function getEmbeds(li) {
    const acc = li.querySelector('[id^="message-accessories-"]');
    if (!acc) return [];
    const out = [];
    acc.querySelectorAll('[class*="embedFull"]').forEach((em) => {
      const titleEl = em.querySelector('[class*="embedTitle"]');
      const descEl = em.querySelector('[class*="embedDescription"]');
      const title = titleEl ? extractText(titleEl) : null;
      const description = descEl ? extractText(descEl) : null;
      if (!title && !description) return; // pure media embed — already in media
      const anchor =
        (titleEl && titleEl.querySelector("a[href]")) ||
        (titleEl && titleEl.closest("a[href]"));
      const providerEl = em.querySelector('[class*="embedProvider"]');
      const authorEl = em.querySelector('[class*="embedAuthor"]');
      const footerEl = em.querySelector('[class*="embedFooter"]');
      const fields = [];
      em.querySelectorAll('[class*="embedField"]').forEach((f) => {
        const n = f.querySelector('[class*="embedFieldName"]');
        const v = f.querySelector('[class*="embedFieldValue"]');
        if (n || v)
          fields.push({
            name: n ? extractText(n) : "",
            value: v ? extractText(v) : "",
          });
      });
      const imgWrap = em.querySelector(
        '[class*="embedImage"], [class*="embedThumbnail"]'
      );
      let imageUrl = null;
      if (imgWrap) {
        const orig = imgWrap.querySelector('a[class*="originalLink"]');
        const img = imgWrap.querySelector("img");
        imageUrl =
          (orig && orig.getAttribute("href")) ||
          (img && img.getAttribute("src")) ||
          null;
      }
      out.push({
        title: title || null,
        url: anchor ? anchor.getAttribute("href") : null,
        description: description || null,
        provider: providerEl ? extractText(providerEl) : null,
        author: authorEl ? extractText(authorEl) : null,
        footer: footerEl ? extractText(footerEl) : null,
        fields,
        imageUrl,
      });
    });
    return out;
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
    let currentAuthorId = null;
    let currentAvatar = null;
    let currentColor = null;
    let currentIsBot = false;

    items.forEach((li) => {
      const authEl = getAuthorEl(li);
      if (authEl) {
        // Group leader: refresh the author details carried to grouped follow-ups.
        currentAuthor = extractText(authEl);
        currentAvatar = getAvatarUrl(li);
        currentAuthorId = userIdFromAvatar(currentAvatar);
        currentColor = getRoleColor(authEl);
        currentIsBot = !!li.querySelector('[class*="botTag"]');
      }

      const contentEl = getContentEl(li);
      const id = getMessageId(li, contentEl);
      if (!id) return;

      const record = {
        id,
        author: currentAuthor,
        authorId: currentAuthorId,
        avatarUrl: currentAvatar,
        color: currentColor,
        isBot: currentIsBot,
        timestamp: getTimestamp(li),
        content: contentEl ? extractText(contentEl) : "",
        editedTimestamp: getEditedTimestamp(li),
        media: getMedia(li),
        stickers: getStickers(li),
        embeds: getEmbeds(li),
        mentions: getMentions(li),
        reactions: getReactions(li),
        replyTo: getReply(li),
        isSystem: !!li.querySelector('[class*="systemMessage"]'),
      };

      const existing = store.get(id);
      if (existing) {
        if (!existing.author && record.author) existing.author = record.author;
        if (!existing.authorId && record.authorId)
          existing.authorId = record.authorId;
        if (!existing.avatarUrl && record.avatarUrl)
          existing.avatarUrl = record.avatarUrl;
        if (!existing.color && record.color) existing.color = record.color;
        if (record.isBot) existing.isBot = true;
        if (record.isSystem) existing.isSystem = true;
        if (!existing.timestamp && record.timestamp)
          existing.timestamp = record.timestamp;
        if (record.reactions.length) existing.reactions = record.reactions;
        if (record.media.length && !existing.media.length)
          existing.media = record.media;
        if (!existing.editedTimestamp && record.editedTimestamp)
          existing.editedTimestamp = record.editedTimestamp;
        if (record.stickers.length && !existing.stickers.length)
          existing.stickers = record.stickers;
        if (record.embeds.length && !existing.embeds.length)
          existing.embeds = record.embeds;
        if (record.mentions.length && !existing.mentions.length)
          existing.mentions = record.mentions;
        if (record.content && !existing.content)
          existing.content = record.content;
        // Replace a placeholder/partial reply preview once the real one loads.
        if (
          record.replyTo &&
          replyScore(record.replyTo) > replyScore(existing.replyTo)
        )
          existing.replyTo = record.replyTo;
      } else {
        store.set(id, record);
      }
    });

    requestFiber(); // ask the fiber reader (if on) to enrich the visible messages
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
    fiberStore.clear();
  }

  /* ---------------- export builders (return strings; popup saves them) ---------------- */

  // Discord's message header renders the DISPLAY name, not the account username.
  // The real @handle only appears in a few places (DM header, account panel),
  // which we scrape here to fill author.name. Everything is local DOM reading.
  const HANDLE_RE = /^[a-z0-9._]{2,32}$/;

  // Text of every leaf element under `el`, in document order.
  function leafTexts(el) {
    const out = [];
    el.querySelectorAll("*").forEach((n) => {
      if (n.children.length === 0) {
        const t = n.textContent.trim();
        if (t) out.push(t);
      }
    });
    if (!out.length) {
      const t = el.textContent.trim();
      if (t) out.push(t);
    }
    return out;
  }

  // From a [displayName, handle, ...maybe status] leaf list, split the two.
  function splitNameHandle(leaves) {
    const displayName = leaves[0] || null;
    let username = null;
    for (let i = 1; i < leaves.length; i++) {
      if (HANDLE_RE.test(leaves[i]) && leaves[i] !== displayName) {
        username = leaves[i];
        break;
      }
    }
    return { displayName, username };
  }

  function dmHeaderInfo() {
    const sels = [
      '[class*="titleWrapper"]',
      '[class*="title_"]',
      'section[class*="title"]',
    ];
    let fallback = null;
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el) continue;
      const info = splitNameHandle(leafTexts(el));
      if (info.displayName && info.username) return info; // got both — best
      if (info.displayName && !fallback) fallback = info;
    }
    return fallback;
  }

  function accountPanelInfo() {
    const panel =
      document.querySelector('[class*="panels_"]') ||
      document.querySelector('section[class*="panels"]');
    if (!panel) return null;
    const info = splitNameHandle(leafTexts(panel));
    return info.displayName ? info : null;
  }

  // displayName -> username, from the DM recipient and the logged-in account.
  function buildUsernameMap() {
    const map = new Map();
    [dmHeaderInfo(), accountPanelInfo()].forEach((info) => {
      if (info && info.username) map.set(info.displayName, info.username);
    });
    return map;
  }

  function channelInfo() {
    const parts = location.pathname.match(/channels\/([^/]+)\/([^/]+)/);
    const guildId = parts ? parts[1] : null;
    const id = parts ? parts[2] : null;
    let name = null;
    if (guildId === "@me") {
      const dm = dmHeaderInfo();
      if (dm) name = dm.displayName; // just the display name, not name+handle
    }
    if (!name) {
      const titleEl =
        document.querySelector('[class*="title_"] h1') ||
        document.querySelector('h1[class*="title"]');
      // extractText drops the hidden "<guild>:" accessibility prefix, leaving
      // just the visible channel name.
      if (titleEl) name = extractText(titleEl);
    }
    if (!name) name = document.title.replace(/^\(\d+\)\s*/, "").trim();
    return { id, name, url: location.href };
  }

  // System/notification messages (pins, joins, boosts, …) — dropped from exports.
  // Authoritative signal is the numeric message type (from the fiber reader);
  // a DOM class is the fallback when high-fidelity is off.
  const SYSTEM_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 18, 22, 24]);

  function isSystemMessage(r) {
    if (r.isSystem) return true;
    const f = fiberStore.get(r.id);
    return !!(f && typeof f.type === "number" && SYSTEM_TYPES.has(f.type));
  }

  function sortedMessages() {
    return [...store.values()]
      .filter((r) => !isSystemMessage(r))
      .sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  // Strip characters not allowed in filenames.
  function sanitizeFilePart(s) {
    return (s || "")
      .replace(/[\\/:*?"<>|\r\n\t]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // DCE-style filename:
  //   "<guild> - <category> - <channel> - <date> [<channelId>].<ext>"
  //   DMs: "Direct Messages - <recipient> - <date> [<channelId>].<ext>"
  function exportName(ext) {
    const { guild, channel } = dceGuildChannel();
    const isDm = guild.id === "0";
    const parts = isDm
      ? ["Direct Messages", channel.name]
      : [guild.name, channel.category, channel.name];
    const prefix =
      parts.map(sanitizeFilePart).filter(Boolean).join(" - ") ||
      "discord-export";
    return `${prefix} - ${todayStr()} [${channel.id || "channel"}].${ext}`;
  }

  // The documented, clean shape (excludes internal-only fields like avatarUrl).
  function cleanMessage(r) {
    return {
      id: r.id,
      author: r.author,
      authorId: r.authorId,
      timestamp: r.timestamp,
      editedTimestamp: r.editedTimestamp || null,
      content: r.content,
      media: r.media,
      stickers: r.stickers || [],
      embeds: r.embeds || [],
      mentions: r.mentions || [],
      reactions: r.reactions,
      replyTo: r.replyTo,
    };
  }

  function buildJsonString() {
    const messages = sortedMessages().map((r) => {
      const c = cleanMessage(r);
      const fib = fiberStore.get(r.id);
      if (fib) {
        if (fib.username) c.username = fib.username;
        if (fib.referenceId && c.replyTo) c.replyTo.messageId = fib.referenceId;
      }
      return c;
    });
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

  /* ---------------- DiscordChatExporter-compatible JSON ----------------
   * Matches DCE's schema so the file drops into tools that read DCE exports.
   * Fields the rendered page can't provide (author.id, attachment ids/sizes,
   * reference.messageId, embeds, exact edited time) are left empty/null. */

  function dceGuildChannel() {
    const m = location.pathname.match(/channels\/([^/]+)\/([^/]+)/);
    const guildId = m ? m[1] : "";
    const channelId = m ? m[2] : "";
    const ch = channelInfo();
    if (guildId === "@me") {
      return {
        guild: { id: "0", name: "Direct Messages", iconUrl: "" },
        channel: {
          id: channelId,
          type: "DirectTextChat",
          categoryId: "",
          category: "",
          name: ch.name || "",
          topic: null,
        },
      };
    }
    // Best-effort guild name from the sidebar header. Avoid the channel header
    // (which holds the channel name) by rejecting a value equal to ch.name.
    let guildName = "";
    const gCandidates = [
      '[class*="headerContent"]',
      '[class*="guildName"]',
      '[class*="nameAndDecorators"]',
    ];
    for (const s of gCandidates) {
      const el = document.querySelector(s);
      const t = el ? el.textContent.trim() : "";
      if (t && t !== (ch.name || "")) {
        guildName = t;
        break;
      }
    }
    return {
      guild: { id: guildId, name: guildName, iconUrl: "" },
      channel: {
        id: channelId,
        type: "GuildTextChat",
        categoryId: "",
        category: "",
        name: ch.name || "",
        topic: null,
      },
    };
  }

  function dceEmoji(r) {
    // r.emoji is a unicode char or ":name:" for custom emoji; id/url come from
    // the reaction image when it's a custom emoji.
    const name = r.emoji.replace(/^:|:$/g, "");
    return {
      id: r.id || "",
      name,
      code: "",
      isAnimated: /\.gif(\?|$)/i.test(r.url || ""),
      imageUrl: r.url || "",
    };
  }

  function dceMessage(r, guildId, channelId, usernameMap, fib) {
    const display = r.author || "";
    // name = account @handle: prefer the fiber reader's exact username, then the
    // DM-header/panel scrape, else fall back to the display name.
    const username =
      (fib && fib.username) || (usernameMap && usernameMap.get(display)) || display;
    return {
      id: r.id,
      type: r.replyTo ? "Reply" : "Default",
      timestamp: r.timestamp,
      timestampEdited: (fib && fib.editedTimestamp) || r.editedTimestamp || null,
      callEndedTimestamp: null,
      isPinned: false,
      content: r.content || "",
      author: {
        id: r.authorId || "",
        name: username,
        discriminator: (fib && fib.discriminator) || "0000",
        nickname: display,
        color: r.color || null,
        isBot: !!r.isBot,
        avatarUrl: r.avatarUrl || "",
      },
      attachments: (r.media || []).map((mm) => ({
        id: "",
        url: mm.url || "",
        fileName: mm.filename || "",
        fileSizeBytes: 0,
      })),
      embeds: (r.embeds || []).map((e) => ({
        title: e.title || "",
        url: e.url || "",
        timestamp: null,
        description: e.description || "",
        color: null,
        author:
          e.author || e.provider
            ? { name: e.author || e.provider, url: "", iconUrl: "" }
            : null,
        thumbnail: e.imageUrl ? { url: e.imageUrl } : null,
        images: [],
        fields: (e.fields || []).map((f) => ({
          name: f.name || "",
          value: f.value || "",
          isInline: false,
        })),
        footer: e.footer ? { text: e.footer, iconUrl: "" } : null,
        inlineEmojis: [],
      })),
      stickers: (r.stickers || []).map((s) => ({
        id: s.id || "",
        name: s.name || "",
        format: s.format || "",
        sourceUrl: s.url || "",
      })),
      reactions: (r.reactions || []).map((rc) => ({
        emoji: dceEmoji(rc),
        count: rc.count,
      })),
      mentions: (r.mentions || []).map((n) => ({
        id: "",
        name: n,
        discriminator: "0000",
        nickname: n,
      })),
      reference: r.replyTo
        ? { messageId: "", channelId, guildId }
        : null,
    };
  }

  // Discord doesn't put the referenced message's id in the DOM. If the replied-to
  // message was itself captured, resolve the link locally by matching the reply
  // preview (author + text) against earlier messages. Purely local, no network.
  function normText(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }
  function normAuthor(s) {
    return (s || "").replace(/^@/, "").trim();
  }

  function resolveReferenceId(rec, all) {
    if (!rec.replyTo) return "";
    const who = normAuthor(rec.replyTo.author);
    let preview = normText(rec.replyTo.content).replace(/(?:…|\.\.\.)+$/, "").trim();
    if (!preview) return "";
    const t = rec.timestamp ? Date.parse(rec.timestamp) : Infinity;
    let best = null;
    let bestT = -Infinity;
    for (const m of all) {
      if (m.id === rec.id) continue;
      if (who && normAuthor(m.author) !== who) continue;
      const cf = normText(m.content);
      if (!cf || !cf.startsWith(preview)) continue; // preview is a (possibly truncated) prefix
      const mt = m.timestamp ? Date.parse(m.timestamp) : -Infinity;
      if (mt <= t && mt >= bestT) {
        best = m;
        bestT = mt;
      }
    }
    return best ? best.id : "";
  }

  function buildDceJson() {
    const { guild, channel } = dceGuildChannel();
    const records = sortedMessages();
    const usernameMap = buildUsernameMap();
    const messages = records.map((r) => {
      const fib = fiberStore.get(r.id) || null;
      const msg = dceMessage(r, guild.id, channel.id, usernameMap, fib);
      if (msg.reference)
        // Prefer the fiber reader's exact id, then the reply-preview id, then match.
        msg.reference.messageId =
          (fib && fib.referenceId) ||
          (r.replyTo && r.replyTo.messageId) ||
          resolveReferenceId(r, records);
      return msg;
    });
    return JSON.stringify(
      {
        guild,
        channel,
        dateRange: { after: null, before: null },
        exportedAt: new Date().toISOString(),
        messages,
        messageCount: messages.length,
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
    (msg.stickers || []).forEach((s) =>
      body.push(`[STICKER: ${s.name || "sticker"}]`)
    );

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
    return { capturing, count: store.size, fiber: fiberEnabled };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case "getState":
        sendResponse(state());
        break;
      case "setFiber":
        if (msg.on) {
          fiberNonce = msg.nonce || null;
          fiberEnabled = true;
          setupFiberChannel();
          requestFiber();
        } else {
          teardownFiber();
        }
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
      case "buildDce":
        sendResponse({ filename: exportName("dce.json"), text: buildDceJson() });
        break;
      default:
        sendResponse(null);
    }
    return true;
  });
})();
