import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

// Resolve through each application's PostCSS copy, so these checks exercise
// the transitive package actually used by its framework rather than a test copy.
export function checkSourceMapSecurity(packageUrl) {
  const appRequire = createRequire(packageUrl);
  const postcssRequire = createRequire(appRequire.resolve("postcss/package.json"));
  const sourceMapPath = postcssRequire.resolve("source-map-js");
  const { SourceMapConsumer } = postcssRequire("source-map-js");
  const css = ".synthetic { color: red; }\n";
  const flatMap = { version: 3, file: "synthetic.css", sources: ["synthetic.scss"],
    sourcesContent: [css], names: [], mappings: "AAAA" };
  const indexedMap = (line, column = 0, map = flatMap) => ({ version: 3,
    sections: [{ offset: { line, column }, map }] });

  test("source-map sections reject huge, malformed, and combined nested offsets", () => {
    // Constructor checks are safe even on the affected release: never flatten
    // a deliberately huge map in the test runner's own process.
    for (const value of [Number.MAX_SAFE_INTEGER, Infinity, NaN, -1, 0.5, "2", null])
      assert.throws(() => new SourceMapConsumer(indexedMap(value)), /Section offset/);
    for (const value of [Infinity, NaN, -1, 0.5, "2", null])
      assert.throws(() => new SourceMapConsumer(indexedMap(0, value)), /Section offset/);
    assert.throws(() => new SourceMapConsumer(indexedMap(7_000_000, 0, indexedMap(7_000_000))), /Section offset/);
  });

  test("source-map conversion cannot amplify mappings beyond generated text", () => {
    // Bound time/memory in a child process: a dependency regression must not hang
    // or exhaust the test runner. The offset is valid but far beyond actual CSS.
    const source = `
      const { SourceMapConsumer, SourceNode } = require(process.argv[1]);
      const css = ${JSON.stringify(css)};
      const map = ${JSON.stringify(indexedMap(9_999_999))};
      const node = SourceNode.fromStringWithSourceMap(css, new SourceMapConsumer(map));
      process.stdout.write(JSON.stringify(node.toString()));
    `;
    const result = spawnSync(process.execPath, ["--max-old-space-size=64", "-e", source, sourceMapPath],
      { encoding: "utf8", timeout: 3000, maxBuffer: 16_384 });
    assert.equal(result.error, undefined, "Sparse-map conversion must finish within its resource limits.");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), css);
  });

  test("PostCSS retains valid original-source mappings after the security update", async () => {
    const postcss = appRequire("postcss");
    const result = await postcss([]).process(css, { from: "synthetic.css", to: "output.css",
      map: { prev: flatMap, inline: false, annotation: false } });
    assert.equal(result.css, css);
    const consumer = new SourceMapConsumer(result.map.toJSON());
    const original = consumer.originalPositionFor({ line: 1, column: 0 });
    assert.equal(original.source, "synthetic.scss");
    assert.equal(original.line, 1);
    assert.equal(consumer.sourceContentFor(original.source), css);
  });
}
