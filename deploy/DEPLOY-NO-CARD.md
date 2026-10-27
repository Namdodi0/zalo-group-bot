# Deploy KHÔNG CẦN THẺ

Hai đường khả thi khi không có thẻ tín dụng. Chọn một.

- **A. Máy ở nhà** — miễn phí nhất, ổn định nhất, cần một máy chạy 24/7.
- **B. Wispbyte free** — không cần thẻ, không cần máy, nhưng panel-only và có rủi ro tự stop.

Bot dùng **polling**: không cần IP công khai, không cần domain, không cần mở port.

---

## Chuẩn bị chung (1 lần)

### 1. Lấy key, KHÔNG commit

`.env` trong repo đã được làm trống `DEEPSEEK_API_KEY`. Điền key ở máy đích:

```ini
ZALO_BOT_TOKEN=<token Zalo Bot Creator>
DEEPSEEK_API_KEY=<key mới tạo>
NIM_API_KEY=<key NIM, dự phòng>
TAVILY_API_KEY=<key Tavily>
ALLOWED_CHAT_IDS=<chat.id của group>     # nên điền, tránh bot trả lời mọi chat
```

### 2. Tạo bản đóng gói sạch

```powershell
cd zalo-group-bot
npm run pack        # -> dist/zalo-group-bot-*.zip  (~108 KB, không có .env/data)
```

---

## A. Máy ở nhà (Windows)

Phù hợp: PC cũ, laptop, mini PC. Yêu cầu: Node ≥ 22.9, máy bật 24/7.

### A1. Chuẩn bị máy

```powershell
# cài Node 22 nếu chưa có: https://nodejs.org  (chọn LTS)
node -v            # phải >= v22.9

# giải nén gói
Expand-Archive .\dist\zalo-group-bot-*.zip -DestinationPath C:\zalo
cd C:\zalo

# tạo .env từ mẫu rồi điền key
copy .env.example .env
notepad .env

# chạy thử trước khi cài tự động
node --env-file-if-exists=.env src/index.js
```

Thấy log `zalo bot ready` là được. `Ctrl+C`.

### A2. Cài tự chạy + tự restart

```powershell
cd C:\zalo
powershell -ExecutionPolicy Bypass -File .\deploy\install-windows.ps1 -Root C:\zalo
```

Script tạo 2 Scheduled Task:

| Task | Việc |
|---|---|
| `ZaloBot` | chạy khi đăng nhập Windows, **tự restart nếu crash**, không giới hạn thời gian |
| `ZaloBotBackup` | nén `data/` mỗi ngày, giữ 14 bản |

Xem trước không cài: thêm `-DryRun`.

### A3. Chống máy ngủ / Windows Update restart

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
# Task Scheduler đã bật "Start when available" nên sau reboot bot tự lên lại khi có người đăng nhập
```

Nếu máy không ai đăng nhập sau reboot: mở Task Scheduler → task `ZaloBot` → Properties →
chọn **Run whether user is logged on or not** (cần nhập mật khẩu Windows một lần).

### A4. Kiểm tra

```powershell
Get-ScheduledTask -TaskName ZaloBot | Get-ScheduledTaskInfo
Get-Content C:\zalo\data\logs\bot.log -Tail 20    # nếu bạn bật log ra file
```

Rồi vào group gõ `@Bot /status`.

---

## B. Wispbyte free (không cần thẻ, không cần máy)

Free: 512 MB RAM / 1 GB disk / 1 deployment, không cần thẻ, không gia hạn tay.
Fair Use: **1 tài khoản free / người**.

### B1. Tạo deployment

1. Đăng ký tại https://wispbyte.com (không cần thẻ)
2. **Create server** → chọn **Node.js** → image Node 22
3. Upload `dist/zalo-group-bot-*.zip` (hoặc trỏ GitHub repo nếu bạn đẩy code lên)
4. Giải nén trong file manager của panel, để `src/index.js` ở thư mục gốc server

Nếu lấy code từ GitHub (repo public): dán `https://github.com/Namdodi0/zalo-group-bot.git`, branch `main`, bật `AUTO_UPDATE=1` để mỗi lần restart tự `git pull`.

### B2. Nhập biến môi trường

Trong panel → **Environment / Startup**, thêm đúng các biến sau (không cần file `.env`):

```
ZALO_BOT_TOKEN=...
DEEPSEEK_API_KEY=...
NIM_API_KEY=...
TAVILY_API_KEY=...
MODEL_DEFAULT=deepseek
MODEL_FALLBACK=nim-light
ALLOWED_CHAT_IDS=...
BOT_TONE=hard
LOG_FORMAT=json
```

### B3. Startup command

```
node index.js
```

Bot **tự nạp `.env`** ở thư mục đang chạy (xem `src/env.js`), nên:

- Có file `.env` → dùng được ngay, không cần cờ `--env-file-if-exists`.
- Không có `.env` → biến lấy từ panel vẫn chạy (biến trong môi trường luôn thắng file).
- Nếu vẫn báo `fatal: Thiếu ZALO_BOT_TOKEN`, phần `hint:` ngay dưới sẽ in **thư mục làm việc** và **đã tìm `.env` ở đâu** → tạo file đúng chỗ đó.

Lưu ý khi tạo `.env` bằng File Manager của panel:

- Lưu dạng **UTF-8, không BOM** (Notepad: *Save as → Encoding: UTF-8*; nếu có BOM bot vẫn đọc được, nhưng đừng dùng UTF-16).
- Không cần dấu nháy quanh giá trị; comment bằng `#` ở đầu dòng.
- Trên Wispbyte, đặt `DATA_DIR` tới volume persistent (thường `/home/container/data`), **không dùng `/tmp`** — `/tmp` mất mỗi lần restart. Đường dẫn tương đối (`./data`) giờ được tính từ gốc repo, nhưng đường dẫn tuyệt đối vẫn an toàn hơn.
- Trước khi **Reinstall/Redeploy**: tải `data/contexts/*.json` về máy. Reinstall xoá sạch `data/`; `git pull` + restart thì không.
- `CONTEXT_TTL_HOURS=0` = giữ context mãi; mặc định 72 giờ, khuyến nghị 720 giờ (30 ngày).

### B4. Kiểm tra

- Console phải hiện `zalo bot ready`
- Vào group gõ `@Bot /status`
- Cắm **uptime monitor** (UptimeRobot/Better Stack free, 5 phút/lần) trỏ vào
  `https://<server>.wispbyte.cloud` nếu panel cấp domain, hoặc dùng ping Zalo API.

### B5. Rủi ro phải biết

| Rủi ro | Cách giảm |
|---|---|
| Tự stop / 504 / maintenance | Uptime monitor + bật auto-restart trong panel |
| `data/` mất khi **Reinstall/Redeploy** | Đặt `DATA_DIR` tuyệt đối ngoài thư mục code; tải `data/contexts/*.json` về máy trước khi reinstall |
| Bot "mất trí nhớ" sau restart | Xem log `context store { dir, files, ttl }` lúc khởi động và `/status`; `files=0` → sai `DATA_DIR` hoặc TTL quá ngắn |
| 512 MB RAM | Đã đủ cho bot (bỏ Grok proxy rồi, ~100–150 MB) |
| Token trên hạ tầng họ | Dùng key riêng cho bot, thu hồi được khi cần |

---

## Checklist trước khi coi là "đã deploy"

- [ ] `node --test` chạy trên máy đích: **141/141 pass**
- [ ] `ALLOWED_CHAT_IDS` đã điền (nếu không bot trả lời mọi chat)
- [ ] `/status` trong group trả về được
- [ ] Đã cắm uptime monitor
- [ ] Backup `data/` chạy (Task Scheduler hoặc tải tay)
- [ ] Key DeepSeek **mới**, không dùng lại key cũ đã lộ
