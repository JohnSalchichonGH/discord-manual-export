/*
 * Fixture "store records" for the Phase 0 golden baseline.
 *
 * Each record mirrors the exact shape content.js's capture() writes into the
 * in-memory `store` Map (see content.js:558). fiberStore mirrors mergeFiber()
 * (content.js:54), and ctx mirrors the captureCtx snapshot taken in start()
 * (content.js:648). These are hand-authored plain objects — NO DOM — so the
 * export builders can be exercised headlessly and deterministically.
 *
 * The set is deliberately dense: it exercises resolved + placeholder replies,
 * edits, media dedupe, stickers, embeds, abbreviated + custom-emoji reactions,
 * mentions, bots, both system-message signals (isSystem and fiber type), and
 * messages missing an author or a timestamp.
 */

// --- helpers to keep the fixtures terse -------------------------------------

function rec(over) {
  // Defaults match a "fresh" record so a fixture only lists what it exercises.
  return Object.assign(
    {
      id: null,
      author: null,
      authorId: null,
      avatarUrl: null,
      color: null,
      isBot: false,
      timestamp: null,
      content: "",
      editedTimestamp: null,
      media: [],
      stickers: [],
      embeds: [],
      mentions: [],
      reactions: [],
      replyTo: null,
      isSystem: false,
    },
    over
  );
}

// --- guild session ----------------------------------------------------------
// Timestamps span two calendar days (UTC) so the transcript emits a date
// separator and both absolute-time and +delta headers.

const guildRecords = [
  rec({
    id: "m1",
    author: "Alice",
    authorId: "1001",
    avatarUrl: "https://cdn.discordapp.com/avatars/1001/hash.webp",
    color: "#e91e63",
    timestamp: "2026-07-01T09:00:00.000Z",
    content: "Hello world",
    reactions: [
      { emoji: "👍", count: 5, id: "", url: "" },
      {
        emoji: ":partyblob:",
        count: 1200,
        id: "9001",
        url: "https://cdn.discordapp.com/emojis/9001.gif",
      },
    ],
  }),
  rec({
    id: "m2",
    author: "Bob",
    authorId: "1002",
    timestamp: "2026-07-01T09:00:30.000Z",
    content: "Reply to Alice",
    // Reply preview already carried the referenced id from the DOM.
    replyTo: { author: "Alice", content: "Hello world", messageId: "m1" },
  }),
  rec({
    id: "m3",
    author: "Bob",
    authorId: "1002",
    timestamp: "2026-07-01T09:02:00.000Z",
    content: "Edited message",
    editedTimestamp: "2026-07-01T09:03:00.000Z",
  }),
  rec({
    id: "m4",
    author: "Carol",
    authorId: "1003",
    timestamp: "2026-07-01T09:05:00.000Z",
    content: "Look at this",
    media: [
      {
        type: "image",
        url: "https://cdn.discordapp.com/attachments/1/2/pic.png",
        filename: "pic.png",
      },
      { type: "gif", url: "https://media.tenor.com/abc.gif", filename: "abc.gif" },
    ],
  }),
  rec({
    id: "m5",
    author: "Carol",
    authorId: "1003",
    timestamp: "2026-07-01T09:06:00.000Z",
    content: "",
    stickers: [
      {
        id: "5001",
        name: "blobwave",
        format: "Apng",
        url: "https://media.discordapp.net/stickers/5001.png",
      },
    ],
  }),
  rec({
    id: "m6",
    author: "Dave",
    authorId: "1004",
    timestamp: "2026-07-01T14:00:00.000Z",
    content: "check link",
    mentions: ["Alice"],
    embeds: [
      {
        title: "Example",
        url: "https://example.com",
        description: "An example description",
        provider: "Example",
        author: null,
        footer: "footer text",
        fields: [{ name: "Field 1", value: "Value 1" }],
        imageUrl: "https://example.com/img.png",
      },
    ],
  }),
  rec({
    id: "m7",
    author: "Eve",
    authorId: "1005",
    // New calendar day (UTC) -> transcript date separator.
    timestamp: "2026-07-02T10:00:00.000Z",
    content: "agreed",
    // No messageId on the preview: DCE must resolve it locally against m6.
    replyTo: { author: "Dave", content: "check link", messageId: null },
  }),
  rec({
    id: "m8",
    author: null,
    timestamp: "2026-07-02T10:01:00.000Z",
    content: "Alice pinned a message to this channel.",
    // System via DOM class -> filtered from every export.
    isSystem: true,
  }),
  rec({
    id: "m9",
    author: "Frank",
    authorId: "1006",
    timestamp: "2026-07-02T10:02:00.000Z",
    content: "Frank joined the server.",
    // System via fiber type (see fiberStore below) -> filtered.
  }),
  rec({
    id: "m10",
    author: null, // group continuation whose header never scrolled into view
    timestamp: "2026-07-02T10:03:00.000Z",
    content: "orphan continuation with no visible author",
  }),
  rec({
    id: "m11",
    author: "Grace",
    authorId: "1007",
    timestamp: null, // no timestamp -> "unknown time", sorts to the top
    content: "message with no timestamp",
  }),
  rec({
    id: "m12",
    author: "CoolBot",
    authorId: "1008",
    isBot: true,
    timestamp: "2026-07-02T10:05:00.000Z",
    content: "beep boop",
  }),
];

// fiberStore enrichment (mergeFiber shape). Exercises username/authorId/type
// override, referenceId, and fiber-driven system filtering (type 7).
const guildFiber = {
  m1: { type: 0, username: "alice_h", authorId: "1001" },
  m2: { type: 19, username: "bob_h", authorId: "1002", referenceId: "m1" },
  m9: { type: 7 }, // GuildMemberJoin -> system, dropped from exports
};

const guildCtx = {
  key: "111/222",
  channel: {
    id: "222",
    name: "general",
    url: "https://discord.com/channels/111/222",
  },
  guildChannel: {
    guild: { id: "111", name: "My Guild", iconUrl: "" },
    channel: {
      id: "222",
      type: "GuildTextChat",
      categoryId: "",
      category: "Text Channels",
      name: "general",
      topic: null,
    },
  },
  // displayName -> account @handle, for authors without fiber data.
  usernameMap: new Map([
    ["Dave", "dave_handle"],
    ["Carol", "carol_handle"],
  ]),
};

const guildSession = {
  startedAt: "2026-07-01T08:59:00.000Z",
  stoppedAt: "2026-07-02T10:06:00.000Z",
  stoppedReason: "user",
  channelKey: "111/222",
};

// --- DM session -------------------------------------------------------------
// Small; exercises the guild.id === "0" Direct Messages path in DCE/filenames.

const dmRecords = [
  rec({
    id: "d1",
    author: "Zoe",
    authorId: "2001",
    timestamp: "2026-07-03T18:00:00.000Z",
    content: "hey there",
  }),
  rec({
    id: "d2",
    author: "Me",
    authorId: "2002",
    timestamp: "2026-07-03T18:01:00.000Z",
    content: "hello!",
  }),
];

const dmFiber = {};

const dmCtx = {
  key: "@me/999",
  channel: {
    id: "999",
    name: "Zoe",
    url: "https://discord.com/channels/@me/999",
  },
  guildChannel: {
    guild: { id: "0", name: "Direct Messages", iconUrl: "" },
    channel: {
      id: "999",
      type: "DirectTextChat",
      categoryId: "",
      category: "",
      name: "Zoe",
      topic: null,
    },
  },
  usernameMap: new Map([["Zoe", "zoe_handle"]]),
};

const dmSession = {
  startedAt: "2026-07-03T17:59:00.000Z",
  stoppedAt: "2026-07-03T18:02:00.000Z",
  stoppedReason: "user",
  channelKey: "@me/999",
};

module.exports = {
  guild: {
    records: guildRecords,
    fiber: guildFiber,
    ctx: guildCtx,
    session: guildSession,
  },
  dm: {
    records: dmRecords,
    fiber: dmFiber,
    ctx: dmCtx,
    session: dmSession,
  },
};
