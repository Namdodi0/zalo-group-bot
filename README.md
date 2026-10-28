# zalo-group-bot

Bot chat cho **một nhóm Zalo**, **NVIDIA NIM** (`nvidia/nemotron-3.5-super-vl-120b-a12b`), cùng **Tavily** cho web search. Viết bằng Node.js thuần (ESM), **không có dependency runtime** — chỉ dùng `fetch`, `node:http`, `node:test` có sẵn.

## Tính năng

- Trả lời tin nhắn trong group khi được **@mention** hoặc **reply** vào tin của bot (giới hạn của Zalo Bot — xem bên dưới).
- **Đa provider + đổi model trong chat**: `/model` để chuyển giữa DeepSeek Flash, DeepSeek Pro, Nemotron Super VL, **Nemotron 3 Ultra 550B**, Nemotron Lightning (lưu theo từng chat).
- **Ngữ cảnh bền vững** theo từng chat: lưu JSON, **mặc định không giới hạn** độ dài, `/reset` để xoá; **compaction** tự động (rút gọn tool result → tóm tắt range cũ) khi áp lực token cao, `/compact` để nén ngay.
- **Web search** qua Tavily (tool calling), trả lời kèm URL nguồn.
- **Gửi ảnh** (`sendPhoto`) qua lệnh `/image` hoặc khi model tự gọi tool `send_image`.
- **Gửi sticker** (`sendSticker`) qua `/sticker`, tool `send_sticker`, và tự trả lại sticker khi có người gửi sticker cho bot (cần sticker ID chính thức — xem bên dưới).
- **Model text-only**: ảnh người dùng gửi chỉ được ghi chú trong context (`[người dùng gửi kèm ảnh — bot không xem được nội dung]`), không gửi nội dung ảnh lên API. Bot vẫn **gửi ảnh** được qua `send_image`.
- **Emoji**, định dạng markdown Zalo, chia tin dài ≤ 1900 ký tự (giới hạn an toàn của Zalo).
- **Giảm độ trễ**: không giới hạn `max_tokens`, `reasoning_effort: none` mặc định (~0 token suy nghĩ), typing indicator, warm-up model, streaming + gửi tách đoạn khi trả lời chậm, cache search/ảnh, retry + circuit breaker.
- **Trả lời đủ ý, không cụt**: không áp khung số câu cố định — độ dài theo nội dung câu hỏi; câu hỏi cần giải thích/so sánh/hướng dẫn thì kèm số liệu/ví dụ. Không chèn gợi ý độ dài vào lượt gửi model.
- Lệnh: `/help`, `/reset`, `/status`, `/id`, `/search`, `/image`, `/sticker`, `/model`, `/think`, `/split`, `/compact`, `/ping`.

## Yêu cầu

- Node.js **>= 20.6** (đã test trên v24.19 và v26.12). File `.env` được **nạp trong code** (`src/env.js`) nên chạy `node index.js` kiểu gì cũng có config — không bắt buộc cờ `--env-file-if-exists`.
- Bot Zalo đã tạo trong **Zalo Bot Creator**, token hợp lệ, `can_join_groups = true`.
- Key **DeepSeek** (`sk-...`) cho model chính và key **NVIDIA NIM** (`nvapi-...`) cho model dự phòng, cùng Tavily (`tvly-...`).

## Cài đặt

```powershell
cd zalo-group-bot
npm install          # 0 runtime dep; cài typescript/@types/node cho typecheck
copy .env.example .env
# điền ZALO_BOT_TOKEN, DEEPSEEK_API_KEY, NIM_API_KEY (dự phòng), TAVILY_API_KEY
npm run smoke        # kiểm tra token + DeepSeek + NIM + Tavily + validate ảnh
```

## Chạy

```powershell
npm start                        # polling (mặc định, không cần tunnel)
node index.js                    # tương đương — .env tự nạp, không cần cờ env-file
npm run dev                      # polling + watch
node --env-file-if-exists=.env src/index.js --once   # nhận 1 lượt update rồi thoát
npm test                         # unit test (node --test)
npm run typecheck                # tsc checkJs trên src/
npm run simulate -- "giá vàng hôm nay?"   # chạy thử agent thật (DeepSeek/NIM/Tavily) nhưng KHÔNG gửi Zalo
```

Thứ tự ưu tiên biến môi trường: biến đã có trong `process.env` (panel host, pm2, terminal) **thắng** file `.env`; biến khai báo sẵn nhưng **rỗng** thì `.env` được điền vào. Nếu thiếu token, log lỗi in ra luôn thư mục đang chạy và file `.env` nào không tìm thấy.

`simulate` in ra câu trả lời như thể bot đang trong group, dùng context riêng ở `data/simulate/` — tiện để thử tool calling, trí nhớ, `/status`, `/reset` trước khi thả bot vào nhóm thật.

### Webhook (tuỳ chọn, cần HTTPS công khai)

```powershell
# ví dụ với cloudflared / ngrok trỏ về cổng 8787
$env:MODE="webhook"; $env:WEBHOOK_PUBLIC_URL="https://abc.example.com/zalo/webhook"
$env:WEBHOOK_SECRET="mot-secret-du-dai-123"
npm start
```

Bot tự gọi `setWebhook` nếu có `WEBHOOK_PUBLIC_URL`; nếu không, tự đăng ký thủ công bằng `setWebhook` của Zalo. Webhook kiểm tra header `X-Bot-Api-Secret-Token` và trả `200` ngay (< 100ms) rồi xử lý nền.

## Log

Mặc định log ở dạng **pretty**: giờ + icon + căn cột, có màu khi chạy trong terminal thật.

```
18:33:31 🚀 starting zalo-group-bot    version=1.0.3 mode=polling dryRun=false
╭──────────────────────────────────────────────────────────────────────────────────────────────╮
│ 🤖 Bot deepseek  ·  v1.0.3  ·  Zalo group chatbot                                            │
│ 🧠 DeepSeek V4.1 Flash · deepseek/deepseek-flash  (fallback: nim-light) │
│ ⚙️  polling · reasoning=none · max_tokens=không giới hạn                                     │
│ 🔎 search=fast/4 · emoji=on · typing=on · progressive=auto                                   │
│ 📚 context không giới hạn · trả lời không giới hạn tin                                       │
╰──────────────────────────────────────────────────────────────────────────────────────────────╯
18:33:31 🤖 zalo bot ready             version=1.0.3 id=2214705736200876533 name="Bot deepseek" groups=true
18:33:31 📡 polling started            mode=long-poll timeoutSec=30
18:33:31 ⚡  nim warmup done            ms=394
18:33:45 💬 Nam: @Bot giá vàng hôm nay?    chatId=g1 kind=text len=26
18:33:46 🔍 web search                 query="giá vàng hôm nay" results=4
18:33:47 🧠 thinking: Người dùng hỏi giá vàng, cần tra kết quả mới nhất...    chatId=g1 model=deepseek-v4-pro
18:33:47 🤖 bot: Giá vàng hôm nay tăng lên ...    chatId=g1 part=1
18:33:47 ✅ replied · deepseek-v4-pro · 48.6 tok/s    chatId=g1 model=deepseek-v4-pro alias=deepseek provider=deepseek tps=48.6 tokens=83 ms=1840 llmMs=1712 chars=612 messages=1 kept=3 reasoning=none
```

Mỗi dòng log đều có `version=` (lấy từ `package.json`) — panel tự `git pull` nên nhìn log là biết đang chạy bản nào.

Log console hiện đủ:

| Dòng | Nội dung |
|---|---|
| `💬 <tên>: ...` | tin nhắn user gửi (kèm `chatId`, `kind`, `len`) |
| `🧠 thinking: ...` | phần suy nghĩ của model (`reasoning_content`), tối đa 2000 ký tự; tắt bằng `LOG_THINKING=off` |
| `🤖 bot: ...` | đúng nội dung bot gửi đi, từng phần nếu bị tách |
| `✅ replied · <model> · <tps> tok/s` | tổng kết lượt: model thật, tốc độ, token, thời gian |

Lưu ý: `thinking` chỉ có nội dung khi `AI_REASONING` khác `none` (`low|medium|high|auto`). Đặt `none` thì model không trả suy nghĩ, dòng `🧠` sẽ không xuất hiện.

Dòng `replied` có thêm:

| Field | Ý nghĩa |
|---|---|
| `model` / `alias` / `provider` | tên model thật (`deepseek-v4-pro`, `nvidia/...`), alias và provider đang dùng |
| `ms` | tổng thời gian xử lý lượt (từ lúc nhận tin đến khi gửi xong) |
| `llmMs` | thời gian gọi LLM (cộng dồn cả vòng tool call), không tính mạng Zalo |
| `tps` | tốc độ sinh chữ: `completion tokens / thời gian sinh thật` (đã trừ TTFT) |
| `tokens` | số token model sinh ra (`usage.completion_tokens`) |
| `thinkingTokens` | token dùng cho phần suy nghĩ (nếu provider báo) |
| `chars` | độ dài câu trả lời (ký tự) |
| `reasoning` | chế độ suy luận (`none|low|medium|high`), không phải nội dung thinking |

`LOG_LEVEL=debug` in thêm `llm response` cho từng lần gọi: `ms`, `ttft`, `tps`, `promptTokens`, `completionTokens`, `finish`, `toolCalls`. `/status` trong chat cũng hiện version + `~tok/s` gần nhất.

- `LOG_FORMAT=json` (hoặc flag `--json`) → mỗi sự kiện một dòng JSON, tiện ghi file/parse.
- `LOG_COLOR=auto|always|never` → `auto` bật màu khi stdout là terminal, tắt khi pipe/CI.
- `--verbose` → thêm log debug (retry, cache, tool, context).
- Token/key luôn bị che (`token=***`) ở cả hai chế độ; lỗi chỉ in message gọn, stack đầy đủ nằm ở chế độ JSON.

## Đưa bot vào nhóm

Group chat đang ở giai đoạn **Beta** và bot **chỉ nhận được** tin khi:

1. Có người **@mention** tên bot, hoặc
2. Có người **reply (quote)** vào một tin bot đã gửi.

Các bước thêm bot (theo [docs Zalo](https://docs.zaloplatforms.com/docs/BOT/best-practices/build-bot-interaction-with-group)):

1. Mở Mini App **Zalo Bot Creator** → chọn bot → trang thông tin bot.
2. Mục **"Mời Bot vào nhóm"** → nhấn chia sẻ, gửi link vào nhóm.
3. Trưởng nhóm nhấn vào link vừa gửi.
4. Popup **"Thêm Bot vào Nhóm"** → **Xác nhận**.
5. Bot gửi tin chào → xong.

Sau lần chạy đầu, log sẽ in `chatId` (hoặc gõ `/id` trong nhóm) — điền vào `ALLOWED_CHAT_IDS` để bot chỉ hoạt động trong group đó.

## Lệnh

| Lệnh | Mô tả |
|---|---|
| `/help` | Danh sách lệnh + hướng dẫn @mention |
| `/status` | Model, mode, uptime, context, latency p50/p95, lỗi, breaker |
| `/id` | `chat.id`, `chat_type`, id người gửi |
| `/reset` | Xoá ngữ cảnh chat hiện tại nhưng **giữ cài đặt** (`model`/`tone`/`think`); `/reset all` xoá cả cài đặt (admin-gated nếu có `ADMIN_IDS`) |
| `/search <câu hỏi>` | Bắt buộc web search cho câu hỏi |
| `/image <từ khoá>` | Tìm và gửi ảnh |
| `/sticker [cảm xúc]` | Gửi sticker (mặc định sticker mẫu, hoặc theo tên/tag đã thêm) |
| `/sticker add <id> [tên]` | (Admin) Gửi thử + lưu sticker ID chính thức vào `data/stickers.json` |
| `/sticker remove <id\|tên>` | (Admin) Xoá sticker khỏi danh sách tự thêm |
| `/model` | Xem model hiện tại + danh sách để đổi |
| `/model <alias>` | Đổi model cho chat: `deepseek`, `pro`, `nim`, `ultra`, `nim-light` |
| `/tone [roast\|hard\|friendly\|default]` | Đổi giọng điệu cho chat này: `roast` (cà khịa), `hard` (chửi thẳng, nặng lời), `friendly`, `default` = theo `BOT_TONE` |
| `/think on\|off\|low\|high\|auto` | Bật/tắt reasoning cho chat này |
| `/split on\|off\|auto` | Tắt chia trả lời thành nhiều tin cho chat này (`off` = gộp một tin, `auto` = theo `PROGRESSIVE`) |
| `/compact` | Nén context ngay (admin): rút gọn tool result → tóm tắt range cũ |
| `/ping` | Đo round-trip Zalo API |

## Cấu hình

Toàn bộ biến môi trường có trong [`.env.example`](.env.example). Các nhóm chính:

- **Zalo**: `ZALO_BOT_TOKEN`, `ZALO_BOT_ID`, `ALLOWED_CHAT_IDS`, `MODE`, `WEBHOOK_HOST` (mặc định `127.0.0.1`), `WEBHOOK_PORT`, `WEBHOOK_PATH`, `WEBHOOK_PUBLIC_URL`, `WEBHOOK_SECRET`.
- **DeepSeek (model chính)**: `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL` (`deepseek-flash`), `DEEPSEEK_PRO_MODEL` (`deepseek-v4-pro`), `DEEPSEEK_TEMPERATURE`, `DEEPSEEK_TIMEOUT_MS`.
- **Chọn model**: `MODEL_DEFAULT` (`deepseek|pro|nim|ultra|nim-light`), `MODEL_FALLBACK` (mặc định `nim-light`), `AI_REASONING` (`none|low|medium|high|auto`, `NIM_REASONING` là tên cũ vẫn nhận), `NIM_MAX_TOKENS` (**để trống hoặc `0` = không giới hạn**), `RESPONSE_TIMEOUT_MS`.
- **NIM (dự phòng)**: `NIM_API_KEY`, `NIM_BASE_URL`, `NIM_MODEL`, `NIM_ULTRA_MODEL` (`nvidia/nemotron-3-ultra-550b-a55b`), `NIM_FALLBACK_MODEL`, `NIM_TEMPERATURE`, `NIM_TIMEOUT_MS`.
- **Context**: `CONTEXT_MAX_TOKENS` (**0 = không giới hạn**), `CONTEXT_MAX_MESSAGES` (**0 = không giới hạn**), `CONTEXT_MAX_CHARS_PER_MESSAGE` (mặc định 12000, **0 = không cắt**), `CONTEXT_TTL_HOURS` (**0 = không bao giờ tự xoá**), `CONTEXT_SUMMARY`, `DATA_DIR` (tương đối → tính từ gốc repo; trên panel nên dùng đường dẫn tuyệt đối tới volume persistent, không dùng `/tmp`).
- **Compaction**: `CONTEXT_MODEL_WINDOW` (**0 = chưa biết → chỉ nén khi provider báo tràn context**), `CONTEXT_COMPACT_THRESHOLD` (mặc định `0.8`), `CONTEXT_KEEP_RECENT` (số tin giữ lại khi tóm tắt, mặc định `8`), `CONTEXT_SUMMARY_MAX_CHARS` (`1200`), `CONTEXT_TOOL_RESULT_KEEP_CHARS` (`600`).
- **Tavily**: `SEARCH_ENABLED`, `SEARCH_AUTO` (**off = model không tự search, `/search` vẫn dùng được**), `SEARCH_DEPTH` (`fast|basic|advanced|ultra-fast`), `SEARCH_MAX_RESULTS`, `SEARCH_COUNTRY`, `SEARCH_CACHE_TTL_MS` (0 = tắt cache).
- **Hành vi**: `BOT_TONE` (**mặc định `hard`** = chửi nặng; `extreme` = gắt nhất, bật bằng `/tone max`; `roast` = vừa; `friendly` = lịch sự), `EMOJI`, `TYPING`, `TYPING_INTERVAL_MS`, `PROGRESSIVE` (`auto` = chỉ tách khi chờ lâu, `on` = tách sớm, `off` = gộp), `PROGRESSIVE_AFTER_MS`, `MAX_MESSAGES_PER_REPLY` (**0 = gửi hết**), `MAX_QUEUE_DEPTH`, `USER_RATE_LIMIT_PER_MINUTE` (**mặc định 12, 0 = tắt** — chặn một người spam đốt credit API), `ADMIN_IDS`, `STICKER_ENABLED`, `STICKER_ECHO`, `STICKER_IDS` (`id1,id2:tên hai`).
- **Log**: `LOG_FORMAT` (`pretty|json`), `LOG_COLOR` (`auto|always|never`), `LOG_LEVEL`.

CLI flags: `--model <alias> --mode --think --max-tokens --progressive --no-progressive --no-search --no-emoji --no-typing --dry-run --once --verbose --help`.

## Thiết kế & tối ưu

```
Zalo API ──► polling/webhook ──► agent (queue theo chat, 4 chat song song)
                                     │
                     ┌───────────────┼─────────────────┐
                     ▼               ▼                 ▼
              context store    model router       tools (Tavily, ảnh)
              (JSON + trim)   (DeepSeek/NIM)      (cache + validate)
```

- **Chọn model**: mỗi chat có `meta.model` (do `/model` đặt) → router chọn provider/model tương ứng; mặc định `MODEL_DEFAULT` (deepseek-flash, reasoning off).
- **Không cap `max_tokens`**: model sinh tới khi xong. Kiểm soát bằng prompt xin ngắn + `RESPONSE_TIMEOUT_MS` 30s; câu trả lời dài được chia thành nhiều tin 1900 ký tự, **không giới hạn số tin** (`MAX_MESSAGES_PER_REPLY=0`).
- **Giảm latency**: `reasoning_effort: none` (DeepSeek không trả `reasoning_content`, đo ~600–900ms), typing indicator, warm-up lúc boot, cache Tavily (mặc định 10 phút), cache kết quả validate ảnh, keep-alive của `fetch`, chỉ dùng `search_depth=fast`.
- **Chịu lỗi model**: TTFT timeout ~9s (treo thì bỏ và retry sớm), 2 lần thử; non-streaming chia ngân sách để **luôn chừa ~25% deadline (tối đa 8s) cho fallback**, rồi fallback **sang provider khác** (`MODEL_FALLBACK`, mặc định Nemotron Lightning) không tool — tránh bot "chết" khi DeepSeek/NIM trả 500/timeout. Warmup chạy **tuần tự**, đúng 1 request cho mỗi cặp provider+model (trước v1.1.1 chạy song song 2 alias cùng provider → request thứ hai bị NIM xếp hàng rồi timeout 20s), timeout 8s và thất bại chỉ log mức `debug` — không ảnh hưởng tin nhắn thật.
- **Prompt / context / LLM theo kiến trúc DeepSeek Harness** (port contract, không plugin kernel):
  - **System prompt** là các `PromptSection` có `order` (identity, rules, chat shape, emoji, formatting, image, tool guidance, tone, commands) do `src/ai/prompt/` lắp ráp; registry hỗ trợ `complete`, variable `{{...}}` strict, context runtime và tool-schema provider. Tool guidance chỉ xuất hiện khi tool tương ứng thật sự được gửi (kể cả `SEARCH_AUTO=off`). Chữ prompt giữ nguyên từng byte — có golden test.
  - **Model-visible means logged**: mốc thời gian và kết quả `/search` là **message user bền vững** trong record (refresh mỗi lượt), tool-call/tool-result được ghi vào record, summary là **một message user** thay thế range cũ — không còn mutate bản copy request.
  - **Token meter + compaction**: ước lượng `system + tool schemas + messages`, hiệu chỉnh bằng `usage.prompt_tokens`; vượt `CONTEXT_COMPACT_THRESHOLD` hoặc provider báo tràn context → rút gọn tool result → tóm tắt range cũ (giữ `CONTEXT_KEEP_RECENT`, luôn cân cặp tool-call/result). `/compact` nén thủ công (admin).
  - **LLM service**: adapter OpenAI-compatible dùng chung cho DeepSeek/NIM, registry theo provider (trùng route bị chặn), request bất biến, mã lỗi ổn định (`NO_ADAPTER`, `AUTH`, `RATE_LIMIT`, `CONTEXT_WINDOW_EXCEEDED`, `TIMEOUT`, `ABORTED`, ...), retry executor tách riêng, catalog model mang `contextWindow`.
  - **Ngữ cảnh**: mặc định **không cắt**; `CONTEXT_MAX_*` > 0 mới trim (luôn giữ summary). Request gửi model là **text-only**: ảnh người dùng gửi không bao giờ được chuyển thành nội dung ảnh, chỉ có một dòng ghi chú trong text.
- **Typing indicator**: gửi `typing` ngay khi nhận tin, refresh mỗi `TYPING_INTERVAL_MS`, và **tắt trước khi gửi tin đầu tiên** (chờ request typing cuối kết thúc) để Zalo không còn hiện "đang soạn tin" sau khi bot đã nhắn.
- **Progressive**: `auto` = chỉ tách đoạn khi chờ > `PROGRESSIVE_AFTER_MS` và có đoạn ≥ 160 ký tự; `on` = tách sớm ngay khi có câu ≥ 80 ký tự; `off` = gộp một lần.
- **Chống lỗi**: không retry khi gửi tin (tránh gửi trùng), retry cho các call đọc (getMe/getUpdates/Tavily), circuit breaker riêng từng **provider+model** 5 lỗi/30s (một model chậm không khoá model khác cùng provider), dedupe `message_id` (RAM + lưu trong context nên restart không trả lời trùng), queue có trần (`MAX_QUEUE_DEPTH`), graceful shutdown chờ tin đang xử lý xong rồi flush context.
- **Webhook**: bind `WEBHOOK_HOST` (mặc định localhost, tunnel vẫn dùng được); secret lấy từ env hoặc sinh 1 lần lưu ở `data/webhook-secret` để restart không đổi; body JSON hỏng trả 400 để Zalo retry.

## Cấu trúc

```
src/
  config.js        env + CLI flags (util.parseArgs)
  logger.js        JSON log, redaction token/key
  http.js          fetch wrapper: timeout, retry, breaker, SSE
  metrics.js       counters + p50/p95
  zalo/            client REST, event normalize, polling, webhook
  ai/
    prompt/        registry section/context/variable + sections + entries
    llm/           service, adapter OpenAI-compatible, catalog, retry, errors
    router.js      chọn model theo chat trên catalog
    summarize.js   summarizer dùng cho compaction
    agent.js       pipeline trả lời, tool rounds, progressive, queue
  context/
    store.js       lưu JSON atomic + TTL/LRU
    record.js      schema v2, message/context/summary/tool constructors
    assembler.js   record -> messages (trim, tool pairing)
    token-meter.js ước lượng token + calibrator
    compaction/    engine + pruner + summarizer
  search/          tavily client + format
  media/           validate URL ảnh
  text/            chunk, sanitize markdown, strip emoji/mention
  commands/        /help /reset /status ...
scripts/smoke.js     kiểm tra token + DeepSeek + NIM + Tavily
scripts/simulate.js  chạy thử agent thật, không gửi Zalo
test/                unit tests (node --test)
test-utils/          helper dùng chung cho test
```

## Xử lý sự cố

| Hiện tượng | Nguyên nhân / cách xử lý |
|---|---|
| Bot không trả lời trong group | Zalo chỉ gửi event khi **@mention** hoặc **reply** tin của bot. Kiểm tra `chat_type=GROUP` trong log và `ALLOWED_CHAT_IDS`. |
| Log `zalo.getUpdates.empty` / `error_code 408` | Bình thường: hết thời gian long-poll mà chưa có tin mới. Client coi đó là "không có tin", không backoff. |
| `LLM HTTP 500` / treo vài giây | DeepSeek/NIM thỉnh thoảng trả 500 hoặc treo. Bot thử lại 2 lần (mỗi lần ≤ nửa ngân sách) rồi fallback sang provider khác (`MODEL_FALLBACK`). Nếu lỗi kéo dài: tăng `RESPONSE_TIMEOUT_MS`, giảm `CONTEXT_MAX_TOKENS`, hoặc `/model` sang model khác. |
| `Zalo getMe failed` | Token sai/hết hạn. Tạo lại bot token trong Bot Creator. |
| Tavily `country parameter is not supported` | API không hỗ trợ `country` với `search_depth=fast`; client đã tự bỏ `country` khi depth là fast/ultra-fast. |
| Không gửi được ảnh | `sendPhoto` cần **URL công khai**; validator sẽ từ chối URL 403/không phải ảnh/quá 8MB. Bot chỉ gửi ảnh qua tool `send_image`; prompt cấm model bịa URL ảnh, nếu không tìm được bot sẽ nói thật. |
| Ảnh người dùng gửi không đọc được | Model là text-only: bot chỉ thấy ghi chú `[người dùng gửi kèm ảnh — bot không xem được nội dung]`, không thấy nội dung ảnh. |
| `429` | Zalo quota hoặc Tavily hết credit; bot tự backoff. `/status` xem breaker. |
| Sticker lỗi `425 The sticker is invalid` | Đang dùng ID gói (category) thay vì sticker ID chính thức. Dùng `/sticker` để xem ID đang có, hoặc `/sticker add <id>` với ID lấy từ hướng dẫn Zalo. |
| `/sticker add` báo Zalo từ chối | ID sai/không tồn tại. Sticker ID phải đúng 20 ký tự hex và là sticker chính thức; lệnh này gửi thử trước khi lưu. |
| DeepSeek `422` khi `reasoning_effort: "off"` | API chỉ nhận `none|low|high|max`. Bot đã map `off` → `none`; nếu tự gọi API thì dùng `none`. |
| `/model deepseek` không đổi được | Lệnh cần quyền admin nếu đặt `ADMIN_IDS`; alias hợp lệ: `deepseek`, `pro`, `nim`, `ultra`, `nim-light`. |
| `llm warmup failed` / `llm warmup bỏ qua` | Bình thường, không phải lỗi bot: warmup chỉ để giảm cold start cho tin đầu tiên. NIM hay trả 500 hoặc xếp hàng chậm → bỏ qua, tin nhắn thật vẫn chạy. Từ v1.1.1 warmup chạy tuần tự 1 request/cặp provider+model và chỉ log mức `debug`, nên ở `LOG_LEVEL=info` bạn không còn thấy nó. |
| DeepSeek 400 `model not found` | Tên model thật là `deepseek-flash` / `deepseek-v4-pro` (không phải `deepseek-v4.1-flash`). Sửa `DEEPSEEK_MODEL` nếu cần. |
| Context phình to (nếu bạn tự đặt giới hạn) | Tăng/đặt lại `CONTEXT_MAX_TOKENS`/`CONTEXT_MAX_MESSAGES` = 0 để bỏ giới hạn, hoặc `/reset`. |
| Zalo vẫn hiện "đang soạn tin" sau khi bot nhắn | Bot đã tắt typing trước tin đầu tiên; nếu vẫn thấy, giảm `TYPING_INTERVAL_MS` hoặc tắt hẳn `TYPING=off`. Indicator phía Zalo có thể tự hết hạn chậm vài giây. |
| Webhook trả `403` sau khi restart | Trước đây secret tự sinh mỗi lần chạy; nay secret được lưu ở `data/webhook-secret` nên giữ nguyên. Nếu bạn đổi `DATA_DIR`, hãy set `WEBHOOK_SECRET` cố định. |
| Tin nhắn bị bỏ khi bot đang bận | Queue có trần `MAX_QUEUE_DEPTH` (mặc định 50); bot gửi tin "đang xử lý nhiều tin" thay vì xếp hàng vô hạn. Tăng nếu cần. |
| Webhook không nhận được request từ máy khác | `WEBHOOK_HOST` mặc định `127.0.0.1` (an toàn). Tunnel chạy trên cùng máy vẫn OK; chỉ đổi khi thật sự cần. |

## Bảo mật

- Token/key chỉ nằm trong `.env` (đã gitignore) và luôn bị redact trong log.
- **Các key đã gửi qua chat nên được coi là đã lộ — hãy rotate** (tạo token/key mới) sau khi bot chạy ổn.
- Webhook bắt buộc secret ≥ 8 ký tự, so sánh timing-safe; secret tự sinh được lưu ở `data/webhook-secret` (không commit).
- Webhook chỉ bind localhost theo mặc định; `setWebhook`/`sendMessage` không retry để tránh gửi trùng.
- Nên đặt `ALLOWED_CHAT_IDS` và `ADMIN_IDS` khi dùng thật trong group.

## Giới hạn đã biết

- Group chat của Zalo Bot đang **Beta**, không có tính năng "nghe mọi tin nhắn trong nhóm".
- `getUpdates` (polling) chỉ nên dùng khi dev; production nên dùng webhook để không bỏ lỡ event.
- Không có tính năng nghe tin thoại (voice); sticker chỉ gửi được bằng **sticker ID chính thức** (20 hex). ID gói trên stickers.zaloapp.com **không** dùng được (Zalo trả `425 The sticker is invalid`) — dùng `/sticker add <id>` với ID lấy theo hướng dẫn của Zalo ([video](https://vimeo.com/649330161)).
- Không thể "huỷ" typing indicator phía Zalo: bot dừng gửi typing trước khi nhắn, phần còn lại do client Zalo tự hết hạn (~vài giây).
- NIM báo `cached_tokens = 0` kể cả khi request giống hệt → không có prefix cache thực tế; system prompt vẫn được giữ tĩnh để không tự làm hại nếu NVIDIA bật cache sau này.
- DeepSeek chỉ nhận `reasoning_effort` là `none|low|high|max` (`off` bị 422) — bot map sẵn. Tên model của API là `deepseek-flash` (V4.1 Flash) và `deepseek-v4-pro`.
