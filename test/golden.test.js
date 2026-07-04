/*
 * Golden snapshot test — the behavior safety net for the content.js refactor.
 *
 * It loads the CURRENT content.js (whatever phase it's in), runs the export
 * builders over the fixtures, and asserts the output byte-for-byte against the
 * frozen goldens in test-support/golden/. As logic moves out of content.js in
 * later phases, any change to the three export shapes trips these assertions.
 *
 * If a diff is EXPECTED (fixtures changed on purpose), regenerate with
 * `npm run goldens` and review the diff before committing.
 */

process.env.TZ = "UTC"; // must match the generator's timezone

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const fixtures = require("../test-support/records");
const { buildExports } = require("../test-support/load-content");

const GOLD = path.join(__dirname, "..", "test-support", "golden");
const EXT = { json: "json", dce: "dce.json", transcript: "txt" };

for (const [name, fx] of Object.entries(fixtures)) {
  test(`golden exports — ${name} session`, () => {
    const out = buildExports(fx);
    for (const [kind, ext] of Object.entries(EXT)) {
      const file = path.join(GOLD, `${name}.${ext}`);
      const golden = fs.readFileSync(file, "utf8");
      assert.equal(
        out[kind],
        golden,
        `${name}.${ext} drifted from its golden — if intended, run \`npm run goldens\``
      );
    }
  });
}
