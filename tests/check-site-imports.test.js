// scripts/check-site-imports.mjs is the Pages build's guard against a page
// that loads a script assembly forgot to copy. Each test builds a tiny site.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { check, specifiers } from "../scripts/check-site-imports.mjs";

const scratch = mkdtempSync(join(tmpdir(), "site-imports-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let count = 0;
function site(files) {
  const dir = join(scratch, `site-${count++}`);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
const page = (body) => `<!doctype html><html><body>${body}</body></html>`;
const inline = (js) => page(`<script type="module">${js}</script>`);

test("a whole site passes", () => {
  assert.deepEqual(check(site({
    "index.html": page(`<script src="./a.js"></script><script type="module" src="/b.js"></script>`)
      + inline(`import { b } from "./b.js";`),
    "a.js": "console.log(1);",
    "b.js": `export * from "./lib/c.js"; export const b = 1;`,
    "lib/c.js": "export const c = 1;",
  })), []);
});

test("a missing static import fails", () => {
  assert.deepEqual(check(site({ "index.html": inline(`import {\n  x,\n} from "./gone.js";`) })),
    ['index.html (inline module): imports "./gone.js" is not in the site']);
});

test("a missing export-from fails", () => {
  assert.deepEqual(check(site({ "index.html": inline(`export { x as y } from "./gone.js";`) })),
    ['index.html (inline module): imports "./gone.js" is not in the site']);
});

test("a missing dynamic import fails", () => {
  assert.deepEqual(check(site({ "index.html": inline(`const m = await import("./gone.js");`) })),
    ['index.html (inline module): imports "./gone.js" is not in the site']);
});

test("a missing script src fails, classic or module", () => {
  assert.deepEqual(check(site({ "index.html": page(`<script src="old.js"></script><script type="module" src="./m.js"></script>`) })),
    ['index.html: loads "old.js" is a bare specifier, which no page here can resolve',
      'index.html: loads "./m.js" is not in the site']);
  assert.deepEqual(check(site({ "index.html": page(`<script src="./old.js"></script>`) })),
    ['index.html: loads "./old.js" is not in the site']);
});

test("a missing transitive import fails, naming the file that imports it", () => {
  assert.deepEqual(check(site({
    "index.html": inline(`import "./a.js";`),
    "a.js": `import { b } from "./b.js";`,
    "b.js": `export { c } from "./sub/c.js";`,
  })), ['b.js: imports "./sub/c.js" is not in the site']);
});

test("external URLs pass", () => {
  assert.deepEqual(check(site({
    "index.html": page(`<script src="https://cdn.example.com/x.js"></script>`)
      + inline(`import x from "https://esm.sh/x"; import("//cdn.example.com/y.js");`),
  })), []);
});

test("imports in comments, strings, templates and regexes are ignored", () => {
  const js = [
    `// import "./a.js";`,
    `/* export * from "./b.js"; import("./c.js") */`,
    `const s = 'import "./d.js"';`,
    "const t = `import(\"./e.js\") ${'x'}`;",
    `const r = /import "\\.\\/f.js"/;`,
    `obj.import("./g.js"); console.log(import.meta.url);`,
  ].join("\n");
  assert.deepEqual(specifiers(js), []);
  assert.deepEqual(check(site({ "index.html": inline(js) + "<!-- <script src='./h.js'></script> -->" })), []);
});
