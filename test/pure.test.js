/*
 * Unit tests for the pure helper kernel (lib.js). Every exported function and
 * constant table has at least one assertion here; the full export builders are
 * covered separately by golden.test.js.
 *
 * TZ is pinned to UTC because the transcript formatters (fmtTime/fmtDate/dayKey)
 * read local time — the same pin the goldens were generated under.
 */

process.env.TZ = "UTC";

const test = require("node:test");
const assert = require("node:assert/strict");

const lib = require("../lib.js");
const fixtures = require("../test-support/records");

/* ---------------- parsing / formatting ---------------- */

test("rgbToHex converts rgb() to hex, else null", () => {
  assert.equal(lib.rgbToHex("rgb(233, 30, 99)"), "#e91e63");
  assert.equal(lib.rgbToHex("rgba(0, 0, 0, 0.5)"), "#000000");
  assert.equal(lib.rgbToHex(""), null);
  assert.equal(lib.rgbToHex("not a color"), null);
});

test("parseCount expands abbreviated reaction counts", () => {
  assert.equal(lib.parseCount("5"), 5);
  assert.equal(lib.parseCount("1.2K"), 1200);
  assert.equal(lib.parseCount("3M"), 3000000);
  assert.equal(lib.parseCount("1,234"), 1234);
  assert.equal(lib.parseCount(""), 1); // no text → assume 1
});

test("userIdFromAvatar extracts the id, or null for default avatars", () => {
  assert.equal(
    lib.userIdFromAvatar("https://cdn.discordapp.com/avatars/1001/hash.webp"),
    "1001"
  );
  assert.equal(
    lib.userIdFromAvatar(
      "https://cdn.discordapp.com/guilds/9/users/2002/avatars/h.webp"
    ),
    "2002"
  );
  assert.equal(
    lib.userIdFromAvatar("https://cdn.discordapp.com/embed/avatars/3.png"),
    null
  );
  assert.equal(lib.userIdFromAvatar(null), null);
});

test("pad2 zero-pads to two digits", () => {
  assert.equal(lib.pad2(3), "03");
  assert.equal(lib.pad2(42), "42");
});

test("exportStamp is a filename-safe date_time with no colons", () => {
  assert.match(lib.exportStamp(), /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
});

test("sanitizeFilePart strips illegal filename chars and collapses spaces", () => {
  assert.equal(lib.sanitizeFilePart('a/b:c*?"<>|'), "abc");
  assert.equal(lib.sanitizeFilePart("  x   y  "), "x y");
  assert.equal(lib.sanitizeFilePart(null), "");
});

/* ---------------- transcript formatting ---------------- */

test("fmtTime formats 12-hour local time (UTC)", () => {
  assert.equal(lib.fmtTime(new Date("2026-07-01T09:05:00Z")), "9:05 AM");
  assert.equal(lib.fmtTime(new Date("2026-07-01T00:00:00Z")), "12:00 AM");
  assert.equal(lib.fmtTime(new Date("2026-07-01T13:07:00Z")), "1:07 PM");
});

test("fmtDate formats a long local date (UTC)", () => {
  assert.equal(
    lib.fmtDate(new Date("2026-07-01T00:00:00Z")),
    "Wednesday, Jul 1, 2026"
  );
});

test("fmtDelta buckets a ms gap into +s/+m/+h/+d", () => {
  assert.equal(lib.fmtDelta(30000), "+30s");
  assert.equal(lib.fmtDelta(90000), "+1m");
  assert.equal(lib.fmtDelta(3 * 3600 * 1000), "+3h");
  assert.equal(lib.fmtDelta(2 * 86400 * 1000), "+2d");
});

test("dayKey is a local Y-M-D key (month 0-indexed, UTC)", () => {
  assert.equal(lib.dayKey(new Date("2026-07-01T00:00:00Z")), "2026-6-1");
});

test("oneLine collapses newlines to single spaces", () => {
  assert.equal(lib.oneLine("a\n  b\nc"), "a b c");
  assert.equal(lib.oneLine(null), "");
});

/* ---------------- media / reactions ---------------- */

test("mediaTag maps media type to a tag", () => {
  assert.equal(lib.mediaTag({ type: "gif" }), "[GIF]");
  assert.equal(lib.mediaTag({ type: "image" }), "[IMG]");
  assert.equal(lib.mediaTag({ type: "video" }), "[VIDEO]");
  assert.equal(lib.mediaTag({ type: "file" }), "[FILE]");
  assert.equal(lib.mediaTag({ type: "other" }), "[MEDIA]");
});

test("dceEmoji strips colons and detects animated custom emoji", () => {
  assert.deepEqual(
    lib.dceEmoji({ emoji: ":partyblob:", id: "9001", url: "x/9001.gif" }),
    { id: "9001", name: "partyblob", code: "", isAnimated: true, imageUrl: "x/9001.gif" }
  );
  assert.deepEqual(lib.dceEmoji({ emoji: "👍", id: "", url: "" }), {
    id: "",
    name: "👍",
    code: "",
    isAnimated: false,
    imageUrl: "",
  });
});

/* ---------------- replies / completeness scoring ---------------- */

test("replyScore rewards a resolved, non-placeholder reply", () => {
  assert.equal(lib.replyScore(null), -1);
  assert.equal(
    lib.replyScore({ messageId: "m1", author: "A", content: "hi" }),
    6
  );
  // placeholder content loses the "clean content" point
  assert.equal(
    lib.replyScore({ messageId: null, author: "A", content: "could not be loaded" }),
    2
  );
});

test("normText / normAuthor normalize whitespace and @", () => {
  assert.equal(lib.normText("  a\n b "), "a b");
  assert.equal(lib.normAuthor("@Bob"), "Bob");
});

test("resolveReferenceId matches a reply preview to an earlier message", () => {
  const all = [
    { id: "a", author: "Dave", content: "check link", timestamp: "2026-07-01T14:00:00Z", replyTo: null },
    {
      id: "b",
      author: "Eve",
      content: "agreed",
      timestamp: "2026-07-02T10:00:00Z",
      replyTo: { author: "Dave", content: "check link", messageId: null },
    },
  ];
  assert.equal(lib.resolveReferenceId(all[1], all), "a");
  assert.equal(lib.resolveReferenceId(all[0], all), ""); // no replyTo
});

/* ---------------- identity ---------------- */

test("splitNameHandle separates a display name from a handle", () => {
  assert.deepEqual(lib.splitNameHandle(["Display Name", "handle_1"]), {
    displayName: "Display Name",
    username: "handle_1",
  });
  assert.deepEqual(lib.splitNameHandle(["Only Display"]), {
    displayName: "Only Display",
    username: null,
  });
});

/* ---------------- constant tables ---------------- */

test("message-type tables and host allowlists", () => {
  assert.equal(lib.SYSTEM_TYPES.has(7), true); // GuildMemberJoin
  assert.equal(lib.SYSTEM_TYPES.has(0), false); // Default is content
  assert.equal(lib.STICKER_FORMAT[2], "Apng");
  assert.equal(lib.DCE_TYPE[19], "Reply");
  assert.equal(lib.MEDIA_HOST.test("cdn.discordapp.com"), true);
  assert.equal(lib.MEDIA_HOST.test("evil.com"), false);
  assert.equal(lib.GIF_HOST.test("media.tenor.com"), true);
  assert.equal(lib.MEDIA_EXT.test("a.png"), true);
  assert.equal(lib.MEDIA_EXT.test("gifs/page"), false);
  assert.equal(lib.HANDLE_RE.test("bob_h"), true);
  assert.equal(lib.HANDLE_RE.test("Bob!"), false);
});

/* ---------------- export transforms ---------------- */

test("cleanMessage keeps only the documented fields and copies replyTo", () => {
  const rec = fixtures.guild.records.find((r) => r.id === "m2");
  const c = lib.cleanMessage(rec);
  assert.equal("avatarUrl" in c, false); // internal-only field excluded
  assert.equal("color" in c, false);
  assert.equal("isBot" in c, false);
  assert.equal(c.id, "m2");
  assert.notEqual(c.replyTo, rec.replyTo); // a copy, not the same object
  assert.deepEqual(c.replyTo, rec.replyTo);
});

test("dceMessage builds a DCE message; username falls back sensibly", () => {
  const rec = fixtures.guild.records.find((r) => r.id === "m1");
  // fiber username wins
  const withFib = lib.dceMessage(rec, "111", "222", new Map(), { username: "alice_h", type: 0 });
  assert.equal(withFib.author.name, "alice_h");
  assert.equal(withFib.type, "Default");
  // else usernameMap, else display name
  const map = new Map([["Alice", "mapped_handle"]]);
  assert.equal(lib.dceMessage(rec, "111", "222", map, null).author.name, "mapped_handle");
  assert.equal(lib.dceMessage(rec, "111", "222", new Map(), null).author.name, "Alice");
  // a reply record → type Reply and a reference object
  const reply = fixtures.guild.records.find((r) => r.id === "m7");
  const dm = lib.dceMessage(reply, "111", "222", new Map(), null);
  assert.equal(dm.type, "Reply");
  assert.deepEqual(dm.reference, { messageId: "", channelId: "222", guildId: "111" });
});

test("messageLines renders reply quote, body, and trailing reactions", () => {
  const lines = lib.messageLines({
    replyTo: { author: "Alice", content: "hi\nthere" },
    content: "line one\nline two",
    reactions: [{ emoji: "👍", count: 5 }],
    media: [{ type: "image" }],
  });
  assert.deepEqual(lines, [
    "  > Alice: hi there",
    "  line one",
    "  line two",
    "  [IMG] ^{👍:5}", // reactions attach to the last body line
  ]);
});

test("renderTranscript groups by day/author and prepends warnings", () => {
  const messages = [
    { id: "a", author: "Alice", content: "hi", timestamp: "2026-07-01T09:00:00Z", reactions: [] },
    { id: "b", author: "Alice", content: "again", timestamp: "2026-07-01T09:00:30Z", reactions: [] },
  ];
  const out = lib.renderTranscript(messages, ["heads up"]);
  assert.match(out, /^Export warnings:\n- heads up\n\n/);
  assert.match(out, /=== Wednesday, Jul 1, 2026 ===/);
  assert.match(out, /\[9:00 AM\] Alice:/);
  // grouped continuation stays under the same header (no second [time] Alice)
  assert.equal(out.match(/Alice:/g).length, 1);
  // empty warnings → no header
  assert.equal(lib.renderTranscript([], []).startsWith("Export warnings"), false);
});

test("diagnostics counts, and derives systemMessagesSkipped from meta", () => {
  const messages = [
    { author: "A", timestamp: "t", replyTo: { messageId: "x" }, media: [{}, {}] },
    { author: null, timestamp: null, replyTo: { messageId: null }, media: [] },
  ];
  const d = lib.diagnostics(messages, {
    rawCapturedCount: 5,
    highFidelityEnabled: true,
    highFidelityDataCaptured: true,
    highFidelityTransport: "MessagePort",
    healthWarning: "DOM changed",
  });
  assert.equal(d.rawCapturedCount, 5);
  assert.equal(d.exportedMessageCount, 2);
  assert.equal(d.systemMessagesSkipped, 3);
  assert.equal(d.missingAuthorCount, 1);
  assert.equal(d.missingTimestampCount, 1);
  assert.equal(d.replyLinksResolved, 1);
  assert.equal(d.replyLinksUnresolved, 1);
  assert.equal(d.mediaUrlCount, 2);
  assert.equal(d.highFidelityTransport, "MessagePort");
  // warnings include missing-author, missing-ts, and the health warning
  assert.equal(d.warnings.length, 3);
  assert.equal(d.warnings[2], "DOM changed");
  // no meta → rawCapturedCount falls back to messages.length, transport "off"
  const d2 = lib.diagnostics(messages);
  assert.equal(d2.rawCapturedCount, 2);
  assert.equal(d2.highFidelityTransport, "off");
});
