# Packaging for deployment to a server

> No credit card (can't use Oracle/GCP)? See **[DEPLOY-NO-CARD.md](DEPLOY-NO-CARD.md)**
> — a machine at home (Windows, with the `install-windows.ps1` script) or free Wispbyte.

Goal: a **clean** package — it has the code, but no `node_modules` (dev-only), no `.env`
(secrets) and no chat history (`data/`).

## 1. Create the package

On the Windows machine you develop on:

```powershell
cd zalo-group-bot
npm run pack
# -> dist/zalo-group-bot-YYYYMMDD-HHmm.zip
```

The `scripts/pack.ps1` script only copies what is needed:

| Goes into the package | Does not |
|---|---|
| `src/`, `scripts/`, `test/`, `test-utils/` | `node_modules/` (32 MB, only for typecheck) |
| `package.json`, `package-lock.json`, `tsconfig.json` | `.env` (holds the Zalo token, DeepSeek/NIM/Tavily keys) |
| `.env.example`, `.gitignore`, `README.md` | `data/` (chat history, may contain private content) |
| `ecosystem.config.cjs`, `deploy/` | `*.log`, `*.tmp`, `dist/` |

The real package is ~60–80 KB.

## 2. Upload it to the server

```powershell
scp .\dist\zalo-group-bot-*.zip root@SERVER:/opt/zalo/
```

Send `.env` **separately**, after creating the directory:

```powershell
scp .\.env root@SERVER:/opt/zalo/zalo-group-bot/.env
```

On the server, remember `chmod 600 .env`.

## 3. Install on the server (Ubuntu/Debian)

```bash
# Node >= 22.9 (the project has no other runtime dependency)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs unzip
node -v          # must be >= v22.9

sudo mkdir -p /opt/zalo && cd /opt/zalo
sudo unzip zalo-group-bot-*.zip -d zalo-group-bot
cd zalo-group-bot
chmod 600 .env

# a 1-minute check before running in the background
node --env-file-if-exists=.env --test
node --env-file-if-exists=.env src/index.js --help
```

No `npm install` needed — the project has no runtime dependencies. You only need
`npm ci` if you want to run `npm run typecheck`.

## 4. Run in the background

### Option A — pm2 (recommended)

```bash
sudo npm i -g pm2
cd /opt/zalo/zalo-group-bot
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs zalo-bot --lines 50
pm2 save
pm2 startup                       # run exactly the line it prints so it starts on reboot
```

### Option B — systemd

```bash
sudo cp deploy/zalo-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zalo-bot
systemctl status zalo-bot
journalctl -u zalo-bot -f
```

Change `User=`/`WorkingDirectory=` in the unit file if you are not using `/opt/zalo` and the user `zalobot`.

## 5. Check after deploying

```bash
# can the bot reach Zalo?
journalctl -u zalo-bot -n 20 | grep -Ei "ready|fatal|token"

# (optional) expose the ops endpoint: set OPS_PORT=8080 in .env then restart
curl -s http://127.0.0.1:8080/metrics | head -30
```

Then go into the group and type `@Bot /status` — it must return the model, context and latency.

## Notes for running on a server

- **Polling needs no public IP/domain.** Only `MODE=webhook` needs HTTPS
  (nginx + certbot, or `cloudflared tunnel`), and then you must set `WEBHOOK_PUBLIC_URL`.
- **Run only ONE instance.** Two bots with the same token fight over `getUpdates` and return 409.
- **`data/` is real state** (context, stickers). Back it up regularly:
  `tar czf /backup/zalo-data-$(date +%F).tgz data/`
- **Don't run as `root`** unless you have to: create a dedicated `zalobot` user and `chown -R`.
- Updating the version: unzip the new package on top, keep `.env` and `data/` intact,
  then `pm2 restart zalo-bot` (or `systemctl restart zalo-bot`).
