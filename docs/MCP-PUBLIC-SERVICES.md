# 公网 MCP 四服务对照（验证用）

实测时间：**2026-06-19**（公网 `GET /health` + `do-nyc-001` 本机端口）。

用户常说的四个入口：**ssh**、**tmp1**、**tmp2**，以及 **mcp**（remote-dev）。彼此**不是同一套代码、不是同一台宿主机**。

## 总表

| 公网域名 | 服务名（health `name`） | 版本（实测） | 宿主机 `server_id` | 区域 | 角色 |
| -------- | ---------------------- | ------------ | ------------------ | ---- | ---- |
| `https://ssh.zerodotsix.top` | **ssh-mcp-chatgpt** | 1.5.0-chatgpt.0 | **azure-kr-001** `20.196.72.18` | Azure 韩国 | **生产**：多 VPS SSH，`list-profiles` + `exec` / `sudo-exec`，9 路 `server_id` |
| `https://tmp1.zerodotsix.top` | **chrome-devtools-mcp** | 1.2.0 | **do-nyc-001** `137.184.23.118` | DO NYC | **测试**：无头 Chrome，页面/截图/DevTools 类工具 |
| `https://tmp2.zerodotsix.top` | **memory-mcp-chatgpt** | 0.6.4-chatgpt.0 | **do-nyc-001** `137.184.23.118` | DO NYC | **测试**：记忆/知识库 MCP（非 SSH、非浏览器） |
| `https://mcp.zerodotsix.top` | remote-dev-mcp（health 无统一 name） | 0.1.37 | **do-sgp-001** `139.59.96.181` | DO 新加坡 | **另一项目**：远程开发/工作区容器，**不是** ssh-mcp |

## ChatGPT 连接器「链接方式」（2026-06-19 公网探测）

四个入口在 ChatGPT **应用与连接器**里填的 **MCP URL 路径都是 `/mcp`**，但 **必须填对应子域名的完整 HTTPS 基址**；填错域名会连到另一套进程与另一套 OAuth。

| 公网域名 | ChatGPT 连接器 URL | OAuth `issuer`（`/.well-known/oauth-authorization-server`） | `authorize` / `token` 是否同域 |
| -------- | ------------------ | -------------------------------------------------------- | ------------------------------ |
| ssh | `https://ssh.zerodotsix.top/mcp` | `https://ssh.zerodotsix.top` | **是**（同 ssh 域） |
| tmp1 | `https://tmp1.zerodotsix.top/mcp` | `https://tmp1.zerodotsix.top` | **是**（同 tmp1 域） |
| tmp2 | `https://tmp2.zerodotsix.top/mcp` | `https://tmp2.zerodotsix.top` | **是**（同 tmp2 域） |
| mcp | `https://mcp.zerodotsix.top/mcp` | **`https://sandbox.zerodotsix.top`**（元数据如此；非 ssh/tmp 模式） | **否**：授权页在 **sandbox** 域，经 Nginx 反代到本机 MCP |

未带 Bearer 访问 `GET/POST /mcp` 时：tmp1/tmp2/mcp 返回 **401 Unauthorized**（预期）；ssh 对裸 `GET /mcp` 可能 **405**（方法限制），带 ChatGPT OAuth 后走 JSON-RPC/SSE。

**不共享**：`oauth-clients.json`、登录密钥、`OAUTH_BASE_URL`、宿主机数据目录；ssh 的 `SSH_MCP_DATA_DIR` 与挂载一致问题 **仅影响 ssh**。

## 和「验证」相关的差异

| 维度 | ssh-mcp | tmp1 Chrome | tmp2 memory | mcp remote-dev |
| ---- | ------- | ----------- | ----------- | -------------- |
| **Connector URL** | `https://ssh.zerodotsix.top/mcp` | `https://tmp1.zerodotsix.top/mcp` | `https://tmp2.zerodotsix.top/mcp` | `https://mcp.zerodotsix.top/mcp` |
| **OAuth** | 韩国 `/opt/ssh-mcp-chatgpt-korea/data/oauth-clients.json` + 登录密钥 | 独立（137 `CHATGPT_MCP_LOGIN_SECRET` 等） | 独立（137，容器 `memory-mcp-tmp2`） | 独立（139；issuer 对外为 **sandbox**） |
| **本仓库** | **是**（本 git） | 否（ZeroPointSix/chrome-devtools-mcp） | 否（memory-mcp 系） | 否（remote-dev-mcp） |
| **典型工具** | `exec`, `list-profiles`, `exec-status`… | `list_pages`, `navigate`, 截图等 | 记忆检索/写入类（以实现为准） | 工作区/开发流（以实现为准） |
| **多机 SSH** | **有**（`target_id` = `server_id`） | 无 | 无 | 无 |
| **公网 health（2026-06-19）** | 200，`oauth_enabled: true`，`ssh_profile_count: 9` | 200，`oauth_enabled: true` | 200，`oauth_enabled: true` | 200 |

## 宿主机与端口（137 上共存）

`do-nyc-001` 上多容器**抢同一台小机内存**，彼此独立进程：

| 本地端口 | 容器（示例名） | 公网 |
| -------- | -------------- | ---- |
| `127.0.0.1:3031` | `chrome-devtools-mcp-chatgpt-test` | **tmp1** Nginx |
| `127.0.0.1:3032` | `memory-mcp-tmp2` | **tmp2** Nginx |
| `*:3039` | `ssh-mcp-chatgpt` pr8（**legacy 本机栈**） | 曾反代 **ssh**；**现 DNS 已指韩国**，137 上 3039 仅本机/遗留 |

韩国 **azure-kr-001**：`127.0.0.1:3039` → 公网 **ssh**（OpenResty）。

## 易混点

1. **ssh 公网已不在 137**：连接器只认 `ssh.zerodotsix.top` → **韩国**；137 的 3039 不是当前公网源站。
2. **tmp1 ≠ 新加坡**：tmp1 在 **NYC 137**；新加坡 **139** 是 **mcp.zerodotsix.top**（remote-dev）。
3. **四个连接器要各建各授权**：OAuth、登录密钥、故障排查**分开**；ssh 的 `oauth-clients.json` 路径问题（`SSH_MCP_DATA_DIR` 与挂载一致）**只影响 ssh**。
5. **mcp 连接器 OAuth 元数据指向 sandbox**：`mcp.zerodotsix.top` 的 well-known 里 `issuer` / `authorization_endpoint` 为 `sandbox.zerodotsix.top`；在 ChatGPT 里仍填 **`https://mcp.zerodotsix.top/mcp`**，授权跳转由该部署配置决定，勿与 ssh/tmp1/tmp2 混用 client 或密钥。
4. **tmp1/tmp2 与 ssh 同时挂掉**：优先查 **137 内存/负载**（历史上有 99% 内存、nginx upstream 超时）。

## 快速复测

```bash
python deploy/scripts/probe-four-mcp-public.py
python deploy/scripts/probe-137-mcp-nginx.py   # 需 SSH 到 do-nyc-001
curl -fsS https://ssh.zerodotsix.top/health
curl -fsS https://tmp1.zerodotsix.top/health
curl -fsS https://tmp2.zerodotsix.top/health
curl -fsS https://mcp.zerodotsix.top/health
```

## 相关文档

- [DEPLOYMENT-HOSTS.md](./DEPLOYMENT-HOSTS.md)
- [CHATGPT.md](./CHATGPT.md) — ssh OAuth
- [CHROME-DEVTOOLS-MCP-OPS.md](./CHROME-DEVTOOLS-MCP-OPS.md) — tmp1
- [HOST-NAMING.md](./HOST-NAMING.md) — `server_id`