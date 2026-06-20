# Deployment hosts (operational reality)

This document records **which DigitalOcean droplets run which public MCP services**. It is maintained from deploy scripts and live probes, not from assumptions about “Singapore vs NYC”.

Last verified: **2026-06-18** (DO metadata `region`, nginx `server_name`, public `/health`).

## Local clone vs remote server tree

| Location | Role |
| -------- | ---- |
| **Local** `E:\hushaokang\Data-code\ssh-mcp-chatgpt` (or your dev clone) | **Primary** — `git pull origin master`, run tests, edit docs tracked in git |
| **137** `/root/ssh-mcp-chatgpt-git` | **Deploy extract dir** — updated by `deploy/scripts/*.py` tar uploads; may lack `.git` or drift from GitHub; **not** the user’s requested “pull” target when they mean local only |

Production connector behavior is defined by the **running image** on 137 (today often **pr8** on port **3039**), not by whether the server directory has a clean `git pull`.

## Summary

| Public domain | Service | IPv4 | DO region | Hostname | Same machine as ssh-mcp? |
| ------------- | ------- | ---- | --------- | -------- | ------------------------ |
| `https://ssh.zerodotsix.top` | **ssh-mcp-chatgpt** (production) | **`20.196.72.18`** (DNS A, 2026-06-18) | **Azure Korea** | `B1sLinux` | **Yes** — migrated from NYC `137.184.23.118`; origin HTTP :80 → OpenResty → `:3039` |
| `https://tmp1.zerodotsix.top` | chrome-devtools-mcp (test) | `137.184.23.118` (`do-nyc-001`) | **nyc1** | `chatgpt-ssh---service` | `:3031` → browser MCP |
| `https://tmp2.zerodotsix.top` | memory-mcp-chatgpt (test) | `137.184.23.118` (`do-nyc-001`) | **nyc1** | same | `:3032` → memory MCP |
| `https://mcp.zerodotsix.top` | **remote-dev-mcp** | `139.59.96.181` | **sgp1** (Singapore) | `chatgptwork` | **No** — different droplet |

**Important:** Production ssh-mcp is **`azure-kr-001`** (`20.196.72.18`). Legacy tarball scripts may still target **`do-nyc-001`** (`137.184.23.118`). **`do-sgp-001`** (`139.59.96.181`) is remote-dev-mcp only. Host ids: [HOST-NAMING.md](./HOST-NAMING.md).

## ssh-mcp-chatgpt on 20.196.72.18 (Azure Korea, current public origin)

- **Connector URL:** `https://ssh.zerodotsix.top/mcp`
- **Health:** `GET https://ssh.zerodotsix.top/health` → `200`, `oauth_enabled: true`, `ssh_profile_count: 9` (2026-06-19, +`do-nyc-001` + `server_id` naming)
- **TLS:** Let's Encrypt on VM (gray cloud); HTTP 301 → HTTPS
- **OAuth:** Bare `GET /authorize` without ChatGPT query → 200 help page (expected); see [CHATGPT.md](./CHATGPT.md)
- **OpenResty (1Panel):** `/opt/1panel/www/conf.d/ssh.zerodotsix.top.conf` → `proxy_pass http://127.0.0.1:3039`
- **Container:** `ssh-mcp-chatgpt-korea`, image `guangshanshui/ssh-mcp-chatgpt:pr8-4d4f`, `--network host`, env `/opt/ssh-mcp-chatgpt-korea/env`
- **OAuth / data:** `SSH_MCP_DATA_DIR` = **`/opt/ssh-mcp-chatgpt-korea/data`**（bind mount 同路径）；`oauth-clients.json` 须在此目录。改 env 或 data 路径后 **重建容器**（`recreate-korea-ssh-mcp-container.py` / `fix-korea-oauth-data-path.py`），**不要**只 `docker restart` — 见 [DOCKER-ENV-FILE-RECREATE.md](./DOCKER-ENV-FILE-RECREATE.md)
- **Profiles file:** `/opt/ssh-mcp-chatgpt-korea/profiles.json` — **9** `server_id`s (`azure-kr-001` … `do-nyc-001`); default `azure-kr-001` = `hu@127.0.0.1` on Korea
- **Setup scripts:** `setup-korea-ssh-zerodotsix.py`, `finish-korea-ssl-ssh-zerodotsix.py`, `sync-korea-oauth-clients.py` (OAuth dynamic clients in `oauth-clients.json`)
- **ChatGPT:** Connector OAuth verified **2026-06-18** after Korea cutover; **2026-06-20** 修复 restart 导致 env 丢失后 `oauth_enabled: true` 复验

## do-nyc-001 — `137.184.23.118` (legacy NYC, standby)

- **Was** public origin for `ssh.zerodotsix.top` until DNS cutover 2026-06-18
- **Production upstream (if still running):** nginx `proxy_pass http://127.0.0.1:3039` (pr8 **multi-profile** build `ssh-mcp-chatgpt:pr8-4d4f`)
- **Profiles file:** `/opt/ssh-mcp-chatgpt-pr8-4d4f/profiles.json` — legacy list may still show old IPs; live Korea file: `singapore-test` → **腾讯云硅谷** `49.51.46.235` (`hu`). See [SSH-MCP-MULTI-PROFILE.md](./SSH-MCP-MULTI-PROFILE.md).
- **Legacy env file** `/root/ssh-mcp-chatgpt.env` still has single-target `SSH_MCP_HOST=127.0.0.1`; **live connector** uses profile routing, not that file alone
- **Port 3000** on this host is **not** ssh-mcp (another service); do not use `:3000` for ssh-mcp health checks
- **Also on this host:** chrome-devtools, memory-mcp, task-mcp, etc. — ~3.8Gi RAM (see [CHROME-DEVTOOLS-MCP-OPS.md](./CHROME-DEVTOOLS-MCP-OPS.md))

## remote-dev-mcp on 139.59.96.181 (Singapore)

- **Public:** `mcp.zerodotsix.top`
- **Role:** `remote-dev-mcp-v2` and ephemeral `rdmcp-ws-*` workspace containers
- **Not** the target of this repo’s `deploy-do-server.py` / `deploy-master-prod.py` (those use 137)

## lark-cli and Himalaya (2026-06-18)

- **`lark-cli`:** Not found on either `137.184.23.118` or `139.59.96.181` (no binary under `/usr/local/bin`, `/root/.local/bin`, or shallow `find` on `/root`, `/opt`).
- **Himalaya:** Installed on **`137.184.23.118`** only: `/usr/local/bin/himalaya` **v1.2.0**, config dir `/root/.config/himalaya/` (accounts not configured yet).
- If **飞书 lark-cli** runs on a **third host** or inside a **container**, record that host here when known; do not assume Singapore = lark-cli without verification.

## How to re-verify

```bash
# From a machine with SSH to the droplets:
python deploy/scripts/probe-host-region.py
python deploy/scripts/probe-ssh-mcp-prod.py   # 137 only

# Public (no SSH):
curl -fsS https://ssh.zerodotsix.top/health
curl -fsS https://mcp.zerodotsix.top/health   # remote-dev-mcp host
```

## Agent guidance

- When the user says “SSH MCP 公网/连接器”, use **`ssh.zerodotsix.top`** → origin **`20.196.72.18` (Korea)**. Legacy deploy scripts may still default **`137.184.23.118` (NYC)** for tarball deploys—not Singapore.
- When investigating **browser MCP** timeouts on the shared SSH host, see [CHROME-DEVTOOLS-MCP-OPS.md](./CHROME-DEVTOOLS-MCP-OPS.md).
- **ssh / tmp1 / tmp2 / mcp** 四公网入口差异：[MCP-PUBLIC-SERVICES.md](./MCP-PUBLIC-SERVICES.md).
- Do **not** conflate `remote-dev-mcp` (139, SGP) with `ssh-mcp-chatgpt` (137, NYC).