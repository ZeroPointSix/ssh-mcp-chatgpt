# Docker `--env-file` 与容器重建（给 Agent / 运维的固定话术）

把下面 **「可复制段落」** 交给其它 Agent 或写在 runbook 里，用于避免「改完 env / 数据目录后只 `docker restart`，线上认证或配置仍像没改」一类问题。适用于任何用 **`docker run --env-file`** 启动、且依赖环境变量或挂载路径的服务（MCP、OAuth、API、worker 等），不限于本仓库。

---

## 可复制段落（泛化）

> **Docker 环境变量与数据路径变更纪律**
>
> 若容器是用 `docker run --env-file <file>`（或等价 compose 的 `env_file`）创建的，则 **`docker restart` / `docker stop` + `docker start` 不会重新读取 env 文件**，进程内仍是**创建容器当时**注入的环境变量。宿主机上改了 env 文件、修正了变量名、或改了 `DATA_DIR` / OAuth 密钥 / API token 等，**必须**用 **`docker rm`（或 `docker compose down`）+ 用同一套参数重新 `docker run`（或 `docker compose up -d`）** 新建容器，而不是只 restart。
>
> 变更后验收应做三件事：（1）**`docker exec <name> env`**（或 `printenv`）核对关键变量名与值是否**非空**且与文档一致（注意应用只认的变量名，错一个前缀就等于未配置）；（2）核对 **bind mount 路径** 与进程内 **`DATA_DIR`（或同类）** 指向**同一已挂载目录**，避免「文件写在宿主机 A、进程读容器内未挂载的 B」；（3）用**业务探针**验证（例如 `/health` 里的功能开关、授权端点是否 500、是否出现预期 UI），不要仅凭 discovery / 健康检查 200 就认为 OAuth 或密钥已生效。
>
> 仅当变更**不涉及** env、挂载、镜像、端口、网络模式时，restart 才足够（例如纯进程崩溃、OOM 后拉起同一实例）。凡脚本或文档写了「改 env / oauth-clients / profiles / 默认 profile」，应优先查仓库里的 **recreate** 脚本或手写 **rm + run**，并在 WORKSPACE 记录「重建原因 + 验收结果」。

---

## 本仓库（ssh-mcp-chatgpt 韩国生产）落地

| 项 | 值 |
| --- | --- |
| 容器名 | `ssh-mcp-chatgpt-korea` |
| 宿主机 env | `/opt/ssh-mcp-chatgpt-korea/env` |
| 数据目录（须挂载且与 `SSH_MCP_DATA_DIR` 一致） | `/opt/ssh-mcp-chatgpt-korea/data`（`oauth-clients.json` 等） |
| OAuth 必需变量 | `OAUTH_BASE_URL`、`OAUTH_LOGIN_SECRET`（**不要**写成 `OAUTH_OAUTH_LOGIN_SECRET` 等错名） |
| 重建脚本 | `deploy/scripts/recreate-korea-ssh-mcp-container.py` |
| OAuth + 数据目录一并修复 | `deploy/scripts/fix-korea-oauth-data-path.py` |
| 探针 | `deploy/scripts/diag-korea-oauth-full.py`、`probe-korea-oauth-client.py` |

**验收（公网）：**

```bash
curl -fsS https://ssh.zerodotsix.top/health   # 期望 oauth_enabled: true
# ChatGPT 带参 /authorize 期望登录表单 name="secret"，而非 500 OAuth is not configured
```

ChatGPT 连接器细节见 [CHATGPT.md](./CHATGPT.md)。

---

## 与其它文档的关系

- [CHATGPT.md](./CHATGPT.md) — OAuth 流程、帮助页 vs 500、故障表  
- [DEPLOYMENT-HOSTS.md](./DEPLOYMENT-HOSTS.md) — 韩国机路径与容器名  
- [MCP-PUBLIC-SERVICES.md](./MCP-PUBLIC-SERVICES.md) — 四域 MCP 独立 OAuth，勿混用 env/client  
- **workmust** 外部 Agent 同路径副本：[workmust/docs/external-agents/docker.md](https://github.com/ZeroPointSix/workmust/blob/master/docs/external-agents/docker.md)（与 `Tools.md` 并列，供 ChatGPT 远程读）
