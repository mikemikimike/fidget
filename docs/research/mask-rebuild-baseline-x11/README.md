# Slim evidence pack for PR #968

Extracted from numbers and sample lines already published in
`docs/research/mask-rebuild-baseline-x11.md`. Not full TRACE dumps.

Source: Grok Bot desktop measurements recorded in that research doc.

`release-summary.txt` and `flamegraph-x11-mask.svg` (2026-10-26) come from
release-build runs of `scripts/flame-mask-rebuild-x11.sh` on the Grok Bot box.
The committed SVG is `mask.svg` re-rendered from the same folded stacks with
`inferno-flamegraph --width 1280`, since at 1200 px one cut-off label trips
codespell. Raw perf data and full logs stayed on the box.
