# Deploy WITHOUT A CARD

Two viable routes when you have no credit card. Pick one.

- **A. A machine at home** — cheapest, most stable, needs a machine that runs 24/7.
- **B. Wispbyte free** — no card, no machine, but panel-only and at risk of stopping itself.

The bot uses **polling**: no public IP, no domain, no open port needed.

---

## Shared setup (once)

### 1. Get the keys, do NOT commit them

`DEEPSEEK_API_KEY` in the repo's `.env` has been blanked out. Fill in the keys on the target machine:

```ini
ZALO_BOT_TOKEN=<token from Zalo Bot Creator>
DEEPSEEK_API_KEY=<newly created key>
NIM_API_KEY=<NIM key, fallback>
TAVILY_API_KEY=<Tavily key>
ALLOWED_CHAT_IDS=<the group's chat.id>     # fill this in, otherwise the bot answers every chat
```

### 2. Create a clean package

```powershell
cd zalo-group-bot
npm run pack        # -> dist/zalo-group-bot-*.zip  (~108 KB, no .env/data)
```

---

## A. A machine at home (Windows)

Good fit: an old PC, a laptop, a mini PC. Requirements: Node ≥ 22.9, the machine on 24/7.

### A1. Prepare the machine

```powershell
# install Node 22 if you don't have it: https://nodejs.org  (pick LTS)
node -v            # must be >= v22.9

# unzip the package
Expand-Archive .\dist\zalo-group-bot-*.zip -DestinationPath C:\zalo
cd C:\zalo

# create .env from the template, then fill in the keys
copy .env.example .env
notepad .env

# test-run it before installing automatic startup
node --env-file-if-exists=.env src/index.js
```

If you see the `zalo bot ready` log, you're good. `Ctrl+C`.

### A2. Install auto-start + auto-restart

```powershell
cd C:\zalo
powershell -ExecutionPolicy Bypass -File .\deploy\install-windows.ps1 -Root C:\zalo
```

The script creates 2 Scheduled Tasks:

| Task | What it does |
|---|---|
| `ZaloBot` | runs at Windows logon, **restarts itself if it crashes**, no time limit |
| `ZaloBotBackup` | zips `data/` every day, keeps 14 copies |

Preview without installing: add `-DryRun`.

### A3. Stop the machine from sleeping / Windows Update restarts

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
# Task Scheduler already has "Start when available" enabled, so after a reboot the bot comes back up when someone logs in
```

If nobody logs in after a reboot: open Task Scheduler → the `ZaloBot` task → Properties →
select **Run whether user is logged on or not** (you need to type the Windows password once).

### A4. Check

```powershell
Get-ScheduledTask -TaskName ZaloBot | Get-ScheduledTaskInfo
Get-Content C:\zalo\data\logs\bot.log -Tail 20    # if you enabled logging to file
```

Then go into the group and type `@Bot /status`.

---

## B. Wispbyte free (no card, no machine)

Free: 512 MB RAM / 1 GB disk / 1 deployment, no card needed, no manual renewal.
Fair Use: **1 free account / person**.

### B1. Create the deployment

1. Sign up at https://wispbyte.com (no card needed)
2. **Create server** → pick **Node.js** → the Node 22 image
3. Upload `dist/zalo-group-bot-*.zip` (or point it at the GitHub repo if you push your code up)
4. Unzip it in the panel's file manager, leaving `src/index.js` at the server's root directory

If you take the code from GitHub (public repo): paste `https://github.com/Namdodi0/zalo-group-bot.git`, branch `main`, turn on `AUTO_UPDATE=1` so every restart does a `git pull`.

### B2. Enter the environment variables

In the panel → **Environment / Startup**, add exactly these variables (no `.env` file needed):

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

The bot **loads `.env` itself** from the working directory (see `src/env.js`), so:

- If there is an `.env` file → it works right away, no `--env-file-if-exists` flag needed.
- If there is no `.env` → variables from the panel still work (environment variables always win over the file).
- If you still see a `fatal:` error about a missing `ZALO_BOT_TOKEN`, the `hint:` right below prints the **working directory** and **where it looked for `.env`** → create the file in that exact place.

Notes when creating `.env` with the panel's File Manager:

- Save as **UTF-8, no BOM** (Notepad: *Save as → Encoding: UTF-8*; the bot still reads a BOM, but don't use UTF-16).
- No quotes needed around values; comments start with `#` at the beginning of the line.
- On Wispbyte, point `DATA_DIR` at a persistent volume (usually `/home/container/data`), **don't use `/tmp`** — `/tmp` disappears on every restart. Relative paths (`./data`) are now resolved from the repo root, but an absolute path is still safer.
- Before a **Reinstall/Redeploy**: download `data/contexts/*.json` to your machine. A reinstall wipes `data/`; a `git pull` + restart does not.
- `CONTEXT_TTL_HOURS=0` = keep the context forever; the default is 72 hours, 720 hours (30 days) is recommended.

### B4. Check

- The console must show `zalo bot ready`
- Go into the group and type `@Bot /status`
- Hook up an **uptime monitor** (UptimeRobot/Better Stack free, every 5 minutes) pointed at
  `https://<server>.wispbyte.cloud` if the panel gives you a domain, or use a ping to the Zalo API.

### B5. Risks you must know

| Risk | How to reduce it |
|---|---|
| Stops itself / 504 / maintenance | Uptime monitor + enable auto-restart in the panel |
| `data/` lost on **Reinstall/Redeploy** | Set `DATA_DIR` to an absolute path outside the code directory; download `data/contexts/*.json` before reinstalling |
| Bot "loses its memory" after a restart | Check the `context store { dir, files, ttl }` log at startup and `/status`; `files=0` → wrong `DATA_DIR` or a TTL that is too short |
| 512 MB RAM | Already enough for the bot (the Grok proxy is gone, ~100–150 MB) |
| Token on their infrastructure | Use a dedicated key for the bot, one you can revoke when needed |

---

## Checklist before calling it "deployed"

- [ ] `node --test` runs on the target machine: **141/141 pass**
- [ ] `ALLOWED_CHAT_IDS` is filled in (otherwise the bot answers every chat)
- [ ] `/status` in the group responds
- [ ] An uptime monitor is hooked up
- [ ] A backup of `data/` runs (Task Scheduler or manual download)
- [ ] A **new** DeepSeek key, not the old leaked one
