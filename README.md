# zalo-group-bot

A chat bot for **a single Zalo group**, powered by **NVIDIA NIM** (`nvidia/nemotron-3.5-super-vl-120b-a12b`), with **Tavily** for web search. Written in plain Node.js (ESM), **no runtime dependencies** — only the built-in `fetch`, `node:http` and `node:test`.

## Features

- Replies to messages in the group when it is **@mentioned** or someone **replies** to one of its messages (a Zalo Bot limitation — see below).
- **Multi-provider + model switching in chat**: `/model` to switch between DeepSeek Flash, DeepSeek Pro, Nemotron Super VL, **Nemotron 3 Ultra 550B**, Nemotron Lightning (stored per chat).
- **Persistent context** per chat: JSON storage, **unlimited length by default**, `/reset` to wipe it; automatic **compaction** (shrink tool results → summarize older ranges) under high token pressure, `/compact` to compact right away.
- **Web search** via Tavily (tool calling), answers come with source URLs.
- **Image sending** (`sendPhoto`) via the `/image` command or when the model calls the `send_image` tool itself.
- **Sticker sending** (`sendSticker`) via `/sticker`, the `send_sticker` tool, and echoing the sticker back when someone sends one to the bot (needs an official sticker ID — see below).
- **Text-only model**: images sent by users are only noted in the context (a bracketed note saying the user attached an image the bot cannot view), image content is never sent to the API. The bot can still **send images** through `send_image`.
- Zalo markdown formatting, long messages split into ≤ 1900 characters (Zalo's safe limit).
- **Low latency**: no `max_tokens` cap, `reasoning_effort: none` by default (~0 thinking tokens), typing indicator, model warm-up, streaming + partial sends for slow answers, search/image cache, retry + circuit breaker.
- **Complete answers, never cut short**: no fixed sentence budget — length follows the question; questions that need explanation/comparison/instructions come with numbers and examples. No length hints are injected into the request sent to the model.
- Commands: `/help`, `/reset`, `/status`, `/id`, `/search`, `/image`, `/sticker`, `/model`, `/think`, `/split`, `/compact`, `/ping`.

## Requirements

- Node.js **>= 20.6** (tested on v24.19 and v26.12). The `.env` file is **loaded in code** (`src/env.js`), so however you run `node index.js` the config is there — the `--env-file-if-exists` flag is not required.
- A Zalo bot created in **Zalo Bot Creator**, a valid token, `can_join_groups = true`.
- A **DeepSeek** key (`sk-...`) for the primary model and an **NVIDIA NIM** key (`nvapi-...`) for the fallback model, plus Tavily (`tvly-...`).

## Install

```powershell
cd zalo-group-bot
npm install          # 0 runtime deps; installs typescript/@types/node for typecheck
copy .env.example .env
# fill in ZALO_BOT_TOKEN, DEEPSEEK_API_KEY, NIM_API_KEY (fallback), TAVILY_API_KEY
npm run smoke        # checks token + DeepSeek + NIM + Tavily + image validation
```

## Run

```powershell
npm start                        # polling (default, no tunnel needed)
node index.js                    # equivalent — .env loads itself, no env-file flag needed
npm run dev                      # polling + watch
node --env-file-if-exists=.env src/index.js --once   # take one update then exit
npm test                         # unit tests (node --test)
npm run typecheck                # tsc checkJs over src/
npm run simulate -- "gold price today?"   # run the real agent (DeepSeek/NIM/Tavily) but do NOT send to Zalo
```

Environment variable precedence: variables already in `process.env` (hosting panel, pm2, terminal) **win** over the `.env` file; if a declared variable is **empty**, the `.env` value is filled in. If the token is missing, the error log also prints the working directory and which `.env` file was not found.

`simulate` prints the answer as if the bot were in the group, using its own context in `data/simulate/` — handy for trying out tool calling, memory, `/status` and `/reset` before letting the bot loose in a real group.

### Webhook (optional, needs public HTTPS)

```powershell
# example with cloudflared / ngrok pointing at port 8787
$env:MODE="webhook"; $env:WEBHOOK_PUBLIC_URL="https://abc.example.com/zalo/webhook"
$env:WEBHOOK_SECRET="some-long-secret-123"
npm start
```

The bot calls `setWebhook` itself when `WEBHOOK_PUBLIC_URL` is set; otherwise register it manually with Zalo's `setWebhook`. The webhook checks the `X-Bot-Api-Secret-Token` header and returns `200` immediately (< 100ms), then processes in the background.

## Log

Logs are **pretty** by default: time + icon + aligned columns, with color when running in a real terminal.

```
18:33:31 🚀 starting zalo-group-bot    version=1.0.3 mode=polling dryRun=false
╭──────────────────────────────────────────────────────────────────────────────────────────────╮
│ 🤖 Bot deepseek  ·  v1.0.3  ·  Zalo group chatbot                                            │
│ 🧠 DeepSeek V4.1 Flash · deepseek/deepseek-flash  (fallback: nim-light)                      │
│ ⚙️  polling · reasoning=none · max_tokens=unlimited                                          │
│ 🔎 search=fast/4 · typing=on · progressive=auto                                              │
│ 📚 context unlimited · unlimited messages per reply                                          │
╰──────────────────────────────────────────────────────────────────────────────────────────────╯
18:33:31 🤖 zalo bot ready             version=1.0.3 id=2214705736200876533 name="Bot deepseek" groups=true
18:33:31 📡 polling started            mode=long-poll timeoutSec=30
18:33:31 ⚡  nim warmup done            ms=394
18:33:45 💬 Nam: @Bot gold price today?    chatId=g1 kind=text len=26
18:33:46 🔍 web search                 query="gold price today" results=4
18:33:47 🧠 thinking: The user asks about the gold price, needs the latest results...    chatId=g1 model=deepseek-v4-pro
18:33:47 🤖 bot: The gold price rose today ...    chatId=g1 part=1
18:33:47 ✅ replied · deepseek-v4-pro · 48.6 tok/s    chatId=g1 model=deepseek-v4-pro alias=deepseek provider=deepseek tps=48.6 tokens=83 ms=1840 llmMs=1712 chars=612 messages=1 kept=3 reasoning=none
```

Every log line carries `version=` (read from `package.json`) — the panel `git pull`s on its own, so the log tells you which build is running.

The console log shows:

| Line | Content |
|---|---|
| `💬 <name>: ...` | the message the user sent (with `chatId`, `kind`, `len`) |
| `🧠 thinking: ...` | the model's thinking (`reasoning_content`), up to 2000 characters; turn it off with `LOG_THINKING=off` |
| `🤖 bot: ...` | exactly what the bot sends, part by part if it was split |
| `✅ replied · <model> · <tps> tok/s` | turn summary: actual model, speed, tokens, timing |

Note: `thinking` only has content when `AI_REASONING` is not `none` (`low|medium|high|auto`). With `none` the model returns no thinking and the `🧠` line never appears.

The `replied` line also carries:

| Field | Meaning |
|---|---|
| `model` / `alias` / `provider` | the real model name (`deepseek-v4-pro`, `nvidia/...`), the alias and the provider in use |
| `ms` | total turn processing time (from receiving the message to finishing the send) |
| `llmMs` | time spent calling the LLM (all tool-call rounds summed), Zalo network excluded |
| `tps` | generation speed: `completion tokens / actual generation time` (TTFT already subtracted) |
| `tokens` | number of tokens the model generated (`usage.completion_tokens`) |
| `thinkingTokens` | tokens spent on thinking (when the provider reports them) |
| `chars` | answer length (characters) |
| `reasoning` | reasoning mode (`none|low|medium|high`), not the thinking text |

`LOG_LEVEL=debug` additionally prints `llm response` for every call: `ms`, `ttft`, `tps`, `promptTokens`, `completionTokens`, `finish`, `toolCalls`. The in-chat `/status` also shows the version plus the latest `~tok/s`.

- `LOG_FORMAT=json` (or the `--json` flag) → one JSON line per event, handy for writing to files or parsing.
- `LOG_COLOR=auto|always|never` → `auto` enables color when stdout is a terminal, disables it under pipe/CI.
- `--verbose` → adds debug logs (retry, cache, tool, context).
- Tokens/keys are always masked (`token=***`) in both modes; errors print only a short message, the full stack lives in JSON mode.

## Adding the bot to a group

Group chat is in **Beta**, and the bot **only receives** messages when:

1. Someone **@mentions** the bot's name, or
2. Someone **replies (quotes)** one of the bot's messages.

Steps to add the bot (following the [Zalo docs](https://docs.zaloplatforms.com/docs/BOT/best-practices/build-bot-interaction-with-group)):

1. Open the **Zalo Bot Creator** Mini App → pick the bot → the bot info page.
2. In the **"Invite Bot to group"** section → tap share, send the link into the group.
3. The group admin taps the link that was just sent.
4. In the **"Add Bot to Group"** popup → **Confirm**.
5. The bot sends a greeting → done.

After the first run the log prints the `chatId` (or type `/id` in the group) — put it in `ALLOWED_CHAT_IDS` so the bot only works in that group.

## Commands

| Command | Description |
|---|---|
| `/help` | Command list + @mention instructions |
| `/status` | Model, mode, uptime, context, latency p50/p95, errors, breaker |
| `/id` | `chat.id`, `chat_type`, sender id |
| `/reset` | Clears the current chat context but **keeps the settings** (`model`/`tone`/`think`); `/reset all` clears the settings too (admin-gated when `ADMIN_IDS` is set) |
| `/search <question>` | Forces a web search for the question |
| `/image <keyword>` | Find and send an image |
| `/sticker [emotion]` | Send a sticker (a sample sticker by default, or by an added name/tag) |
| `/sticker add <id> [name]` | (Admin) Sends a test + saves the official sticker ID to `data/stickers.json` |
| `/sticker remove <id\|name>` | (Admin) Remove a sticker from the self-added list |
| `/model` | Show the current model + the list to switch from |
| `/model <alias>` | Switch the model for this chat: `deepseek`, `pro`, `nim`, `ultra`, `nim-light` |
| `/tone [roast\|hard\|friendly\|default]` | Change the tone for this chat: `roast` (mocking), `hard` (blunt, heavy swearing), `friendly`, `default` = follow `BOT_TONE` |
| `/think on\|off\|low\|high\|auto` | Turn reasoning on/off for this chat |
| `/split on\|off\|auto` | Control splitting replies into several messages for this chat (`off` = merge into one message, `auto` = follow `PROGRESSIVE`) |
| `/compact` | Compact the context right away (admin): shrink tool results → summarize older ranges |
| `/ping` | Measure the Zalo API round-trip |

## Configuration

Every environment variable is in [`.env.example`](.env.example). The main groups:

- **Zalo**: `ZALO_BOT_TOKEN`, `ZALO_BOT_ID`, `ALLOWED_CHAT_IDS`, `MODE`, `WEBHOOK_HOST` (defaults to `127.0.0.1`), `WEBHOOK_PORT`, `WEBHOOK_PATH`, `WEBHOOK_PUBLIC_URL`, `WEBHOOK_SECRET`.
- **DeepSeek (primary model)**: `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL` (`deepseek-flash`), `DEEPSEEK_PRO_MODEL` (`deepseek-v4-pro`), `DEEPSEEK_TEMPERATURE`, `DEEPSEEK_TIMEOUT_MS`.
- **Model selection**: `MODEL_DEFAULT` (`deepseek|pro|nim|ultra|nim-light`), `MODEL_FALLBACK` (defaults to `nim-light`), `AI_REASONING` (`none|low|medium|high|auto`, `NIM_REASONING` is the old name and is still accepted), `NIM_MAX_TOKENS` (**leave empty or `0` = unlimited**), `RESPONSE_TIMEOUT_MS` (**`0` = no deadline**).
- **NIM (fallback)**: `NIM_API_KEY`, `NIM_BASE_URL`, `NIM_MODEL`, `NIM_ULTRA_MODEL` (`nvidia/nemotron-3-ultra-550b-a55b`), `NIM_FALLBACK_MODEL`, `NIM_TEMPERATURE`, `NIM_TIMEOUT_MS`.
- **Context**: `CONTEXT_MAX_TOKENS` (**0 = unlimited**), `CONTEXT_MAX_MESSAGES` (**0 = unlimited**), `CONTEXT_MAX_CHARS_PER_MESSAGE` (default 12000, **0 = no truncation**), `CONTEXT_TTL_HOURS` (**0 = never auto-delete**), `CONTEXT_SUMMARY`, `DATA_DIR` (relative → resolved from the repo root; on a hosting panel prefer an absolute path to a persistent volume, never `/tmp`).
- **Compaction**: `CONTEXT_MODEL_WINDOW` (**0 = unknown → only compact when the provider reports context overflow**), `CONTEXT_COMPACT_THRESHOLD` (default `0.8`), `CONTEXT_KEEP_RECENT` (number of messages kept when summarizing, default `8`), `CONTEXT_SUMMARY_MAX_CHARS` (`1200`), `CONTEXT_TOOL_RESULT_KEEP_CHARS` (`600`).
- **Tavily**: `SEARCH_ENABLED`, `SEARCH_AUTO` (**off = the model never searches on its own, `/search` still works**), `SEARCH_DEPTH` (`fast|basic|advanced|ultra-fast`), `SEARCH_MAX_RESULTS`, `SEARCH_COUNTRY`, `SEARCH_CACHE_TTL_MS` (0 = disable cache).
- **Behavior**: `BOT_TONE` (**default `hard`** = heavy swearing; `extreme` = harshest, enable with `/tone max`; `roast` = medium; `friendly` = polite), `TYPING`, `TYPING_INTERVAL_MS`, `PROGRESSIVE` (`auto` = only split when the wait is long, `on` = split early, `off` = merge), `PROGRESSIVE_AFTER_MS`, `MAX_MESSAGES_PER_REPLY` (**0 = send everything**), `MAX_QUEUE_DEPTH`, `USER_RATE_LIMIT_PER_MINUTE` (**default 12, 0 = off** — stops one person spamming and burning API credit), `ADMIN_IDS`, `STICKER_ENABLED`, `STICKER_ECHO`, `STICKER_IDS` (`id1,id2:name two`).
- **Log**: `LOG_FORMAT` (`pretty|json`), `LOG_COLOR` (`auto|always|never`), `LOG_LEVEL`.

CLI flags: `--model <alias> --mode --think --max-tokens --progressive --no-progressive --no-search --no-typing --dry-run --once --verbose --help`.

## Design & optimizations

```
Zalo API ──► polling/webhook ──► agent (per-chat queue, 4 chats in parallel)
                                     │
                     ┌───────────────┼─────────────────┐
                     ▼               ▼                 ▼
              context store    model router       tools (Tavily, images)
              (JSON + trim)   (DeepSeek/NIM)      (cache + validate)
```

- **Model selection**: each chat has a `meta.model` (set by `/model`) → the router picks the matching provider/model; `MODEL_DEFAULT` by default (deepseek-flash, reasoning off).
- **No `max_tokens` cap**: the model generates until it is done. Control comes from a prompt asking for brevity; there is **no answer deadline by default** (`RESPONSE_TIMEOUT_MS=0`), long answers are split into multiple 1900-character messages, with **no limit on the number of messages** (`MAX_MESSAGES_PER_REPLY=0`).
- **Lower latency**: `reasoning_effort: none` (DeepSeek returns no `reasoning_content`, measured ~600–900ms), typing indicator, warm-up at boot, Tavily cache (10 minutes by default), image validation result cache, `fetch` keep-alive, only `search_depth=fast`.
- **Model fault tolerance**: no request timeout by default (`NIM_TIMEOUT_MS=0`, `DEEPSEEK_TIMEOUT_MS=0`) and no answer deadline (`RESPONSE_TIMEOUT_MS=0`), so a slow model is waited for instead of being cut off. Set a positive value to restore limits: the bot then retries once (sharing the budget) and falls back **to a different model** (`MODEL_FALLBACK`) without tools — so the bot doesn't "die" when DeepSeek/NIM returns 500/timeout. Warmup runs **sequentially**, exactly 1 request per provider+model pair (before v1.1.1 it ran 2 aliases of the same provider in parallel → the second request was queued by NIM and then timed out after 20s), with an 8s timeout, and failures are logged at `debug` only — no impact on real messages.
- **Prompt / context / LLM follow the DeepSeek Harness architecture** (porting the contract, not the plugin kernel):
  - The **system prompt** is a set of `PromptSection`s with an `order` (identity, rules, chat shape, formatting, image, tool guidance, tone, commands) assembled by `src/ai/prompt/`; the registry supports `complete`, strict `{{...}}` variables, runtime context and the provider's tool schema. Tool guidance only appears when the matching tool is actually sent (even with `SEARCH_AUTO=off`).
  - **Model-visible means logged**: timestamps and `/search` results are **persistent user messages** in the record (refreshed every turn), tool calls/results are written to the record, and the summary is **a single user message** replacing the old range — no more mutating a copy of the request.
  - **Token meter + compaction**: estimates `system + tool schemas + messages`, calibrated with `usage.prompt_tokens`; exceeding `CONTEXT_COMPACT_THRESHOLD` or the provider reporting context overflow → shrink tool results → summarize older ranges (keeping `CONTEXT_KEEP_RECENT`, always balancing tool-call/result pairs). `/compact` compacts manually (admin).
  - **LLM service**: a shared OpenAI-compatible adapter for DeepSeek/NIM, a per-provider registry (duplicate routes are rejected), immutable requests, stable error codes (`NO_ADAPTER`, `AUTH`, `RATE_LIMIT`, `CONTEXT_WINDOW_EXCEEDED`, `TIMEOUT`, `ABORTED`, ...), a separate retry executor, and a model catalog that carries `contextWindow`.
  - **Context**: **no truncation** by default; trimming only happens with `CONTEXT_MAX_*` > 0 (always keeping the summary). The request sent to the model is **text-only**: images sent by the user are never turned into image content, only a single note line in the text.
- **Typing indicator**: sends `typing` as soon as a message arrives, refreshes every `TYPING_INTERVAL_MS`, and **turns it off before sending the first message** (waiting for the last typing request to finish) so Zalo no longer shows "typing" after the bot has replied.
- **Progressive**: `auto` = only split when the wait is > `PROGRESSIVE_AFTER_MS` and a chunk is ≥ 160 characters; `on` = split early as soon as there is a sentence ≥ 80 characters; `off` = merge into a single send.
- **Failure handling**: no retry when sending messages (avoids duplicates), retries for read calls (getMe/getUpdates/Tavily), a separate circuit breaker per **provider+model** at 5 failures/30s (one slow model doesn't lock out another model on the same provider), `message_id` dedupe (RAM + persisted in the context so a restart doesn't answer twice), a bounded queue (`MAX_QUEUE_DEPTH`), graceful shutdown that waits for in-flight messages to finish and then flushes the context.
- **Webhook**: binds `WEBHOOK_HOST` (localhost by default, a tunnel still works); the secret comes from env or is generated once and stored in `data/webhook-secret` so restarts don't change it; a broken JSON body returns 400 so Zalo retries.

## Structure

```
src/
  config.js        env + CLI flags (util.parseArgs)
  logger.js        JSON log, token/key redaction
  http.js          fetch wrapper: timeout, retry, breaker, SSE
  metrics.js       counters + p50/p95
  zalo/            REST client, event normalize, polling, webhook
  ai/
    prompt/        registry section/context/variable + sections + entries
    llm/           service, adapter OpenAI-compatible, catalog, retry, errors
    router.js      pick the model per chat from the catalog
    summarize.js   summarizer used for compaction
    agent.js       reply pipeline, tool rounds, progressive, queue
  context/
    store.js       atomic JSON storage + TTL/LRU
    record.js      schema v2, message/context/summary/tool constructors
    assembler.js   record -> messages (trim, tool pairing)
    token-meter.js token estimate + calibrator
    compaction/    engine + pruner + summarizer
  search/          tavily client + format
  media/           validate image URL
  text/            chunk, sanitize markdown, strip mention
  commands/        /help /reset /status ...
scripts/smoke.js     checks token + DeepSeek + NIM + Tavily
scripts/simulate.js  runs the real agent, sends nothing to Zalo
test/                unit tests (node --test)
test-utils/          shared test helpers
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Bot doesn't answer in the group | Zalo only sends events when the bot is **@mentioned** or someone **replies** to its message. Check for `chat_type=GROUP` in the log and check `ALLOWED_CHAT_IDS`. |
| Log `zalo.getUpdates.empty` / `error_code 408` | Normal: the long-poll timed out with no new messages. The client treats it as "no messages" and does not back off. |
| `LLM HTTP 500` / hangs for a few seconds | DeepSeek/NIM occasionally returns 500 or hangs. With the default `RESPONSE_TIMEOUT_MS=0` the bot simply waits; if you set a positive deadline it retries once then falls back to a different model (`MODEL_FALLBACK`). If the errors persist: lower `CONTEXT_MAX_TOKENS` or `/model` to a different model. |
| `Zalo getMe failed` | Wrong/expired token. Create a new bot token in the Bot Creator. |
| Tavily `country parameter is not supported` | The API does not support `country` with `search_depth=fast`; the client already drops `country` when the depth is fast/ultra-fast. |
| Images won't send | `sendPhoto` needs a **public URL**; the validator rejects URLs that return 403, are not images, or are over 8MB. The bot only sends images through the `send_image` tool; the prompt forbids the model from inventing image URLs, and if it can't find one the bot says so. |
| Images sent by users can't be read | The model is text-only: the bot only sees a note saying the user sent an image whose content it cannot see; it never receives the image itself. |
| `429` | Zalo quota or Tavily credits exhausted; the bot backs off on its own. Use `/status` to check the breaker. |
| Sticker fails with `425 The sticker is invalid` | You are using a pack (category) ID instead of the official sticker ID. Use `/sticker` to see the IDs you have, or `/sticker add <id>` with an ID taken from Zalo's instructions. |
| `/sticker add` says Zalo rejected it | Wrong/nonexistent ID. A sticker ID must be exactly 20 hex characters and an official sticker; this command sends a test before saving. |
| DeepSeek `422` with `reasoning_effort: "off"` | The API only accepts `none|low|high|max`. The bot already maps `off` → `none`; if you call the API yourself, use `none`. |
| `/model deepseek` doesn't switch | The command requires admin rights when `ADMIN_IDS` is set; valid aliases: `deepseek`, `pro`, `nim`, `ultra`, `nim-light`. |
| `llm warmup failed` / `llm warmup skipped` | Normal, not a bot failure: warmup only exists to cut the cold start on the first message. NIM often returns 500 or queues slowly → it is skipped and real messages still work. Since v1.1.1 warmup runs sequentially, 1 request per provider+model pair, and logs at `debug` only, so at `LOG_LEVEL=info` you no longer see it. |
| DeepSeek 400 `model not found` | The real model names are `deepseek-flash` / `deepseek-v4-pro` (not `deepseek-v4.1-flash`). Fix `DEEPSEEK_MODEL` if needed. |
| Context grows huge (if you set limits yourself) | Raise/reset `CONTEXT_MAX_TOKENS`/`CONTEXT_MAX_MESSAGES` to 0 to drop the limit, or `/reset`. |
| Zalo still shows "typing" after the bot replies | The bot turns typing off before the first message; if you still see it, lower `TYPING_INTERVAL_MS` or turn it off entirely with `TYPING=off`. Zalo's indicator can expire slowly on its own (a few seconds). |
| Webhook returns `403` after a restart | It used to generate a new secret on every run; the secret is now stored in `data/webhook-secret` so it stays the same. If you change `DATA_DIR`, set a fixed `WEBHOOK_SECRET`. |
| Messages dropped while the bot is busy | The queue is bounded by `MAX_QUEUE_DEPTH` (50 by default); the bot sends a "handling a lot of messages" notice instead of queueing forever. Raise it if needed. |
| Webhook doesn't receive requests from other machines | `WEBHOOK_HOST` defaults to `127.0.0.1` (safe). A tunnel running on the same machine still works; only change it if you really need to. |

## Security

- Tokens/keys live only in `.env` (gitignored) and are always redacted in logs.
- **Keys that were sent over chat should be considered leaked — rotate them** (create new tokens/keys) once the bot runs reliably.
- The webhook requires a secret of ≥ 8 characters and compares it timing-safe; the self-generated secret is stored in `data/webhook-secret` (not committed).
- The webhook binds localhost by default; `setWebhook`/`sendMessage` are not retried, to avoid duplicate sends.
- Set `ALLOWED_CHAT_IDS` and `ADMIN_IDS` when running for real in a group.

## Known limitations

- Zalo Bot group chat is in **Beta** and there is no "listen to every message in the group" feature.
- `getUpdates` (polling) should only be used during development; in production use a webhook so you don't miss events.
- There is no voice message support; stickers can only be sent with an **official sticker ID** (20 hex). Pack IDs on stickers.zaloapp.com do **not** work (Zalo returns `425 The sticker is invalid`) — use `/sticker add <id>` with an ID obtained from Zalo's instructions ([video](https://vimeo.com/649330161)).
- You can't "cancel" the typing indicator on Zalo's side: the bot stops sending typing before replying, and the rest expires on Zalo's client (~a few seconds).
- NIM reports `cached_tokens = 0` even for an identical request → there is no real prefix cache; the system prompt is still kept static so nothing breaks if NVIDIA enables caching later.
- DeepSeek only accepts `reasoning_effort` as `none|low|high|max` (`off` returns 422) — the bot maps it for you. The API model names are `deepseek-flash` (V4.1 Flash) and `deepseek-v4-pro`.
