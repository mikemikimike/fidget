# OpenRouter support on the Model API and the Harness presets

Anchor: `faa34b9f` on `main`, 2026-10-18. Every Fidget citation below is read
against that tree. The spike is #1614.

This note answers one question: what does Fidget need to run on
[OpenRouter](https://openrouter.ai)? It covers both AI sources. The first is
the Model API, which is the HTTP Completer in `src-tauri/src/model.rs`. The
second is the Harness presets in `harness::launch`.

Claims carry one of three labels:

- **Measured** means it ran here on 2026-10-18, with unauthenticated requests
  to `openrouter.ai`.
- **Source** means it was read in Fidget's code or on an OpenRouter docs page,
  and the page is linked.
- **Inferred** means it was reasoned from the other two and nothing ran.

No OpenRouter key was available. Nothing authenticated ran, so no streamed
turn, reasoning delta, or mid-stream error was observed on the wire. Fidget
did not run.

---

## Summary

The Model API already reaches OpenRouter. Set Base URL to
`https://openrouter.ai/api`, Model to an OpenRouter slug such as
`anthropic/claude-haiku-5.5`, and API key to the OpenRouter key. Three gaps
remain, and each one is small. The first is a bug that any proxy hosted under
a path prefix also has.

1. The preflight and `probe-model` ask `https://openrouter.ai/v1/models`. That
   URL answers 404, so every launch logs a false "staying on StaticDirector".
2. If the slug is wrong, the preflight prints every served id. That is 471 ids
   and 12,173 characters, all on one line.
3. OpenRouter reports some errors as HTTP 200 with an `error` field and
   `finish_reason: "error"`. Fidget reads such a turn as a finished reply. The
   error message never reaches the Action Log.

Adding OpenRouter to the Base URL picker is one row in `ENDPOINTS`.

The Harness presets need no Fidget code. A Harness runs on OpenRouter through
its own config, not through Fidget. Fidget passes no provider key to a Harness
on purpose. A Finder-launched Fidget also passes only `PATH` from the login
shell. Claude, Codex, OpenCode, Pi, Goose, and Hermes can be pointed at
OpenRouter. Copilot, Cursor, Grok, and Antigravity cannot. The deliverable for
the Harness half is a documented recipe, proven once with a real key.

## Model API: what already works

**URL join (Source).** `completions_url` appends `/v1/chat/completions` to a
base that does not end in `/v1`. It appends only `/chat/completions` to a base
that does. Both `https://openrouter.ai/api` and `https://openrouter.ai/api/v1`
therefore resolve to `https://openrouter.ai/api/v1/chat/completions`, which is
OpenRouter's chat path ([API overview](https://openrouter.ai/docs/api-reference/overview)).
`host_is_xai` is false for `openrouter.ai`, so the Responses path is never
chosen.

**Auth (Source, Measured).** `Endpoint::headers` sends
`Authorization: Bearer <key>`. That is OpenRouter's scheme
([authentication](https://openrouter.ai/docs/api_reference/authentication.md)).
`is_local` is false for `openrouter.ai`, so `endpoint_from` refuses to build an
`Endpoint` without a key. This matches every hosted row. Without a key, chat
answers 401 with `{"error":{"message":"No cookie auth credentials found","code":401}}`
(Measured). `status_error` already reports a non-2xx status with its body.

**Streaming (Source).** OpenRouter holds the connection open with
`: OPENROUTER PROCESSING` comment lines. It ends the stream with `data: [DONE]`
([streaming](https://openrouter.ai/docs/api-reference/streaming)). `read_frames`
skips every line that does not start with `data:` and stops on `[DONE]`.

**Reasoning (Source, Measured).** OpenRouter streams thinking as
`delta.reasoning`
([reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md)).
`read_event` already reads `chunk["reasoning"]` as a thought. A thinking model
therefore fills the Thinking row and earns `THINK_CEILING` on the next turn,
as on vLLM and Ollama.

**Unsupported parameters (Source).** OpenRouter ignores a parameter the model
does not support, rather than refusing it (API overview). So no 400 ever names
one, and the `Field` fallbacks in `Endpoint::post` never fire on OpenRouter.

**Reasoning effort (Measured).** Fidget sends effort as a top-level
`reasoning_effort`, while OpenRouter documents `reasoning: {effort}`. Of 471
listed models, 209 name `reasoning_effort` in `supported_parameters` and 341
name `reasoning` (`GET /api/v1/models`). On a model that takes only
`reasoning`, the effort is dropped without a word (Inferred). This is
acceptable for v1, because a blank effort is the default.

**Turn ceiling (Measured, Source).** Of 471 models, 458 list `max_tokens` and
79 list `max_completion_tokens`. The `Field::Cap` rename is not needed. On the
13 models that list neither, no ceiling applies (Inferred).

The ceiling has a gap that is not OpenRouter's. `Endpoint::wire_budget` sends
`TURN_CEILING` (1024) until a turn on the host has marked its thinking, and
only then `THINK_CEILING` (8192). On OpenRouter, the host is one URL for every
model. Two cases follow (Inferred):

- The first turn of a reasoning model goes out at 1024 and can end as
  "spent all 1024 tokens thinking". This is the same first-turn cost as on any
  other host.
- A model whose provider does not stream its reasoning as text never marks.
  OpenRouter returns some reasoning only as encrypted `reasoning_details`
  (reasoning tokens docs). Such a model stays at 1024 on every turn, while its
  hidden reasoning still counts against the 1024.

Both cases already have a lever: `FIDGET_DIRECTOR_MAX_TOKENS` and its Settings
row. A keyed probe on one encrypted-reasoning model would show whether the
second case is real.

**Usage chunk (Source).** On chat completions, the last chunk before `[DONE]`
carries `usage` and one choice with empty content (streaming docs).
`read_event` takes its empty `delta.content` as no text. The reply is
unchanged.

## Model API: what breaks

### 1. The `/v1/models` preflight asks the wrong URL

`spawn_preflight` and `run_probe` build the models URL as
`format!("{origin}/v1/models")`, where `origin` is scheme, host, and port only.
The base path is lost.

| URL | Answer (Measured) |
|---|---|
| `https://openrouter.ai/v1/models` (what Fidget asks) | 404, `text/html` |
| `https://openrouter.ai/api/v1/models` (the real path) | 200, `application/json`, 471 models |

`preflight_verdict` turns the 404 into
`director: https://openrouter.ai /v1/models answered 404; staying on StaticDirector until it answers`.
The message is false. The preflight is diagnostic only, and the next wake
still goes out, so the Director works. But the first line the user reads says
it does not. `run_probe`, behind `scripts/probe-model.sh`, asks the same URL
and prints `/v1/models answered 404`.

Fix the root cause rather than special-casing OpenRouter. Derive the models
URL from the inference URL. Replace a trailing `/chat/completions` or
`/responses` with `/models`. This gives `/v1/models` on every host that works
today. It also gives `/api/v1/models` on OpenRouter, and the right path on any
other proxy mounted under a prefix (Inferred).

### 2. A wrong slug floods the log

When the model is not served, `preflight_verdict` joins every served id into
one message. OpenRouter serves 471 ids, and the joined list is 12,173
characters (Measured). OpenRouter slugs also look alike. `anthropic/claude-haiku-5.5`
and `anthropic/claude-haiku-5.5:batch` are both listed. A user who typed
`claude-haiku-5.5` without the vendor prefix gets the whole catalog. Cap the
list, for example at the ten closest ids, or name only the count.

### 3. A 200 that carries an error reads as a reply

OpenRouter returns the HTTP error status only for invalid requests and missing
credits. Any other failure after routing starts comes back as status 200, with
the error in the body or in an SSE event
([errors](https://openrouter.ai/docs/api_reference/errors-and-debugging.md)).
A mid-stream error looks like this
([limits](https://openrouter.ai/docs/api_reference/limits.md)):

```json
{"error":{"code":429,"message":"Rate limit exceeded"},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}
```

`read_event` reads any `finish_reason` as `finished`. It flags only `length` as
truncated. The turn therefore ends as `Streamed::Complete` (Source):

- With no text before the error, `reply_from` returns
  `streamed reply had no text content`. The wake fails, and the Action Log
  loses OpenRouter's message (Inferred).
- With text before the error, the partial text is spoken as if whole. Its
  first line is parsed as a Behavior (Inferred).

The cases that matter for a desktop pet are 429 on a `:free` model and 402
when credits run out. Free models allow 20 requests per minute, and 50 per day
on an account that has bought less than 10 credits (limits). Proactive model
calls from one Character Instance can reach the daily cap in a working day
(Inferred).

The fix runs through three places. `Event` gains the error message.
`read_frames` stops on it and returns it, which needs a new `Streamed` variant.
`reply_from` turns that variant into `Unsent::Failed` that carries
`error.message`. `content_from_body` does the same for the non-streaming
answer. Any OpenAI-compatible host that reports errors in-band benefits.

### 4. Not needed

- **Attribution headers:** `HTTP-Referer` and `X-OpenRouter-Title` only list
  the app on OpenRouter's rankings
  ([app attribution](https://openrouter.ai/docs/app-attribution.md)). Fidget
  sends `User-Agent: fidget`. Skip them until someone asks to be listed.
- **`reasoning_details` passback:** OpenRouter asks callers to send it back for
  encrypted reasoning in tool loops. The HTTP Completer runs no tools. Its
  session stores only answer text.
- **Provider routing, `models` fallbacks, and `:nitro`:** Each one is a request
  field Fidget has no Settings row for. A slug suffix such as `:nitro` already
  works through the Model field (Inferred).

## Model API: Settings and onboarding

**Base URL picker (Source).** `ENDPOINTS` in `settings/form.rs` lists the rows.
OpenRouter is one more hosted row:

```rust
("Hosted", "OpenRouter", "https://openrouter.ai/api"),
```

The row is the host plus `/api`, because `completions_url` adds `/v1` and the
path. `endpoint_title` matches the trimmed base exactly, so a user who types
`https://openrouter.ai/api/v1` rests on Custom. That is the current behavior
for `https://api.openai.com/v1` too.

The README's Model API paragraph names the presets it fills. Adding a row
makes that list stale. The README is the owner's copy, so the PR names the
line and leaves the wording to the owner.

**Key entry (Source).** Today the user creates a key on
openrouter.ai and pastes it. OpenRouter also has OAuth PKCE
([OAuth](https://openrouter.ai/docs/guides/overview/auth/oauth.md)). A headless
variant shows a code for the user to paste, so it needs no callback server.
The code is single-use and lasts 10 minutes. `POST /api/v1/auth/keys`
exchanges it for a key, and Fidget would store that key in the keychain like a
pasted key. This is the one OpenRouter-specific feature that changes what the
user does. It is not needed to support OpenRouter, so it is listed as a
decision below.

## Harness presets

### Fidget's side

`Launch::command` builds the Harness child with the inherited environment. Its
doc comment says no provider key goes in, "because one overrides a
subscription login with no prompt" (Source). `docs/harness.md` adds that a
Finder-launched Fidget takes only `PATH` from the login shell (Source). A
`export ANTHROPIC_BASE_URL=...` in `.zshrc` therefore reaches the Harness only
when Fidget starts from a terminal (Inferred).

Each Harness needs its provider set in its own config, such as the user's
`~/.codex/config.toml`. Fidget does not read or write that config (Source).

Fidget does write one thing a Harness reads as a model. The Harness Model row
goes out through `session/set_config_option`. For Codex,
`sync_codex_project_config` also writes `model` and `model_reasoning_effort`
into a project `.codex/config.toml` under Fidget's data directory (Source).
Under OpenRouter, that value has to be an OpenRouter slug. Whether each
adapter accepts a slug it did not list is unverified.

### Per preset

| Preset | Route to OpenRouter | Fidget change | Status |
|---|---|---|---|
| `claude` | Claude Code with `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN=<key>`, and `ANTHROPIC_API_KEY=""`, through OpenRouter's Anthropic-compatible `/api/v1/messages` ([Claude Code guide](https://openrouter.ai/docs/guides/guides/claude-code-integration.md)). The Agent SDK under `claude-agent-acp` uses the same variables ([Agent SDK guide](https://openrouter.ai/docs/guides/community/anthropic-agent-sdk)). | None | Endpoint answers 401 in Anthropic error shape without a key (Measured). OpenRouter guarantees this only with Anthropic as the provider (Source). |
| `codex` | `model_provider = "openrouter"` and a `[model_providers.openrouter]` table with `base_url = "https://openrouter.ai/api/v1"` in `~/.codex/config.toml` ([Codex guide](https://openrouter.ai/docs/guides/guides/codex-cli.md)) | None | `/api/v1/responses` exists and answers 401 without a key (Measured). It is stateless and refuses `store: true` or `previous_response_id` with 400 ([Responses](https://openrouter.ai/docs/api_reference/responses/overview.md)). Whether `codex-acp` sends either field is unverified. |
| `pi` | Its own config in `~/.pi/agent/`. `docs/harness.md` also says that an unconfigured Pi may pick up an ambient provider key from the environment. | None | The ambient-key route is Source. That Pi takes OpenRouter is Inferred. |
| `opencode`, `goose`, `hermes` | Each has its own provider config | None | Inferred from each project's provider support. Not read this session. |
| `copilot`, `cursor-agent`, `grok`, `antigravity` | None. Each runs on its vendor's account | None | Out of scope (Inferred). |

For `claude`, the variables have to reach the adapter. Claude Code's
`settings.json` takes an `env` block, which works however Fidget was started.
That changes every Claude Code session on the machine, not only Fidget's
(Inferred). The recipe has to say so.

### What the Harness half needs

Add a section to `docs/harness.md` with the `claude` and `codex` recipes. First
run the recipes once against a real key and record the transcript on the
issue, as `docs/harness.md` asks of every probe. No launch preset, Settings
row, or environment injection is proposed. Each of those would undo the
no-provider-key rule in `Launch::command`, and the rule exists so that a user's
subscription login is never replaced without a prompt.

## Follow-ups, ready to file

1. **`fix(model): Derive the models URL from the inference URL`.** Fixes
   gap 1 in `spawn_preflight` and `run_probe`. Add a test for
   `https://openrouter.ai/api` next to the existing `completions_url` cases.
2. **`fix(model): Cap the served-model list in the preflight verdict`.** Fixes
   gap 2.
3. **`fix(model): Read an in-band error as a failed turn`.** Fixes gap 3 in
   `read_event`, `read_frames`, `reply_from`, and `content_from_body`. Test it with canned SSE
   bytes through `read_stream`, as the existing stream tests do.
4. **`feat(settings): Add OpenRouter to the Base URL picker`.** One
   `ENDPOINTS` row. Depends on 1, so the first launch after a pick does not
   log a false failure.
5. **`docs(harness): Run Claude and Codex on OpenRouter`.** A keyed probe,
   then the recipes. Needs a funded OpenRouter key.

## Open decisions

1. Should OpenRouter get a row in the Base URL picker? The recommendation is
   yes, after follow-up 1.
2. Should `docs/harness.md` carry OpenRouter recipes for `claude` and `codex`?
   The recommendation is yes, after a keyed probe.
3. Should "Sign in with OpenRouter" (OAuth PKCE) be filed for V2? It is not
   needed for support. It only removes the step of pasting a key.
