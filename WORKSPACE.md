# WORKSPACE

## 2026-06-20（ssh OAuth「OAuth is not configured」→ 容器 env 丢失，已修）

- 现象：ChatGPT 跳转 `/authorize?...` 返回 **500 纯文本 `OAuth is not configured`**；`/health` 为 **`oauth_enabled: false`**。
- 根因：进程未读到 **`OAUTH_LOGIN_SECRET`**（宿主机 env 曾错写 `OAUTH_OAUTH_LOGIN_SECRET`）；容器内 **`OAUTH_BASE_URL` 为空**；`SSH_MCP_DATA_DIR` 指向未挂载路径。运维常用 **`docker restart`** 不会应用 `--env-file` 变更。
- 修复：运行 `deploy/scripts/fix-korea-oauth-data-path.py`（校正 env、从 137 同步 `OAUTH_LOGIN_SECRET`、oauth-clients 写入挂载目录、**rm+run 重建**）；复测 **`oauth_enabled: true`**，authorize 出现登录密钥表单 `name="secret"`。
- **文档（同会话续）**：新增 `docs/DOCKER-ENV-FILE-RECREATE.md`（泛化 Agent 可复制段落 + 韩国落地表）；更新 `docs/CHATGPT.md`（500 小节、Troubleshooting、restart 说明）、`docs/DEPLOYMENT-HOSTS.md`、`README.md` Operations；增强 `fix-korea-oauth-data-path.py`。
- 用户要求：把「避免 restart 误判」写成可交给其它 Agent 的泛化话术 → **`docs/DOCKER-ENV-FILE-RECREATE.md` 顶部「可复制段落」**。
- 用户要求：在 **`workmust/docs/external-agents/`**（与 `Tools.md` 同路径）新建 **`docker.md`** 写入上述纪律；更新 `Tools.md` OAuth 小节（500 与 docker.md 链接）、`external-agents/README.md` 索引。

## 2026-06-19（四公网 MCP「链接方式」复测 · 续）

- 本会话再次执行 `probe-four-mcp-public.py`、`probe-four-mcp-oauth-link.py`：四域 `/health` **200**；韩国 ssh **`ssh_profile_count: 9`**、`default_ssh_profile_id: azure-kr-001`。
- **未授权 `POST /mcp` + `initialize`**：tmp1/tmp2/mcp → **401**；**ssh → 200**（仅握手，**exec 等工具仍需 Bearer**）。
- **mcp**：`oauth-protected-resource` 的 `resource` 亦为 **sandbox** 域，与 ssh/tmp 完全独立。
- **文档**：`docs/MCP-PUBLIC-SERVICES.md` 修正未授权行为表、易混点编号与 scope 说明。

## 2026-06-19（四公网 MCP「链接方式」复测）

- 公网 `/health` 四域均 **200**（与 `probe-four-mcp-public.py` 一致）：ssh 9 profiles / `azure-kr-001`；tmp1 chrome 1.2.0；tmp2 memory 0.6.4；mcp remote-dev 0.1.37。
- **连接器 URL**：均为各自域名下的 **`https://<子域>.zerodotsix.top/mcp`**，不可互用。
- **OAuth issuer**：ssh / tmp1 / tmp2 的 `issuer` 与公网域名一致；**mcp** 的 `/.well-known/oauth-authorization-server` 返回 **`issuer: https://sandbox.zerodotsix.top`**，`authorize`/`token` 亦在 sandbox 域（与 ssh/tmp 不同模式）。
- **未授权 `/mcp`**：tmp1/tmp2/mcp → 401；ssh 裸 GET 可能 405；ssh 无 Bearer 的 `initialize` 可 200（见上节）。
- **文档**：`docs/MCP-PUBLIC-SERVICES.md` 增补「ChatGPT 连接器链接方式」表与 mcp/sandbox 易混点。

## 2026-06-19（四公网 MCP：ssh / tmp1 / tmp2 / mcp 对照）

- 用户问验证用的四个服务有何不同。
- **公网 health 200（同日）**：`ssh` → ssh-mcp-chatgpt 韩国 9 profiles；`tmp1` → chrome-devtools-mcp 1.2.0 @137:3031；`tmp2` → memory-mcp-chatgpt 0.6.4 @137:3032；`mcp` → remote-dev 0.1.37 @139（非本仓库）。
- **文档**：新增 `docs/MCP-PUBLIC-SERVICES.md`；`DEPLOYMENT-HOSTS.md` 补 tmp2；脚本 `probe-four-mcp-public.py`、`probe-137-mcp-nginx.py`。

## 2026-06-19（OAuth 仍失败 → **DATA_DIR 挂载不一致**，已修）

- 用户：「是不是没启动服务」— **服务在跑**（`ssh-mcp-chatgpt-korea` Up，`:3039` `/health` 公网 200）。
- **真因**：容器 `SSH_MCP_DATA_DIR=/srv/ssh-mcp-chatgpt/data`，但 **未挂载** `/srv`；`oauth-clients.json` 写在宿主机 `/srv/...`，进程读的是容器内**另一份**旧文件（仅 bootstrap client）。登记 `mcp-client-27Z…` 对运行中进程**不可见** → 仍帮助页。
- **修复**：`fix-korea-oauth-data-path.py` — `SSH_MCP_DATA_DIR=/opt/ssh-mcp-chatgpt-korea/data`（与 volume 一致）、oauth 写入该目录、**docker rm + run** 重建。复测 authorize 出现 **`name="secret"`** 登录表单。
- **脚本**：`diag-korea-oauth-full.py`、`diag-korea-container-oauth.py`、`fix-korea-oauth-data-path.py`；`register-oauth-client-korea.py` 默认路径改为 mounted data dir。

## 2026-06-19（韩国生产 9 路 profile + server_id 统一）

- **范围**：仅改 **azure-kr-001** 上 `/opt/ssh-mcp-chatgpt-korea/profiles.json`（不动 137 本机 pr8 文件）。
- **第 9 台**：`do-nyc-001`（`137.184.23.118`，`root`）写入韩国连接器 profile 列表。
- **改名**：`azure-korea-b1slinux` → **`azure-kr-002`**（同 VM 公网 `20.196.72.18`，与 `azure-kr-001` 本机 `127.0.0.1` 并存）；其余 legacy id 见 `docs/HOST-NAMING.md`。
- **脚本**：`deploy/scripts/sync-korea-profiles-canonical.py`（9 条 + restart + 轮询 health）；登记 `host_registry.py`（含 `azure-kr-002`、`do-nyc-001`）。
- **执行**：`sync-korea-profiles-canonical.py` 已写入 **9** 条 profile（`default: azure-kr-001`）；首次 health 失败因容器内仍 **`SSH_MCP_DEFAULT_PROFILE=direct`**（`docker restart` 不刷新 `--env-file`）。
- **修复**：`fix-korea-default-profile-env.py` 改 `/opt/ssh-mcp-chatgpt-korea/env` → `azure-kr-001`；`recreate-korea-ssh-mcp-container.py` **rm + docker run** 后验收：`ssh_profile_count: 9`，`default_ssh_profile_id: azure-kr-001`。
- **文档**：`HOST-NAMING.md`、`SSH-MCP-MULTI-PROFILE.md`、`DEPLOYMENT-HOSTS.md`、`deploy/profiles.example.json`。
- **workmust**：`docs/external-agents/Tools.md` 已与上游 VPS 逐台审查合并，并统一为 **`server_id`**；**rebase 解决冲突**后 **push** `origin/master` → **`2fdd09a`**（`ZeroPointSix/workmust`）。本地遗留未跟踪 `workmust/deploy/merge-tools-md.py`（一次性脚本，可删）。

## 2026-06-19（主机命名 + 韩国标准脚本 + do-nyc-001 盘点）

- **命名规范**：`{vendor}-{region}-{seq}`（如 `azure-kr-001`、`do-nyc-001`）；登记在 `deploy/scripts/host_registry.py`，说明见 `docs/HOST-NAMING.md`。
- **137.184.23.118** 实测：`root` SSH **OK**；**无 `hu` 用户**；约 **7.8Gi** 内存、负载正常；仍跑 `chrome-devtools-mcp`、`ssh-mcp` pr8 容器、`:3039`；公网 **ssh-mcp** 已指韩国，**tmp1** 仍指该机。
- **脚本**：新增 `host_registry.py`、`probe-host.py`、`apply-profile-naming-korea.py`；`add-ssh-profile-korea.py` 支持 `--server-id`；`probe-ssh-login.py` / `korea-ssh-mcp-status.py` / `probe-server.py` / `probe-host-region.py` 改走 registry；`deploy/profiles.example.json`、`opencode.jsonc` MCP 名改为 `ssh-azure-in-001` 等。
- **生产**：后台执行 `apply-profile-naming-korea.py` 将韩国 `profiles.json` 的 `target_id` 迁为 `server_id`（默认 `azure-kr-001`）；结果见 `deploy/logs/apply-profile-naming-korea.log`（若存在）。
- **待办**：其余 `deploy/scripts/*.py` 仍含硬编码 IP/密码的，可逐步改为 `host_registry` + 环境变量。

## 2026-06-18（profiles 重写 + restart ×2）

- 用户要求：新配置写上去并重启。已 `add-ssh-profile-korea.py --restart` 更新 **`do-168-4h8g`**、**`do-sgp-remote-dev`**（`root` / `PLA718125hhc`），各触发 **`docker restart ssh-mcp-chatgpt-korea`**；`https://ssh.zerodotsix.top/health` → **`ssh_profile_count: 8`**。重启后从韩国 SSH：**168 OK**，**139 仍 Permission denied**（与 profiles 内容无关，为 139 对韩国源 IP 认证）。

## 2026-06-18（韩国 profiles +2：DO 沙箱 / DO 4h8g）

- 用户：盘点韩国机 profile 并新增 **168.144.29.187**（4h8g）、**139.59.96.181**（remote-dev 沙箱）；同步文档与 WORKSPACE。
- **139.59.96.181**：凭据与仓库运维脚本一致 → `root` / `PLA718125hhc`（`read-mcp-nginx.py`、`probe-lark-139.py`）；`probe-ssh-login.py` → **SSH_OK**（`chatgptwork`）。
- **168.144.29.187**：`root` / **`PLA718125hhc`**；本机与从韩国 **`sshpass` 均 SSH_OK**（fail2ban inactive）。
- **韩国复测 139**：从 `20.196.72.18` → **139 密码认证失败**（auth.log 有 Failed password）；本机 OK；非 fail2ban；`do-sgp-remote-dev` 连接器待修 139。
- 生产写入：`add-ssh-profile-korea.py` → `do-sgp-remote-dev`、`do-168-4h8g`；**`docker restart ssh-mcp-chatgpt-korea`**；`http://127.0.0.1:3039/health` → **`ssh_profile_count: 8`**。
- 文档：`docs/SSH-MCP-MULTI-PROFILE.md`、`docs/DEPLOYMENT-HOSTS.md`、`deploy/profiles.example.json`、`docs/workspace/2026-06-18-korea-profiles-add-do-hosts.md`。

## 2026-06-18 会话结束（用户确认）

本会话完成：`ssh.zerodotsix.top` 迁韩国 **20.196.72.18**（HTTPS/OAuth/`oauth-clients.json`）、**ChatGPT 连接器可用**、`singapore-test` → **腾讯云硅谷 49.51.46.235** 并 **重启** `ssh-mcp-chatgpt-korea`、git 仅 **`master`**（多 profile PR #8）、远程分支已 prune。用户：**结束当前对话**。

专档：`docs/workspace/2026-06-18-ssh-domain-korea-cutover.md`。

## 2026-06-18（清理已合并分支 — 本地+远程已同步）

- 已合并进 `master` 的分支：`codex/issue-7-profile-routing`（PR #8）、`codexweb/chatgpt-app-adapter`。
- **本地**：仅 **`master`**（已删 `codexweb/chatgpt-app-adapter`）。
- **远程**：GitHub 上已无上述分支；`git fetch origin --prune` 后 `git ls-remote --heads origin` 仅 **`master`**（`e58cbb4`）；`origin/*` 跟踪只剩 `origin/master`。
- `CONTRIBUTING.md`：PR 基线改为 **`master`**（无 `main`）。

## 2026-06-18（分支：无 main，master 最新且含多 profile）

- 用户问「main 是否最新、多 profile 是否接入」：**本仓库无 `main` / `origin/main`**；默认分支为 **`master`**（`origin/HEAD` → `origin/master`）。
- 当前本地/远程 **`master` = `e58cbb4`**（2026-06-17）：**Merge PR #8** `codex/issue-7-profile-routing` → 已含 **`list-profiles`**、`target_id`、`SSH_MCP_PROFILES_FILE` 等（见 `src/chatgpt-http.ts`、`test/chatgpt-http.profiles.test.ts`）。
- 无更新于 `master` 且另带 profiles 的分支；`codexweb/chatgpt-app-adapter` 较旧且无 profiles。

## 2026-06-18（profile singapore-test → 腾讯云硅谷 49.51.46.235）

- 机器：**腾讯云硅谷**，`49.51.46.235`，`hu`，hostname `VM-0-14-ubuntu`；本地 SSH 探测 **OK**。
- 生产（韩国）`profiles.json`：`singapore-test` → **腾讯云硅谷** `hu@49.51.46.235:22`；用户确认后已 **`docker restart ssh-mcp-chatgpt-korea`**，`/health` → ok，`oauth_enabled: true`。
- 脚本：`probe-ssh-login.py`、`add-ssh-profile-korea.py`。

## 2026-06-18（ssh.zerodotsix.top → 韩国 20.196.72.18）

- DNS A → **`20.196.72.18`**；OpenResty → **`127.0.0.1:3039`**；**`ssh-mcp-chatgpt-korea`**，`oauth_enabled: true`，6 profiles。
- **HTTPS**：LE + `finish-korea-ssl-ssh-zerodotsix.py`；`https://ssh.zerodotsix.top/health` → **200**（2026-06-18）。
- **OAuth**：裸开 `/authorize` → 帮助页（预期）。带 ChatGPT 参数仍帮助页 → 已 `sync-korea-oauth-clients.py` 同步 `oauth-clients.json`；用户确认 **ChatGPT 连接器已成功连上**（2026-06-18）。
- 运维：OAuth env → `setup-korea-ssh-zerodotsix.py` + **`finish-korea-ssl-ssh-zerodotsix.py`**；迁站/缺 client 登记 → **`sync-korea-oauth-clients.py`**。
- 专档：`docs/workspace/2026-06-18-ssh-domain-korea-cutover.md`；`docs/DEPLOYMENT-HOSTS.md`。

## 2026-06-18（用户跨仓引用 — 机房 23.80.81.128 网速）

- 用户在 **QualityCenterPlatform-backend** 会话中要求：本机 **不开代理** vs **开代理 `127.0.0.1:7890`** 测速到 **`23.80.81.128`**。
- 完整日志与结论见后端仓库：`docs/workspace/2026-06-18-github-issues-merge-readiness-and-network-probe.md` 与 `.cursor/network-23.80.81.128-v2.log`。
- **摘要**：443 可达；HTTPS 证书过期。**延时**：Ping **~180 ms**；HTTPS 首包 **~0.5～1 s**；开代理与直连同量级。建议运维 **续期 TLS**。

## 2026-06-15

### Context gathered

- Checked repository docs and deployment scripts before making changes.
- No existing `WORKSPACE.md` was present in the repository at the start of this session.
- Confirmed from local scripts that SSH MCP and browser-control services have separate deployment histories.

### Remote findings

- `ssh-mcp-chatgpt` deployment scripts target `137.184.23.118` and `ssh.zerodotsix.top`.
- Historical `remote-dev-mcp` helper script targets `139.59.96.181` and `mcp.zerodotsix.top`.
- Therefore the two services are on the same DigitalOcean platform, but not the same machine.
- On `139.59.96.181`:
  - Nginx proxies `mcp.zerodotsix.top` to `127.0.0.1:3025`.
  - Container `remote-dev-mcp-v2` was running with image `remote-dev-mcp:prod-0.1.33`.
  - `GET /health` returned 200 and reported Docker workspace runtime available.
  - `GET /mcp` returned 401 without auth, which is expected.
  - No host listeners were found on raw Chrome DevTools ports `9222/9223`.
  - Container env included `SYNC_TIMEOUT_MS=10000`, which is a likely candidate for browser/session sync timeout issues.

### Scope correction

- User clarified that the actual browser MCP to investigate is `ZeroPointSix/chrome-devtools-mcp`.
- Therefore `remote-dev-mcp` findings are useful only as neighboring deployment context, not as the primary target service.
- Pulled upstream `chrome-devtools-mcp` docs and confirmed:
  - page enumeration and tab closing correspond to `list_pages` and `close_page`
  - the server commonly connects through `--browser-url=http://127.0.0.1:9222` or `--wsEndpoint=ws://...`
  - upstream troubleshooting highlights timeout causes around `--autoConnect`, remote-debugging handshake failures, frozen/unloaded tabs, and large tab counts

### SSH host status during chrome-devtools-mcp lookup

- Began targeted inspection of `137.184.23.118`, the SSH MCP host that user says should also host `chrome-devtools-mcp`.
- One targeted SSH probe to that host failed during SSH banner negotiation (`Error reading SSH protocol banner`), so host-side verification is still incomplete.
- User then provided DigitalOcean panel stats for `137.184.23.118` showing approximately `CPU 95.7%` and `Memory 99.5%`.
- This strongly suggests host resource exhaustion as the immediate operational issue, and it matches the observed SSH handshake delays plus browser MCP timeout symptoms.

### Documentation changes made

- Updated `README.md` with deployment notes describing the two-host reality.
- Updated `docs/CHATGPT.md` with a deployment reality-check section so future investigations do not assume both services share one VM or confuse `remote-dev-mcp` with `chrome-devtools-mcp`.

### chrome-devtools-mcp on 137.184.23.118 (post-reboot verification)

- Hostname: `chatgpt-ssh---service`; public IP `137.184.23.118`.
- Target container: `chrome-devtools-mcp-chatgpt-test` (`chrome-devtools-mcp:chatgpt-test`), bound `127.0.0.1:3031->3000`.
- Public entry: `tmp1.zerodotsix.top` via Nginx (`/etc/nginx/sites-available/tmp1-chrome-devtools-mcp`).
- Env file: `/root/chrome-devtools-mcp-chatgpt.env`.
- Startup: `node build/src/bin/chrome-devtools-mcp.js --chatgpt --headless --chrome-arg=--no-sandbox --chrome-arg=--disable-dev-shm-usage`.
- `/health` on `127.0.0.1:3031` returns 200 (`chrome-devtools-mcp` v1.2.0).
- No host listener on `9222`; service uses in-container headless Chrome, not `--browser-url` mode.

### Log and resource findings (2026-06-15)

- Before reboot: DO panel ~CPU 95.7%, memory 99.5%; SSH banner timeout observed.
- After reboot: memory normal (~3.0Gi available); `chrome-devtools-mcp` container ~182MiB, 11 PIDs.
- `docker inspect`: **Memory=0, MemorySwap=0** (no cgroup memory cap); **Restart=unless-stopped**; **ShmSize=64MB**.
- Host **Swap: 0B** — no swap cushion when memory spikes.
- `dmesg` / `journalctl -k` (24h): **no OOM kill lines** after reboot (pre-reboot evidence likely lost).
- Container logs: only startup banners; no request-level or Chrome crash detail in default json-file logs.
- Container `/tmp`: Chrome temp dirs and artifacts (e.g. `modeltest-home-desktop.png`) — suggests session debris can accumulate.
- Same host runs multiple MCP stacks (`ssh-mcp-chatgpt`, `task-mcp`, `cliproxyapi`, etc.) — shared 3.8Gi RAM is tight for browser workloads.

### Likely root cause (ranked)

1. **Unbounded browser MCP memory** on a small VM with no container memory limit and no swap.
2. **Headless Chrome / page context growth** (tabs, traces, screenshots) without periodic recycle.
3. **Host-wide contention** — many containers + nginx + dockerd competing for RAM before failure.
4. Less likely from current logs: misconfigured Nginx or OAuth (health OK after reboot).

### Prevention recommendations (agreed direction)

| Layer | Action |
| ----- | ------ |
| Immediate | Set Docker `--memory` / `--memory-swap` on `chrome-devtools-mcp-chatgpt-test` (e.g. 1–1.5Gi cap). |
| Immediate | Add **swap** on droplet (e.g. 2–4Gi) as safety net, not primary fix. |
| Ops | Cron or systemd timer: **restart browser MCP** daily or on memory threshold. |
| Config | Consider `--isolated` for ephemeral Chrome profile per policy; avoid huge long-lived tab sets. |
| Observability | Enable `--log-file` + `DEBUG` for incidents; alert on host memory > 85%. |
| Architecture | Split `chrome-devtools-mcp` to a **dedicated droplet** or upgrade RAM; do not co-locate heavy browser automation with many other services on 4Gi. |

### Documentation changes made

- Updated `README.md` with deployment notes describing the two-host reality.
- Updated `docs/CHATGPT.md` with deployment reality-check and chrome-devtools-mcp triage notes.
- Added `docs/CHROME-DEVTOOLS-MCP-OPS.md` (browser MCP ops on shared SSH host).

### Unauthorized investigation (2026-06-15 ~09:44 UTC)

- Local probe: `POST /mcp` without bearer → 401 + OAuth metadata (service healthy).
- Nginx `tmp1.zerodotsix.top`: at 08:52 multiple `POST /authorize` returned **403** (failed login secret); at 08:55:41 **302** (OAuth succeeded once).
- Nginx error log: earlier `POST /mcp` **upstream timed out** (06:32–07:20); ~09:36 **upstream closed / reset** on `/mcp` from ChatGPT-like IPs.
- Conclusion: current **Unauthorized** in ChatGPT is likely **expired/invalid OAuth session** or **stale connector** after upstream errors; less likely total service down (`/health` OK). User should re-authorize with login secret `1234567890` and refresh connector.

### Session follow-up (2026-06-15)

- User ended main investigation session; ops docs and prevention checklist recorded above.
- Follow-up: confirmed Chrome MCP OAuth **login secret** lives in `/root/chrome-devtools-mcp-chatgpt.env` as `CHATGPT_MCP_LOGIN_SECRET` (used on `https://tmp1.zerodotsix.top` authorize page). Do not commit real values to git.

### Next step in progress

- User may apply memory limits / swap / restart policy on production; re-test `list_pages` / `close_page` under load after changes.

### Himalaya install (2026-06-18)

- User requested installing **Himalaya** on the machine associated with **飞书 lark-cli** for future agent mailbox access.
- Probed hosts:
  - `137.184.23.118` (`chatgpt-ssh---service`): **no `lark-cli` binary** found on disk; SSH MCP / multiple MCP stacks run here.
  - `139.59.96.181` (`chatgptwork`): **no `lark-cli`** found; `remote-dev-mcp-v2` and workspace containers.
- Installed on **`137.184.23.118`** (assumed co-located agent ops host per user + ssh-mcp deploy target):
  - Binary: `/usr/local/bin/himalaya`
  - Version: `himalaya v1.2.0` (+imap +smtp +maildir …)
  - Config dir prepared: `/root/.config/himalaya/`
  - Script: `deploy/scripts/install-himalaya-remote.py`
- **Not done yet**: per-agent mailbox accounts (`config.toml`), secrets, OAuth/app-passwords, or agent skill/MCP wiring.

### SSH MCP profiles expansion (2026-06-18)

| `target_id` | Label | Host | User | SSH verify |
| ----------- | ----- | ---- | ---- | ---------- |
| `azure-india-chatgpt` | Azure 印度 chatgpt 2h4g | `4.240.102.10` | `hu` | **OK** (`chatgpt`; VM started + VMAccess) |
| `azure-korea-b1slinux` | Azure 韩国 B1sLinux 2h1g | `20.196.72.18` | `hu` | **OK** (`B1sLinux`; VMAccess) |
| `do-157-openmessage` | DO 157.245.217.164 | `157.245.217.164` | `root` | **OK** (`ubuntu-s-1vcpu-2gb-70gb-intel-nyc3-01`) |

- Production: `add-ssh-profile-remote.py` on **137** → `/opt/ssh-mcp-chatgpt-pr8-4d4f/profiles.json`; `/health` → `ssh_profile_count`: **6**.
- Local: `opencode.jsonc` MCP — `ssh-azure-india-chatgpt`, `ssh-azure-korea-b1slinux`, `ssh-do-157-openmessage`.
- Example: `deploy/profiles.example.json` (passwords `REPLACE_ME` in git).
- **Azure CLI:** user authorized `az login`; `chatgpt` **started**, both VMs **`hu` / PLA718125hhc** via VMAccess; SSH verified from local. Template `deploy/scripts/azure-vmaccess-settings.json` (password placeholder in git).
- **Azure billing (user FAQ):** No extra fee for CLI/VMAccess/NSG; **chatgpt** `az vm start` resumes normal **VM compute** billing while running (same as portal Start). Student subscription uses existing credits.
- **Korea ssh-mcp host:** **Not running** (OOM on-VM build; corrupt relay tar). **Plan:** **Docker Hub** push → Korea pull. User **handed off** to another agent — see `docs/workspace/2026-06-18-handoff-korea-ssh-mcp.md`.
- Docs: `docs/SSH-MCP-MULTI-PROFILE.md`, `docs/workspace/2026-06-18-azure-ssh-mcp-profiles.md`.

### SSH MCP vs Singapore host — user clarification (2026-06-18)

- User asked to read **ssh-mcp deployment docs** and compare with a **Singapore** machine; update session docs and **WORKSPACE** from facts.
- **Verified (DO metadata + nginx + public health):**
  - **`ssh-mcp-chatgpt`** → **`137.184.23.118`**, region **`nyc1`**, `https://ssh.zerodotsix.top/health` → **200**, `ssh_profiles_configured: true`; nginx upstream **3039** (not host **3000** for ssh-mcp).
  - **`remote-dev-mcp`** → **`139.59.96.181`**, region **`sgp1` (Singapore)**, `mcp.zerodotsix.top`.
- **Conclusion:** Singapore droplet is **not** the ssh-mcp production host; all repo deploy scripts default to **137 (NYC)**. User’s “新加坡机器” likely refers to **139 / remote-dev-mcp**, which is a **different** VM from current ssh-mcp connector target.
- **lark-cli:** still **not found** on 137 or 139; Himalaya remains on **137 only** until user points to lark-cli’s real host/container.
- **Docs added/updated this session:**
  - New: `docs/DEPLOYMENT-HOSTS.md` (host matrix, re-verify commands, agent guidance).
  - Updated: `README.md`, `docs/CHATGPT.md`, `deploy/scripts/install-himalaya-remote.py` docstring.
  - Probe helpers: `deploy/scripts/probe-host-region.py`, `probe-ssh-mcp-prod.py`, `probe-lark-himalaya.py`, `probe-lark-139.py`.

### ssh-mcp multi-profile on 137 (2026-06-18)

- User asked to inspect **137.184.23.118** ssh-mcp **multiple configuration / profiles** capability.
- **Live production** (`https://ssh.zerodotsix.top/health`): `ssh_profiles_configured=true`, `ssh_profile_count=2`, `default_ssh_profile_id=direct`.
- **Nginx** `ssh.zerodotsix.top` → `127.0.0.1:3039` (not port 3000; `:3000` is another app on the host).
- **Image:** `ssh-mcp-chatgpt:pr8-4d4f`; profiles bind-mount from `/opt/ssh-mcp-chatgpt-pr8-4d4f/profiles.json`.
- **Profile ids (no secrets):**
  - `direct` — label「VPS 直接配置」, SSH `127.0.0.1:22`, **default**
  - `singapore-test` — 现为 **腾讯云硅谷** `49.51.46.235` (`hu`)；旧文档曾写 `168.144.29.187` /「新加坡」易与 DO `139.59.96.181` remote-dev-mcp 混淆
- **Agent API:** `list-profiles`; `exec` / `sudo-exec` optional **`target_id`** (documented in `docs/SSH-MCP-MULTI-PROFILE.md`).
- Scripts: `probe-ssh-profiles-remote.py`, `probe-ssh-profiles-remote2.py`, `probe-profiles-host-json.py`.

### Local `git pull` and session docs (2026-06-18)

- User asked for **remote pull**; agent first updated **137** `/root/ssh-mcp-chatgpt-git` (init + fetch + `master` at `e58cbb4`). User clarified: **only local clone** is needed for pull workflow.
- **Local repo** `E:\hushaokang\Data-code\ssh-mcp-chatgpt`:
  - Was **`behind 7`** on `origin/master`; stashed WIP on `README.md` / `docs/CHATGPT.md`, then **`git pull --ff-only origin master`** → **`e58cbb4`** (PR #8 profile routing merged).
  - Pulled upstream changes include `src/chatgpt-http.ts` profiles, `test/chatgpt-http.profiles.test.ts`, `docs/workspace/2026-06-17-*.md`.
  - **Untracked session docs** (still local-only until user commits): `WORKSPACE.md`, `docs/DEPLOYMENT-HOSTS.md`, `docs/SSH-MCP-MULTI-PROFILE.md`, `docs/CHROME-DEVTOOLS-MCP-OPS.md`, `deploy/scripts/`.
  - **Local edits** retained after stash pop: deployment pointers in `README.md` / `docs/CHATGPT.md` → link to `DEPLOYMENT-HOSTS.md` and multi-profile doc.
- **Docs updated this turn:** `docs/SSH-MCP-MULTI-PROFILE.md` (local `master` now has profile code), `docs/DEPLOYMENT-HOSTS.md` (local vs server tree), `docs/workspace/2026-06-18-local-pull-and-session-docs.md`, this **WORKSPACE** section.
- **Not done:** commit/push session docs; rebuild production container from local `master`; MCP SSH to `127.0.0.1:2222` still **ECONNREFUSED** in this IDE session (local MCP test target offline).

### Session closed (2026-06-18)

- User: **「结束当前对话」** — session ends here; no further agent work unless a new session starts.
- **Agent ops preferences** (user, same session — for future sessions): use **寸止 MCP** for user comms; end only on user say-so; long jobs via **Start-Process** / background; subagents when only **conclusions** needed; model routing (explore → gpt 5.4 mini; UI → gemini 3.1 Pro / sonnet 4.6; backend explore → sonnet 4.6 / gpt 5.4; heavy reasoning → opus 4.6; small tasks → gpt 5.4 mini); **full context before each action**.
- **Handoff:** local `master` at **`e58cbb4`**; session trace in `docs/workspace/2026-06-18-local-pull-and-session-docs.md`.
- **Git push**：origin/master → **ce45718**（本批文档/脚本）；workmust **dc84fc5**（docker.md）。
