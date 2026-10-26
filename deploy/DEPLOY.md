# Đóng gói để deploy lên server

> Không có thẻ tín dụng (không dùng được Oracle/GCP)? Xem **[DEPLOY-NO-CARD.md](DEPLOY-NO-CARD.md)**
> — máy ở nhà (Windows, có script `install-windows.ps1`) hoặc Wispbyte free.

Mục tiêu: gói **sạch** — có code, không có `node_modules` (dev-only), không có `.env`
(bí mật) và không có lịch sử chat (`data/`).

## 1. Tạo gói

Trên máy Windows đang phát triển:

```powershell
cd zalo-group-bot
npm run pack
# -> dist/zalo-group-bot-YYYYMMDD-HHmm.zip
```

Script `scripts/pack.ps1` chỉ copy những gì cần:

| Đưa vào gói | Không đưa |
|---|---|
| `src/`, `scripts/`, `test/`, `test-utils/` | `node_modules/` (32 MB, chỉ để typecheck) |
| `package.json`, `package-lock.json`, `tsconfig.json` | `.env` (chứa token Zalo, key DeepSeek/NIM/Tavily) |
| `.env.example`, `.gitignore`, `README.md` | `data/` (lịch sử chat, có thể chứa nội dung riêng tư) |
| `ecosystem.config.cjs`, `deploy/` | `*.log`, `*.tmp`, `dist/` |

Gói thực tế ~60–80 KB.

## 2. Đưa lên server

```powershell
scp .\dist\zalo-group-bot-*.zip root@SERVER:/opt/zalo/
```

`.env` **gửi riêng**, sau khi tạo thư mục:

```powershell
scp .\.env root@SERVER:/opt/zalo/zalo-group-bot/.env
```

Trên server nhớ `chmod 600 .env`.

## 3. Cài trên server (Ubuntu/Debian)

```bash
# Node >= 22.9 (project không có runtime dependency nào khác)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs unzip
node -v          # phải >= v22.9

sudo mkdir -p /opt/zalo && cd /opt/zalo
sudo unzip zalo-group-bot-*.zip -d zalo-group-bot
cd zalo-group-bot
chmod 600 .env

# 1 phút kiểm tra trước khi chạy nền
node --env-file-if-exists=.env --test
node --env-file-if-exists=.env src/index.js --help
```

Không cần `npm install` — dự án không có dependency runtime. Chỉ khi muốn
`npm run typecheck` mới cần `npm ci`.

## 4. Chạy nền

### Cách A — pm2 (khuyến nghị)

```bash
sudo npm i -g pm2
cd /opt/zalo/zalo-group-bot
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs zalo-bot --lines 50
pm2 save
pm2 startup                       # chạy đúng dòng nó in ra để tự bật khi reboot
```

### Cách B — systemd

```bash
sudo cp deploy/zalo-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zalo-bot
systemctl status zalo-bot
journalctl -u zalo-bot -f
```

Sửa `User=`/`WorkingDirectory=` trong unit file nếu bạn không dùng `/opt/zalo` và user `zalobot`.

## 5. Kiểm tra sau deploy

```bash
# bot gọi được Zalo?
journalctl -u zalo-bot -n 20 | grep -Ei "ready|fatal|token"

# (tuỳ chọn) mở ops endpoint: đặt OPS_PORT=8080 trong .env rồi restart
curl -s http://127.0.0.1:8080/metrics | head -30
```

Rồi vào group gõ `@Bot /status` — phải trả về model, context, độ trễ.

## Lưu ý khi chạy trên server

- **Polling không cần IP công khai/domain.** Chỉ khi dùng `MODE=webhook` mới cần HTTPS
  (nginx + certbot, hoặc `cloudflared tunnel`), và khi đó phải đặt `WEBHOOK_PUBLIC_URL`.
- **Chỉ chạy MỘT instance.** Hai bot cùng token sẽ tranh `getUpdates` và trả 409.
- **`data/` là state thật** (context, sticker). Backup định kỳ:
  `tar czf /backup/zalo-data-$(date +%F).tgz data/`
- **Không chạy bằng `root`** nếu không cần: tạo user riêng `zalobot` và `chown -R`.
- Cập nhật phiên bản: giải nén gói mới đè lên, giữ nguyên `.env` và `data/`,
  rồi `pm2 restart zalo-bot` (hoặc `systemctl restart zalo-bot`).
