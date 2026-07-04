/*
 * One-shot generator for the golden export baselines.
 *
 * Run with `npm run goldens` (or `node test-support/generate-goldens.js`)
 * whenever the fixtures change on purpose. It runs the current content.js
 * builders over the fixtures and writes their output under test-support/golden/.
 * Commit the result: golden.test.js then diffs live output against these frozen
 * files, so regenerating is an INTENTIONAL act, never something the suite does.
 *
 * This lives in test-support/ (not test/) on purpose: `node --test` treats every
 * .js under a test/ directory as a test file and would run this generator —
 * silently rewriting the goldens mid-run and masking real drift.
 */

const fs = require("fs");
const path = require("path");
const fixtures = require("./records");
const { buildExports } = require("./load-content");

const OUT = path.join(__dirname, "golden");
fs.mkdirSync(OUT, { recursive: true });

const EXT = { json: "json", dce: "dce.json", transcript: "txt" };

let count = 0;
for (const [name, fx] of Object.entries(fixtures)) {
  const out = buildExports(fx);
  for (const [kind, ext] of Object.entries(EXT)) {
    const file = path.join(OUT, `${name}.${ext}`);
    fs.writeFileSync(file, out[kind], "utf8");
    count++;
    console.log("wrote", path.relative(path.join(__dirname, ".."), file));
  }
}
console.log(`\nGenerated ${count} golden file(s).`);
