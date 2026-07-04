/*
 * Discord Manual Export — pure helper kernel (lib.js).
 *
 * DOM-free, state-free helpers extracted from content.js so they can be unit
 * tested in Node while still shipping as a plain content script. This file is
 * loaded BEFORE content.js (see manifest content_scripts.js order) and, in the
 * extension's isolated world, hangs its exports off `window.__DME`. Under Node
 * (tests) the same object is returned via module.exports.
 *
 * SAFETY / PRIVACY: like the rest of the extension this makes no network
 * requests, touches no storage, and reads/writes nothing outside these pure
 * functions. It never references the DOM, `location`, or capture state — those
 * remain in content.js.
 */
(function () {
  "use strict";

  /* ---------------- parsing / formatting ---------------- */

  // Convert Discord's "rgb(r, g, b)" (an inline role color) to the hex DCE
  // expects, else null. Callers read the rgb string off a DOM element.
  function rgbToHex(rgb) {
    const m = (rgb || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    const h = (n) => Number(n).toString(16).padStart(2, "0");
    return "#" + h(m[1]) + h(m[2]) + h(m[3]);
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

  // Reaction counts can be abbreviated ("1.2K"); parse that back to a number.
  function parseCount(text) {
    const m = (text || "").trim().match(/([\d.,]+)\s*([km]?)/i);
    if (!m) return 1;
    let n = parseFloat(m[1].replace(/,/g, ""));
    if (isNaN(n)) return 1;
    if (/k/i.test(m[2])) n *= 1000;
    else if (/m/i.test(m[2])) n *= 1e6;
    return Math.round(n) || 1;
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  // Local date+time, filename-safe (no colons). The time makes each capture's
  // filename unique, so re-importing several captures of one channel never lets
  // one file supersede another by name (which would drop the earlier capture's
  // messages before dedup runs). Local, not UTC: this is only a human-readable
  // label, and it reads naturally next to when you clicked export. The instants
  // INSIDE the JSON stay UTC (Discord's `Z` timestamps) so dedup is unambiguous.
  function exportStamp() {
    const d = new Date();
    return (
      `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
      `_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`
    );
  }

  // Strip characters not allowed in filenames.
  function sanitizeFilePart(s) {
    return (s || "")
      .replace(/[\\/:*?"<>|\r\n\t]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /* ---------------- transcript formatting ---------------- */

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

  /* ---------------- media / reactions ---------------- */

  // We only trust Discord's own CDN/proxy hosts (filters out UI icons and
  // external links) plus known GIF hosts.
  const MEDIA_HOST = /(^|\.)discordapp\.(com|net)$/;
  const GIF_HOST = /(^|\.)(tenor|giphy|klipy|gfycat)\.com$/;
  // Real media file extensions — distinguishes an actual file from a gif-page link.
  const MEDIA_EXT = /\.(mp4|webm|mov|gif|png|jpe?g|webp|apng)$/i;

  function mediaTag(m) {
    if (m.type === "gif") return "[GIF]";
    if (m.type === "image") return "[IMG]";
    if (m.type === "video") return "[VIDEO]";
    if (m.type === "file") return "[FILE]";
    return "[MEDIA]";
  }

  const STICKER_FORMAT = { 1: "Png", 2: "Apng", 3: "Lottie", 4: "Gif" };

  // Custom-emoji reaction → DCE emoji object. r.emoji is a unicode char or
  // ":name:"; id/url come from the reaction image when it's a custom emoji.
  function dceEmoji(r) {
    const name = r.emoji.replace(/^:|:$/g, "");
    return {
      id: r.id || "",
      name,
      code: "",
      isAnimated: /\.gif(\?|$)/i.test(r.url || ""),
      imageUrl: r.url || "",
    };
  }

  /* ---------------- replies / completeness scoring ---------------- */

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

  function normText(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }
  function normAuthor(s) {
    return (s || "").replace(/^@/, "").trim();
  }

  // Discord doesn't put the referenced message's id in the DOM. If the replied-to
  // message was itself captured, resolve the link locally by matching the reply
  // preview (author + text) against earlier messages. Purely local, no network.
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

  /* ---------------- identity / handles ---------------- */

  // Discord account @handles look like this (used to pick the handle out of a
  // display-name + handle pair scraped from the DM header / account panel).
  const HANDLE_RE = /^[a-z0-9._]{2,32}$/;

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

  /* ---------------- message-type tables ---------------- */

  // System/notification messages (pins, joins, boosts, …) — dropped from exports.
  // Authoritative signal is the numeric message type (from the fiber reader);
  // a DOM class is the fallback when high-fidelity is off. Content types
  // (0 Default, 19 Reply, 20 ChatInputCommand, 21 ThreadStarterMessage,
  // 23 ContextMenuCommand) are kept; unknown types are kept too (better than
  // dropping a future content type).
  const SYSTEM_TYPES = new Set([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 22, 24, 25, 26, 27,
    28, 29, 31, 32, 36, 37, 38, 39, 44, 46,
  ]);

  // Non-system message types → DCE's type strings (system types are filtered out).
  const DCE_TYPE = {
    0: "Default",
    19: "Reply",
    20: "ChatInputCommand",
    21: "ThreadStarterMessage",
    23: "ContextMenuCommand",
  };

  /* ---------------- export transforms (pure) ---------------- */

  // The documented, clean JSON shape (excludes internal-only fields like avatarUrl).
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
      // copy so enriching the export can't mutate the stored record
      replyTo: r.replyTo ? { ...r.replyTo } : null,
    };
  }

  // One record → a DiscordChatExporter-compatible message object. `fib` is the
  // fiber-reader enrichment (or null); `usernameMap` maps display name → @handle.
  function dceMessage(r, guildId, channelId, usernameMap, fib) {
    const display = r.author || "";
    // name = account @handle: prefer the fiber reader's exact username, then the
    // DM-header/panel scrape, else fall back to the display name.
    const username =
      (fib && fib.username) || (usernameMap && usernameMap.get(display)) || display;
    return {
      id: r.id,
      // Exact type from the fiber reader when available, else the reply heuristic.
      type: (fib && DCE_TYPE[fib.type]) || (r.replyTo ? "Reply" : "Default"),
      timestamp: r.timestamp,
      timestampEdited: (fib && fib.editedTimestamp) || r.editedTimestamp || null,
      callEndedTimestamp: null,
      isPinned: false,
      content: r.content || "",
      author: {
        id: (fib && fib.authorId) || r.authorId || "",
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

  // One transcript message → its indented body lines (reply quote, content,
  // media/sticker tags, with reactions appended to the last line).
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

  // Full plain-text transcript from already-sorted messages, with the diagnostics
  // `warnings` surfaced at the top. Groups by author/day, uses +deltas within a day.
  function renderTranscript(messages, warnings) {
    const lines = [];
    let prevDate = null;
    let prevDayKey = null;
    let curAuthor = null;

    messages.forEach((msg) => {
      const d = msg.timestamp ? new Date(msg.timestamp) : null;
      const newDay = !!d && dayKey(d) !== prevDayKey;

      if (newDay) {
        if (lines.length) lines.push("");
        lines.push(`=== ${fmtDate(d)} ===`);
        prevDayKey = dayKey(d);
        curAuthor = null;
      }

      const startNew = newDay || msg.author !== curAuthor || !!msg.replyTo;
      if (startNew) {
        lines.push("");
        const stamp = !d
          ? "unknown time"
          : prevDate && !newDay
          ? fmtDelta(d - prevDate)
          : fmtTime(d);
        lines.push(`[${stamp}] ${msg.author || "Unknown"}:`);
        curAuthor = msg.author;
      }

      messageLines(msg).forEach((l) => lines.push(l));
      if (d) prevDate = d;
    });

    const header = warnings && warnings.length
      ? "Export warnings:\n" + warnings.map((w) => "- " + w).join("\n") + "\n\n"
      : "";
    return header + lines.join("\n").replace(/^\n+/, "") + "\n";
  }

  // Export diagnostics (pure). Values the export can't derive from `messages`
  // alone — the raw store size, high-fidelity flags/transport, and a health
  // warning string — are passed in via `meta`.
  function diagnostics(messages, meta) {
    meta = meta || {};
    const rawCapturedCount =
      meta.rawCapturedCount != null ? meta.rawCapturedCount : messages.length;
    const replies = messages.filter((m) => m.replyTo);
    const resolved = replies.filter((m) => m.replyTo && m.replyTo.messageId).length;
    const missingAuthor = messages.filter((m) => !m.author).length;
    const missingTs = messages.filter((m) => !m.timestamp).length;
    const warnings = [];
    if (missingAuthor)
      warnings.push(
        `${missingAuthor} message(s) had no visible author — scroll over the group header and recapture, or enable High-fidelity.`
      );
    if (missingTs)
      warnings.push(
        `${missingTs} message(s) had no timestamp (shown as "unknown time" in the transcript).`
      );
    if (rawCapturedCount > 25000)
      warnings.push(
        "Large capture — exports are built as one in-memory string and may be memory-heavy."
      );
    if (meta.healthWarning) warnings.push(meta.healthWarning);
    return {
      rawCapturedCount,
      exportedMessageCount: messages.length,
      systemMessagesSkipped: rawCapturedCount - messages.length,
      missingAuthorCount: missingAuthor,
      missingTimestampCount: missingTs,
      replyLinksResolved: resolved,
      replyLinksUnresolved: replies.length - resolved,
      highFidelityEnabled: !!meta.highFidelityEnabled,
      highFidelityDataCaptured: !!meta.highFidelityDataCaptured,
      highFidelityTransport: meta.highFidelityTransport || "off",
      mediaUrlCount: messages.reduce(
        (n, m) => n + ((m.media && m.media.length) || 0),
        0
      ),
      warnings,
    };
  }

  /* ---------------- exports ---------------- */

  const DME = {
    rgbToHex,
    parseCount,
    userIdFromAvatar,
    replyScore,
    mediaTag,
    pad2,
    exportStamp,
    sanitizeFilePart,
    splitNameHandle,
    normText,
    normAuthor,
    resolveReferenceId,
    fmtTime,
    fmtDate,
    fmtDelta,
    dayKey,
    oneLine,
    dceEmoji,
    SYSTEM_TYPES,
    STICKER_FORMAT,
    DCE_TYPE,
    MEDIA_HOST,
    GIF_HOST,
    MEDIA_EXT,
    HANDLE_RE,
    cleanMessage,
    dceMessage,
    messageLines,
    renderTranscript,
    diagnostics,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = DME;
  if (typeof window !== "undefined") window.__DME = DME;
})();
