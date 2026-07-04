/*
 * Discord Manual Export — content script (capture engine only)
 *
 * SAFETY / PRIVACY:
 *   - Makes ZERO network requests. Captured data never leaves your machine; it
 *     lives only in the in-memory `store` Map until you export it from the popup.
 *   - Does NOT patch fetch/XHR, does NOT scroll/click for you.
 *   - Injects NOTHING into Discord's page DOM. In this default mode it does not
 *     modify the page, make network requests, or run code in Discord's main JS
 *     world — it only reads the rendered DOM from Chrome's isolated extension
 *     world (a passive MutationObserver, invisible to page JS).
 *   - The optional "High-fidelity" toggle is the one exception: it injects a
 *     read-only main-world fiber reader (fiber-reader.js) on demand; see its
 *     header and the README for that mode's separate, honest trade-offs.
 *
 * You scroll the channel by hand; the observer notices when Discord renders new
 * messages and harvests them from the DOM. Deduped by message id.
 *
 * Layout (pure, DOM-free helpers live in lib.js; see window.__DME below):
 *   1. Discord DOM selectors  — SEL: the hashed class selectors, centralized
 *   2. capture state          — the store Map + session/channel state
 *   3. fiber transport        — opt-in high-fidelity MessagePort plumbing
 *   4. extraction helpers      — read one <li> → a message record's fields
 *   5. capture                 — MutationObserver lifecycle (start/stop/capture)
 *   6. export builders         — channel/identity scrape, filename, JSON/DCE
 *   7. transcript              — plain-text builder (adapter over lib.js)
 *   8. popup messaging         — state(), healthCheck(), the onMessage router
 */

(() => {
  "use strict";
  if (window.__discordManualExport) return;
  // Pure, DOM-free helpers live in lib.js (loaded first — see manifest
  // content_scripts.js order) and are exposed on window.__DME in this
  // extension's isolated world, so Node can also unit-test them. Everything
  // below is DOM-, location-, or capture-state-bound and stays here.
  //
  // Fail safe: if lib.js somehow didn't run (it always does, given the manifest
  // order), bail out cleanly BEFORE touching window.__DME. This runs in the
  // isolated world — invisible to Discord — but we still never want to surface
  // an uncaught error, so a missing lib makes the content script inert, not throw.
  if (!window.__DME) return;
  window.__discordManualExport = true;

  const {
    rgbToHex, parseCount, userIdFromAvatar, replyScore, exportStamp,
    sanitizeFilePart, splitNameHandle, resolveReferenceId, SYSTEM_TYPES,
    STICKER_FORMAT, MEDIA_HOST, GIF_HOST, MEDIA_EXT,
    // export transforms (pure) — the builders below are thin adapters over these
    cleanMessage, dceMessage, renderTranscript, diagnostics,
  } = window.__DME;

  /* ---------------- Discord DOM selectors (hashed → brittle; centralized) ----
   * Discord ships obfuscated, hashed class names, so we match on stable
   * substrings/prefixes. When Discord changes its DOM this is the ONE place to
   * update. Plain-HTML selectors (br, img[alt], time[datetime], a[href], video,
   * source, [data-id], …) are left inline at their call sites — they don't rot. */
  const SEL = {
    // message list + nodes
    chatList: '[data-list-id="chat-messages"]',
    chatMessage: 'li[id^="chat-messages-"]',
    scroller: '[class*="scroller"]',
    // author / meta
    username: '[class*="username"]',
    avatar: 'img[class*="avatar"]',
    botTag: '[class*="botTag"]',
    systemMessage: '[class*="systemMessage"]',
    mention: '[class*="mention"]',
    // content / edit markers
    messageContent: '[id^="message-content-"]',
    edited: '[class*="edited"]',
    editedOrHidden: '[class*="edited"], [class*="hiddenVisually"]',
    // reactions
    reactions: '[class*="reactions"]',
    reactionInner: '[class*="reactionInner"]',
    reactionCount: '[class*="reactionCount"]',
    // replies
    replyContext: '[id^="message-reply-context-"]',
    repliedMessage: '[class*="repliedMessage"]',
    repliedTextContent: '[class*="repliedTextContent"]',
    repliedTextPreview: '[class*="repliedTextPreview"]',
    // accessories: media / stickers / embeds
    accessories: '[id^="message-accessories-"]',
    sticker: '[data-type="sticker"], [class*="stickerAsset"]',
    embedFull: '[class*="embedFull"]',
    embedTitle: '[class*="embedTitle"]',
    embedDescription: '[class*="embedDescription"]',
    embedProvider: '[class*="embedProvider"]',
    embedAuthor: '[class*="embedAuthor"]',
    embedFooter: '[class*="embedFooter"]',
    embedField: '[class*="embedField"]',
    embedFieldName: '[class*="embedFieldName"]',
    embedFieldValue: '[class*="embedFieldValue"]',
    embedImageOrThumb: '[class*="embedImage"], [class*="embedThumbnail"]',
    embedOriginalLink: 'a[class*="originalLink"]',
    // headers / identity scraping
    titleWrapper: '[class*="titleWrapper"]',
    title: '[class*="title_"]',
    titleSection: 'section[class*="title"]',
    titleH1: '[class*="title_"] h1',
    h1Title: 'h1[class*="title"]',
    panels: '[class*="panels_"]',
    panelsSection: 'section[class*="panels"]',
    // sidebar guild-name candidates (first non-channel-name match wins)
    guildNameCandidates: [
      '[class*="headerContent"]',
      '[class*="guildName"]',
      '[class*="nameAndDecorators"]',
    ],
  };

  /* ---------------- capture state ---------------- */

  const store = new Map(); // messageId -> record
  let observer = null;
  let debounceTimer = null;
  let capturing = false;
  // Bind capture to one channel so navigating away can't mix channels, and so
  // exports use the CAPTURED channel's metadata, not whatever URL is live now.
  let captureCtx = null; // { key, channel, guildChannel } snapshot at start
  let storeChannelKey = null; // channel the store's messages belong to
  let captureStartedAt = null;
  let captureStoppedAt = null;
  let stoppedReason = null; // "user" | "channelChanged"

  function channelKey() {
    const m = location.pathname.match(/channels\/([^/]+)\/([^/]+)/);
    return m ? m[1] + "/" + m[2] : location.href;
  }

  /* ---------------- high-fidelity fiber transport ---------------- */

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
      ["referenceId", "authorId", "username", "globalName", "nick", "discriminator", "editedTimestamp"].forEach(
        (k) => {
          if (fm[k]) ex[k] = fm[k];
        }
      );
      if (typeof fm.type === "number") ex.type = fm.type; // 0 is valid, don't skip
      fiberStore.set(fm.id, ex);
      // Backfill a display author on the store record if the DOM couldn't get it
      // (e.g. a grouped continuation that led the viewport with no group header).
      const rec = store.get(fm.id);
      if (rec && !rec.author) {
        const disp = fm.nick || fm.globalName || fm.username;
        if (disp) rec.author = disp;
      }
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
      // Fail closed: if the private port never answers, high-fidelity is simply
      // unavailable on this tab. We never fall back to putting data on the bus.
      clearTimeout(fiberTimer);
      fiberTimer = setTimeout(() => {
        if (fiberEnabled && !portConfirmed) portFailed = true;
      }, 800);
    } catch (e) {}
  }

  function requestFiber() {
    // Only read while a capture is actively running, so enabling High-fidelity
    // never reads message metadata before the user presses Start capture.
    if (!capturing || !fiberEnabled || !fiberPort) return;
    try {
      fiberPort.postMessage({ cmd: "read" }); // private port only — never the window bus
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

  // (No window-bus receive path: fiber data only ever arrives over the private
  // MessagePort, so no export data touches the shared window message bus.)

  /* ---------------- extraction helpers ---------------- */

  function extractText(node) {
    if (!node) return "";
    const clone = node.cloneNode(true);
    // Drop the "(edited)" indicator and any screen-reader-only text (Discord's
    // hiddenVisually spans carry things like the edit-tooltip date and the
    // "<guild>:" prefix in channel headers).
    clone
      .querySelectorAll(SEL.editedOrHidden)
      .forEach((e) => e.remove());
    // Preserve hard line breaks (textContent doesn't include <br> newlines).
    clone.querySelectorAll("br").forEach((br) => {
      br.replaceWith(document.createTextNode("\n"));
    });
    clone.querySelectorAll("img[alt]").forEach((img) => {
      img.replaceWith(document.createTextNode(img.getAttribute("alt") || ""));
    });
    return clone.textContent.replace(/​/g, "").trim();
  }

  function isInReplyContext(el) {
    return !!(
      el.closest(SEL.replyContext) ||
      el.closest(SEL.repliedMessage)
    );
  }

  function getAuthorEl(li) {
    const els = li.querySelectorAll(SEL.username);
    for (const el of els) {
      if (isInReplyContext(el)) continue;
      return el;
    }
    return null;
  }

  function getAvatarUrl(li) {
    const imgs = li.querySelectorAll(SEL.avatar);
    for (const img of imgs) {
      if (isInReplyContext(img)) continue;
      const src = img.getAttribute("src");
      if (src) return src;
    }
    return null;
  }

  // Role color is an inline color on the name element (only set for colored
  // roles). rgbToHex (lib.js) converts Discord's "rgb(r, g, b)" to hex.
  function getRoleColor(authEl) {
    return authEl && authEl.style ? rgbToHex(authEl.style.color) : null;
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
    const cont = li.querySelector(SEL.reactions);
    if (!cont) return out;
    cont.querySelectorAll(SEL.reactionInner).forEach((inner) => {
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
      const countEl = inner.querySelector(SEL.reactionCount);
      const count = countEl ? parseCount(countEl.textContent) : 1;
      if (emoji) out.push({ emoji, count, id, url });
    });
    return out;
  }

  function getReply(li) {
    const ctx =
      li.querySelector(SEL.replyContext) ||
      li.querySelector(SEL.repliedMessage);
    if (!ctx) return null;
    const authEl = ctx.querySelector(SEL.username);
    const contentEl =
      ctx.querySelector(SEL.repliedTextContent) ||
      ctx.querySelector(SEL.repliedTextPreview);
    // The preview reuses the referenced message's own message-content-<id>
    // element, so its id is the exact replied-to message id.
    const idEl = ctx.querySelector(SEL.messageContent);
    const messageId = idEl ? idEl.id.replace("message-content-", "") : null;
    const author = authEl ? extractText(authEl) : null;
    const content = contentEl ? extractText(contentEl) : null;
    if (!author && !content && !messageId) return null;
    return { author, content, messageId };
  }

  // (replyScore lives in lib.js — scores reply-preview completeness so a later,
  // fuller capture can replace a lazily-loaded placeholder.)

  // Attachments/media live in <div id="message-accessories-…">. Host allowlists
  // (MEDIA_HOST/GIF_HOST) and MEDIA_EXT live in lib.js.
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
    const acc = li.querySelector(SEL.accessories);
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
      // Real uploads only. Stickers (also under media.discordapp.net) are handled
      // by getStickers, so they're intentionally excluded here to avoid dupes.
      const isUpload =
        MEDIA_HOST.test(url.hostname) && /\/attachments\//.test(url.pathname);
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
    const hasRealFile = items.some((i) => MEDIA_EXT.test(i.filename || ""));
    if (hasRealFile) {
      items = items.filter(
        (i) => !(i.type === "gif" && !MEDIA_EXT.test(i.filename || ""))
      );
    }
    return items;
  }

  // Exact edit time: the "(edited)" marker is wrapped in a <time datetime=…>.
  function getEditedTimestamp(li) {
    const contentEl = getContentEl(li);
    const ed = contentEl && contentEl.querySelector(SEL.edited);
    const t = ed && ed.closest("time[datetime]");
    return t ? t.getAttribute("datetime") : null;
  }

  // @-mentions in the message body (display names; user IDs aren't in the DOM).
  function getMentions(li) {
    const contentEl = getContentEl(li);
    if (!contentEl) return [];
    const out = [];
    const seen = new Set();
    contentEl.querySelectorAll(SEL.mention).forEach((m) => {
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

  function getStickers(li) {
    const acc = li.querySelector(SEL.accessories);
    if (!acc) return [];
    const out = [];
    const seen = new Set();
    // Sticker assets carry clean data-* attributes (data-id / data-name / format).
    acc
      .querySelectorAll(SEL.sticker)
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
    const acc = li.querySelector(SEL.accessories);
    if (!acc) return [];
    const out = [];
    acc.querySelectorAll(SEL.embedFull).forEach((em) => {
      const titleEl = em.querySelector(SEL.embedTitle);
      const descEl = em.querySelector(SEL.embedDescription);
      const title = titleEl ? extractText(titleEl) : null;
      const description = descEl ? extractText(descEl) : null;
      if (!title && !description) return; // pure media embed — already in media
      const anchor =
        (titleEl && titleEl.querySelector("a[href]")) ||
        (titleEl && titleEl.closest("a[href]"));
      const providerEl = em.querySelector(SEL.embedProvider);
      const authorEl = em.querySelector(SEL.embedAuthor);
      const footerEl = em.querySelector(SEL.embedFooter);
      const fields = [];
      em.querySelectorAll(SEL.embedField).forEach((f) => {
        const n = f.querySelector(SEL.embedFieldName);
        const v = f.querySelector(SEL.embedFieldValue);
        if (n || v)
          fields.push({
            name: n ? extractText(n) : "",
            value: v ? extractText(v) : "",
          });
      });
      const imgWrap = em.querySelector(
        SEL.embedImageOrThumb
      );
      let imageUrl = null;
      if (imgWrap) {
        const orig = imgWrap.querySelector(SEL.embedOriginalLink);
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
    const els = li.querySelectorAll(SEL.messageContent);
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
    return document.querySelector(SEL.chatList);
  }

  function capture() {
    // A debounced pass can still be queued when stop() runs; ignore it so Stop
    // takes effect immediately and never captures after the observer is gone.
    if (!capturing) return;
    // Channel changed under us (navigation) — stop rather than mix messages.
    if (captureCtx && channelKey() !== captureCtx.key) {
      stoppedReason = "channelChanged";
      stop();
      return;
    }
    const list = getList();
    if (!list) return;
    const items = list.querySelectorAll(SEL.chatMessage);
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
        // Exclude the reply preview so replying to a bot doesn't mark you a bot.
        currentIsBot = [...li.querySelectorAll(SEL.botTag)].some(
          (e) => !isInReplyContext(e)
        );
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
        isSystem: !!li.querySelector(SEL.systemMessage),
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
        // Reactions reflect current state (incl. removals). Overwrite when the
        // message shows a reactions bar (present-but-empty = all removed); but if
        // no reactions container rendered this pass, keep what we had rather than
        // wipe a good set during a partial/lazy re-render.
        if (record.reactions.length || li.querySelector(SEL.reactions))
          existing.reactions = record.reactions;
        if (record.media.length && !existing.media.length)
          existing.media = record.media;
        // If the message was edited since we captured it, refresh content + time.
        const wasEdited =
          record.editedTimestamp &&
          record.editedTimestamp !== existing.editedTimestamp;
        if (record.editedTimestamp)
          existing.editedTimestamp = record.editedTimestamp;
        if (record.stickers.length && !existing.stickers.length)
          existing.stickers = record.stickers;
        if (record.embeds.length && !existing.embeds.length)
          existing.embeds = record.embeds;
        if (record.mentions.length && !existing.mentions.length)
          existing.mentions = record.mentions;
        if (record.content && (wasEdited || !existing.content))
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
    const key = channelKey();
    // Starting in a different channel than the stored data? Clear to avoid mixing.
    if (storeChannelKey && storeChannelKey !== key) {
      store.clear();
      fiberStore.clear();
    }
    storeChannelKey = key;
    captureCtx = null; // so the snapshot below reads live channel info
    capturing = true;
    captureStartedAt = new Date().toISOString();
    captureStoppedAt = null;
    stoppedReason = null;
    capture();
    // Snapshot the @handle map too: it's scraped from the (channel-specific) DM
    // header + account panel, so it must be frozen here — reading it live at
    // export time would use whatever channel you've since navigated to.
    captureCtx = {
      key,
      channel: channelInfo(),
      guildChannel: dceGuildChannel(),
      usernameMap: buildUsernameMap(),
    };
    const list = getList();
    const target =
      (list && (list.closest(SEL.scroller) || list.parentElement)) ||
      document.getElementById("app-mount") ||
      document.body;
    observer = new MutationObserver(debouncedCapture);
    observer.observe(target, { childList: true, subtree: true });
  }

  function stop() {
    if (!capturing) return;
    capturing = false;
    clearTimeout(debounceTimer); // cancel any capture already queued by the observer
    captureStoppedAt = new Date().toISOString();
    if (!stoppedReason) stoppedReason = "user";
    if (observer) observer.disconnect();
    observer = null;
  }

  function clearAll() {
    store.clear();
    fiberStore.clear();
    // If we're not mid-capture, drop the channel snapshot too so a later export
    // doesn't reuse stale channel metadata.
    if (!capturing) {
      captureCtx = null;
      storeChannelKey = null;
    }
  }

  /* ---------------- export builders (return strings; popup saves them) ---------------- */

  // Discord's message header renders the DISPLAY name, not the account username.
  // The real @handle only appears in a few places (DM header, account panel),
  // which we scrape here to fill author.name. Everything is local DOM reading.
  // (HANDLE_RE + splitNameHandle — the pure "split display name from handle"
  // logic — live in lib.js; the DOM scraping below stays here.)

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

  function dmHeaderInfo() {
    const sels = [
      SEL.titleWrapper,
      SEL.title,
      SEL.titleSection,
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
      document.querySelector(SEL.panels) ||
      document.querySelector(SEL.panelsSection);
    if (!panel) return null;
    const info = splitNameHandle(leafTexts(panel));
    return info.displayName ? info : null;
  }

  // displayName -> username, from the DM recipient and the logged-in account.
  function buildUsernameMap() {
    if (captureCtx && captureCtx.usernameMap) return captureCtx.usernameMap; // snapshot
    const map = new Map();
    [dmHeaderInfo(), accountPanelInfo()].forEach((info) => {
      if (info && info.username) map.set(info.displayName, info.username);
    });
    return map;
  }

  // The channel the user is looking at RIGHT NOW (live DOM/URL), ignoring any
  // capture snapshot. Used by state() so the popup always reflects where you are.
  function liveChannelInfo() {
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
        document.querySelector(SEL.titleH1) ||
        document.querySelector(SEL.h1Title);
      // extractText drops the hidden "<guild>:" accessibility prefix, leaving
      // just the visible channel name.
      if (titleEl) name = extractText(titleEl);
    }
    if (!name) name = document.title.replace(/^\(\d+\)\s*/, "").trim();
    return { id, name, url: location.href };
  }

  function channelInfo() {
    if (captureCtx && captureCtx.channel) return captureCtx.channel; // captured snapshot
    return liveChannelInfo();
  }

  // System/notification messages (pins, joins, boosts, …) are dropped from
  // exports. The authoritative signal is the numeric message type from the fiber
  // reader; a DOM class is the fallback. The SYSTEM_TYPES set lives in lib.js.
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

  // (pad2, exportStamp, and sanitizeFilePart — the pure filename-formatting
  // helpers — live in lib.js.)

  // DCE-style filename, with a per-capture timestamp so each export is uniquely
  // named (see exportStamp — prevents a re-import from dropping an earlier
  // capture of the same channel). The [channelId] stays at the end like DCE.
  //   "<guild> - <category> - <channel> - <date_time> [<channelId>].<ext>"
  //   DMs: "Direct Messages - <recipient> - <date_time> [<channelId>].<ext>"
  function exportName(ext) {
    const { guild, channel } = dceGuildChannel();
    const isDm = guild.id === "0";
    const parts = isDm
      ? ["Direct Messages", channel.name]
      : [guild.name, channel.category, channel.name];
    const prefix =
      parts.map(sanitizeFilePart).filter(Boolean).join(" - ") ||
      "discord-export";
    return `${prefix} - ${exportStamp()} [${channel.id || "channel"}].${ext}`;
  }

  // (cleanMessage — the clean JSON shape — lives in lib.js.)

  // Export diagnostics adapter: supplies the pure diagnostics() (lib.js) with the
  // state it can't derive from the message list — raw store size, high-fidelity
  // flags/transport, and a health warning.
  function captureDiagnostics(messages) {
    return diagnostics(messages, {
      rawCapturedCount: store.size,
      highFidelityEnabled: fiberEnabled,
      highFidelityDataCaptured: fiberStore.size > 0,
      highFidelityTransport: fiberTransport(),
      healthWarning: healthCheck(),
    });
  }

  function buildJsonString() {
    const messages = sortedMessages().map((r) => {
      const c = cleanMessage(r);
      const fib = fiberStore.get(r.id);
      if (fib) {
        if (fib.username) c.username = fib.username;
        if (fib.authorId) c.authorId = fib.authorId;
        if (fib.referenceId && c.replyTo) c.replyTo.messageId = fib.referenceId;
      }
      return c;
    });
    return JSON.stringify(
      {
        channel: channelInfo(),
        capturedAt: new Date().toISOString(),
        session: {
          startedAt: captureStartedAt,
          stoppedAt: captureStoppedAt,
          channelKey: captureCtx ? captureCtx.key : channelKey(),
          stoppedReason,
        },
        captureQuality: captureDiagnostics(messages),
        messageCount: messages.length,
        messages,
      },
      null,
      2
    );
  }

  /* ---------------- DiscordChatExporter-compatible JSON ----------------
   * Best-effort match of DCE's schema so the file drops into tools that read
   * DCE exports. Most fields come from the DOM (plus the fiber reader when the
   * High-fidelity toggle is on). Attachment ids/sizes are the main things still
   * left empty; author ids, @handles, reply ids, embeds, stickers, and edit
   * times are filled where available. */

  function dceGuildChannel() {
    if (captureCtx && captureCtx.guildChannel) return captureCtx.guildChannel; // snapshot
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
    for (const s of SEL.guildNameCandidates) {
      const el = document.querySelector(s);
      const t = el ? extractText(el) : ""; // extractText drops hidden a11y text
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

  // (dceMessage — one record → a DCE-compatible message object — plus dceEmoji
  // and the DCE_TYPE table live in lib.js.)

  // Discord doesn't put the referenced message's id in the DOM. resolveReferenceId
  // (lib.js) resolves the link locally by matching the reply preview
  // (author + text) against earlier captured messages. Purely local, no network.

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
    // Real captured range, drawn from the messages' own UTC (`Z`) timestamps —
    // offset-bearing, so a parser reads an unambiguous instant. Lexicographic
    // order equals chronological order for ISO-8601 UTC strings.
    const stamps = records.map((r) => r.timestamp).filter(Boolean).sort();
    const after = stamps.length ? stamps[0] : null;
    const before = stamps.length ? stamps[stamps.length - 1] : null;
    return JSON.stringify(
      {
        guild,
        channel,
        dateRange: { after, before },
        exportedAt: new Date().toISOString(),
        messages,
        messageCount: messages.length,
      },
      null,
      2
    );
  }

  /* transcript (messageLines + renderTranscript formatting live in lib.js) */

  function buildTranscript() {
    const messages = sortedMessages(); // never drop captured messages
    // Surface quality issues (warnings) at the top so they can't be missed.
    return renderTranscript(messages, captureDiagnostics(messages).warnings);
  }

  /* ---------------- popup messaging ---------------- */

  // High-fidelity transport state, surfaced so the popup never silently degrades.
  function fiberTransport() {
    if (!fiberEnabled) return "off";
    if (portConfirmed) return "MessagePort";
    if (portFailed) return "unavailable";
    return "connecting";
  }

  // Detect likely DOM breakage so the popup can warn instead of sitting at zero.
  function healthCheck() {
    const list = getList();
    if (!list) return "No Discord message list found — open a channel.";
    if (list.querySelectorAll(SEL.chatMessage).length === 0)
      return "Message list found but no message nodes — Discord's DOM may have changed.";
    return null;
  }

  function state() {
    // Count what will actually export (system messages are filtered out).
    const count = [...store.values()].filter((r) => !isSystemMessage(r)).length;
    // Always report the LIVE channel so the popup reflects where you are now,
    // not a stale snapshot from a previous Start in another channel.
    const liveName = liveChannelInfo().name || null;
    const capturedName =
      captureCtx && captureCtx.channel ? captureCtx.channel.name : null;
    // True when captured data belongs to a channel other than the live one.
    const navigatedAway = !!(captureCtx && captureCtx.key !== channelKey());
    return {
      capturing,
      count,
      fiber: fiberEnabled,
      fiberStatus: fiberTransport(),
      warning: healthCheck(),
      channelName: liveName,
      capturedChannelName: capturedName,
      navigatedAway,
      stoppedReason: !capturing ? stoppedReason : null,
    };
  }

  // One-line quality note shown in the popup after an export.
  function qualitySummary() {
    const msgs = sortedMessages();
    const missingAuthor = msgs.filter((m) => !m.author).length;
    const replies = msgs.filter((m) => m.replyTo);
    const unresolved = replies.filter(
      (m) => !(m.replyTo && m.replyTo.messageId)
    ).length;
    const parts = [`${msgs.length} exported`];
    if (missingAuthor) parts.push(`${missingAuthor} missing author`);
    if (unresolved) parts.push(`${unresolved} unresolved replies`);
    return parts.join(" · ");
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case "getState":
        sendResponse(state());
        break;
      case "setFiber":
        teardownFiber(); // close any existing session first (no leaked port/listener)
        if (msg.on) {
          fiberNonce = msg.nonce || null;
          fiberEnabled = true;
          setupFiberChannel();
          requestFiber();
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
        sendResponse({
          filename: exportName("json"),
          text: buildJsonString(),
          summary: qualitySummary(),
        });
        break;
      case "buildText":
        sendResponse({
          filename: exportName("txt"),
          text: buildTranscript(),
          summary: qualitySummary(),
        });
        break;
      case "buildDce":
        sendResponse({
          filename: exportName("dce.json"),
          text: buildDceJson(),
          summary: qualitySummary(),
        });
        break;
      default:
        sendResponse(null);
    }
    return true;
  });
})();
