#!/usr/bin/env node
// Fails when the assembled site loads a script it does not serve.
//
// Usage: node scripts/check-site-imports.mjs SITE
//
// For every SITE/*.html it reads each <script src> (classic or module) and each
// inline module script. For every script, and every .js anywhere in SITE, it
// lexes the JavaScript and collects the static specifiers of `import ... from`,
// `import "x"`, `export ... from`, and `import("x")` with a plain string. Each
// local specifier (./, ../, /) must resolve to a file inside SITE, and that file
// is checked the same way. Other URLs (https:, //cdn) are not ours to serve and
// are skipped; a bare specifier is an error, since no page here has an import map.
//
// Zero dependencies: the repo installs nothing from npm in CI, so the lexer is
// here. It is a tokenizer, not a pattern match: comments, strings, template
// literals and regex literals are consumed as whole tokens, so an import inside
// any of them is never seen.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ID_START = /[\p{ID_Start}$_\\]/u;
const ID_PART = /[\p{ID_Continue}$_\u200c\u200d\\]/u;
// After these, `/` starts a regex literal rather than a division.
const BEFORE_REGEX = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await"]);

// Tokens: {t: "id"|"str"|"p"|"tpl"|"re"|"num", v}. Strings carry their decoded value
// only as far as specifiers need (escapes are kept verbatim except \' \" \\).
export function tokenize(src) {
  const out = [];
  const braces = []; // per open template `${`: brace depth inside it
  let i = 0;
  const n = src.length;
  const last = () => out[out.length - 1];
  const regexAllowed = () => {
    const p = last();
    if (!p) return true;
    if (p.t === "id") return BEFORE_REGEX.has(p.v);
    if (p.t === "p") return ![")", "]", "}"].includes(p.v);
    return false;
  };
  const template = () => {
    // i is just past "`" or the "}" closing a substitution.
    while (i < n) {
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { i++; return; }
      if (c === "$" && src[i + 1] === "{") { i += 2; braces.push(0); return; }
      i++;
    }
    throw new SyntaxError("unterminated template literal");
  };
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n" && src[i] !== "\r") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) throw new SyntaxError("unterminated comment");
      i = end + 2; continue;
    }
    if (c === "'" || c === '"') {
      let v = "";
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === "\n") throw new SyntaxError("unterminated string");
        if (src[i] === "\\") { v += src[i + 1]; i += 2; continue; }
        v += src[i++];
      }
      if (i >= n) throw new SyntaxError("unterminated string");
      i++;
      out.push({ t: "str", v });
      continue;
    }
    if (c === "`") { i++; template(); out.push({ t: "tpl" }); continue; }
    if (c === "}" && braces.length && braces[braces.length - 1] === 0) {
      braces.pop(); i++; template(); out.push({ t: "tpl" }); continue;
    }
    if (c === "/" && regexAllowed()) {
      i++;
      let cls = false;
      while (i < n) {
        const d = src[i];
        if (d === "\n") throw new SyntaxError("unterminated regex");
        if (d === "\\") { i += 2; continue; }
        if (d === "[") cls = true;
        else if (d === "]") cls = false;
        else if (d === "/" && !cls) break;
        i++;
      }
      i++;
      while (i < n && ID_PART.test(src[i])) i++;
      out.push({ t: "re" });
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_PART.test(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j) });
      i = j; continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9a-zA-Z_.]/.test(src[j])) j++;
      out.push({ t: "num" });
      i = j; continue;
    }
    if (c === "." && src[i + 1] === "." && src[i + 2] === ".") { out.push({ t: "p", v: "..." }); i += 3; continue; }
    if (c === "?" && src[i + 1] === ".") { out.push({ t: "p", v: "?." }); i += 2; continue; }
    if (braces.length) {
      if (c === "{") braces[braces.length - 1]++;
      else if (c === "}") braces[braces.length - 1]--;
    }
    out.push({ t: "p", v: c });
    i++;
  }
  return out;
}

// Static module specifiers in source order.
export function specifiers(src) {
  const tk = tokenize(src);
  const found = [];
  const is = (k, t, v) => tk[k] && tk[k].t === t && (v === undefined || tk[k].v === v);
  // From k, skip one `{ ... }` or `* [as name]` or a default binding list up to
  // `from`, and return the `from` string's index, or -1.
  const fromAfter = (k) => {
    for (; k < tk.length; k++) {
      if (is(k, "p", ";")) return -1;
      if (is(k, "id", "from") && is(k + 1, "str")) return k + 1;
      if (is(k, "p", "{")) { while (k < tk.length && !is(k, "p", "}")) k++; }
      else if (!(tk[k].t === "id" || is(k, "p", "*") || is(k, "p", ","))) return -1;
    }
    return -1;
  };
  for (let k = 0; k < tk.length; k++) {
    const prev = tk[k - 1];
    if (prev && prev.t === "p" && (prev.v === "." || prev.v === "?.")) continue; // obj.import
    if (is(k, "id", "import")) {
      if (is(k + 1, "p", "(")) {
        if (is(k + 2, "str") && (is(k + 3, "p", ")") || is(k + 3, "p", ","))) found.push(tk[k + 2].v);
      } else if (is(k + 1, "str")) {
        found.push(tk[k + 1].v);
      } else if (!is(k + 1, "p", ".")) {
        const s = fromAfter(k + 1);
        if (s >= 0) found.push(tk[s].v);
      }
    } else if (is(k, "id", "export") && (is(k + 1, "p", "*") || is(k + 1, "p", "{"))) {
      const s = fromAfter(k + 1);
      if (s >= 0) found.push(tk[s].v);
    }
  }
  return found;
}

// <script> elements in an HTML page: [{src, module, body}]. A small scanner, not
// a full HTML parser: it skips comments and reads a script's raw text to its
// closing tag, which is all the HTML spec lets a script body do.
export function scripts(html) {
  const found = [];
  let i = 0;
  const lower = html.toLowerCase();
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3; continue;
    }
    if (!lower.startsWith("<script", lt) || !/[\s>/]/.test(html[lt + 7] ?? "")) { i = lt + 1; continue; }
    // Attributes up to the tag's ">", honouring quoted values.
    const attrs = {};
    let j = lt + 7;
    while (j < html.length && html[j] !== ">") {
      if (/[\s/]/.test(html[j])) { j++; continue; }
      let k = j;
      while (k < html.length && !/[\s=>/]/.test(html[k])) k++;
      const name = html.slice(j, k).toLowerCase();
      let value = "";
      if (html[k] === "=") {
        k++;
        const q = html[k];
        if (q === '"' || q === "'") { const e = html.indexOf(q, k + 1); value = html.slice(k + 1, e); k = e + 1; }
        else { const s = k; while (k < html.length && !/[\s>]/.test(html[k])) k++; value = html.slice(s, k); }
      }
      attrs[name] = value;
      j = k;
    }
    const close = lower.indexOf("</script", j);
    const body = html.slice(j + 1, close < 0 ? html.length : close);
    found.push({ src: attrs.src, module: (attrs.type ?? "").trim().toLowerCase() === "module", body });
    i = close < 0 ? html.length : close + 8;
  }
  return found;
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// Every problem as "where: what", empty when the site is whole.
export function check(siteDir) {
  const site = resolve(siteDir);
  const root = pathToFileURL(site + sep).href;
  const errors = [];
  const queued = new Set();
  const queue = [];
  const enqueue = (file) => { if (!queued.has(file)) { queued.add(file); queue.push(file); } };
  const name = (file) => relative(site, file).split(sep).join("/");
  // Returns the local file a specifier names, or null when it is not ours.
  const target = (spec, fromFile, where, kind) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.startsWith("//")) return null; // external URL
    if (!(spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/"))) {
      errors.push(`${where}: ${kind} "${spec}" is a bare specifier, which no page here can resolve`);
      return null;
    }
    // The site is served from its root, so "/x.js" is SITE/x.js.
    const url = spec.startsWith("/") ? new URL(`.${spec}`, root) : new URL(spec, pathToFileURL(fromFile).href);
    const file = fileURLToPath(url);
    if (!url.href.startsWith(root)) { errors.push(`${where}: ${kind} "${spec}" points outside the site`); return null; }
    if (!existsSync(file) || !statSync(file).isFile()) { errors.push(`${where}: ${kind} "${spec}" is not in the site`); return null; }
    return file;
  };
  const lex = (src, fromFile, where) => {
    let specs;
    try { specs = specifiers(src); } catch (e) { errors.push(`${where}: cannot lex: ${e.message}`); return; }
    for (const spec of specs) {
      const file = target(spec, fromFile, where, "imports");
      if (file) enqueue(file);
    }
  };
  for (const page of readdirSync(site).filter((f) => f.endsWith(".html")).sort()) {
    const file = join(site, page);
    for (const s of scripts(readFileSync(file, "utf8"))) {
      if (s.src !== undefined) {
        const js = target(s.src, file, page, "loads");
        if (js) enqueue(js);
      } else if (s.module) {
        lex(s.body, file, `${page} (inline module)`);
      }
    }
  }
  for (const f of walk(site).filter((f) => f.endsWith(".js")).sort()) enqueue(f);
  while (queue.length) {
    const file = queue.shift();
    if (file.endsWith(".js") || file.endsWith(".mjs")) lex(readFileSync(file, "utf8"), file, name(file));
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error("usage: node scripts/check-site-imports.mjs SITE");
    process.exit(2);
  }
  const errors = check(process.argv[2]);
  for (const e of errors) console.error(e);
  process.exit(errors.length ? 1 : 0);
}
