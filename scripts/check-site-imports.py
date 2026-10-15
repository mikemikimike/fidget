#!/usr/bin/env python3
"""Fail when a page in the assembled site imports a module the site lacks.

Every relative ES module import in SITE/*.html (a module script's `src`, or a
static `import ... from "./x.js"` / `import "./x.js"` inside an inline module
script) must name a file inside SITE. A file that assembly forgets to copy then
breaks the build instead of the published page.

Usage: check-site-imports.py SITE
"""

import re
import sys
from html.parser import HTMLParser
from pathlib import Path

# Static imports only; `from` may follow a multi-line specifier list.
IMPORT = re.compile(r"""\bimport\s*(?:[\w*{}\s,$]+?\s*from\s*)?["']([^"']+)["']""", re.S)


class Modules(HTMLParser):
    def __init__(self):
        super().__init__()
        self.specifiers = []
        self._inline = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag != "script" or attrs.get("type") != "module":
            return
        if attrs.get("src"):
            self.specifiers.append(attrs["src"])
        else:
            self._inline = []

    def handle_data(self, data):
        if self._inline is not None:
            self._inline.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self._inline is not None:
            self.specifiers += IMPORT.findall("".join(self._inline))
            self._inline = None


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip().splitlines()[-1])
    site = Path(sys.argv[1]).resolve()
    if not site.is_dir():
        sys.exit(f"{site} is not a directory")
    errors = []
    for page in sorted(site.glob("*.html")):
        parser = Modules()
        parser.feed(page.read_text(encoding="utf-8"))
        for spec in parser.specifiers:
            if not spec.startswith(("./", "../", "/")):
                continue  # bare or absolute URL: not ours to serve
            target = (site / spec.lstrip("/")) if spec.startswith("/") else (page.parent / spec)
            target = target.resolve()
            if site not in target.parents or not target.is_file():
                errors.append(f"{page.name} imports {spec}, which is not in {site.name}")
    for error in errors:
        print(error, file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
