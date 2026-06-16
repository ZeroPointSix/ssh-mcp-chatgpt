# ChatGPT Apps / Connectors Guide

This project exposes a ChatGPT-compatible remote MCP endpoint for one or more server-side configured SSH targets.

## Architecture

```text
ChatGPT
  -> HTTPS /mcp
  -> ssh-mcp-chatgpt HTTP adapter
  -> SSH profile configured by server environment
```

The ChatGPT-facing service does not ask for SSH hostnames, passwords, private keys, or sudo passwords at tool-call time. Those values are deployment secrets. Multi-VPS routing is handled by read-only server-side profiles: ChatGPT can call `list-profiles` to see safe profile IDs and labels, then pass `target_id` to `exec` or `sudo-exec`.

## Required Public Endpoints

| Endpoint | Purpose |
| -------- | ------- |
| `GET /health` | Readiness check with non-secret capabilities. |
| `POST /mcp` | MCP JSON-RPC endpoint used by ChatGPT. |
| `GET /mcp` | SSE endpoint probe. |
| `GET /.well-known/oauth-protected-resource` | OAuth protected resource metadata. |
| `GET /.well-known/oauth-authorization-server` | OAuth authorization server metadata. |
| `POST /register` | Dynamic client registration for ChatGPT. |
| `GET/POST /authorize` | Login-secret authorization page. |
| `POST /token` | PKCE token exchange. |

## Server Environment

Start from `deploy/.env.example`.

Minimum ChatGPT production configuration:

```env
NODE_ENV=production
PORT=3000
OAUTH_BASE_URL=https://ssh-mcp.example.com
OAUTH_LOGIN_SECRET=change-me-to-random-login-secret
SSH_MCP_HTTP_TOKEN=change-me-to-random-api-token
ALLOWED_ORIGINS=https://chatgpt.com,https://chat.openai.com
SSH_MCP_HOST=example.com
SSH_MCP_PORT=22
SSH_MCP_USER=deploy
SSH_MCP_PRIVATE_KEY=-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----
SSH_MCP_DISABLE_SUDO=1
SSH_MCP_DATA_DIR=/srv/ssh-mcp-chatgpt/data
SSH_MCP_TOOL_CALL_LOG_ENABLED=1
```

For multi-target deployments, replace the single-target `SSH_MCP_HOST` settings with a server-side profile file or inline profile JSON:

```env
SSH_MCP_PROFILES_FILE=/run/secrets/ssh-mcp-profiles.json
SSH_MCP_DEFAULT_PROFILE=dev
```

Use a dedicated, low-privilege SSH user for each profile. Enable `sudo-exec` only for deployments and profiles that truly need it. `SSH_MCP_DISABLE_SUDO=1` remains a global kill switch even when a profile has `sudo_enabled: true`.

## Deploy

```bash
npm ci
npm run build
npm run start:http
```

Docker:

```bash
docker build -t ssh-mcp-chatgpt .
docker run -d --restart unless-stopped --name ssh-mcp-chatgpt \
  --env-file /path/to/ssh-mcp-chatgpt.env \
  -v /srv/ssh-mcp-chatgpt/data:/srv/ssh-mcp-chatgpt/data \
  -p 127.0.0.1:3000:3000 \
  ssh-mcp-chatgpt
```

Place Nginx, Caddy, or a managed HTTPS load balancer in front of the container. ChatGPT must use the public HTTPS origin in `OAUTH_BASE_URL`.

## ChatGPT Setup

1. Open ChatGPT.
2. Go to Settings -> Apps & Connectors.
3. Enable Developer Mode if the Create button is not visible.
4. Create a new connector.
5. Connector URL: `https://<your-domain>/mcp`.
6. Choose OAuth authentication.
7. Use dynamic registration when available, or set these OAuth values manually:

| Field | Value |
| ----- | ----- |
| Authorization URL | `https://<your-domain>/authorize` |
| Token URL | `https://<your-domain>/token` |
| Registration URL | `https://<your-domain>/register` |
| Authorization server | `https://<your-domain>` |
| Resource | `https://<your-domain>` |
| Token endpoint auth method | `none` |
| Scopes | `mcp` |

8. Authorize the connector. The `/authorize` page asks for `OAUTH_LOGIN_SECRET`.
9. Refresh the connector metadata after deploying tool description changes.

## Verification

Health:

```bash
curl -sS https://<your-domain>/health
```

OAuth discovery:

```bash
curl -sS https://<your-domain>/.well-known/oauth-protected-resource
curl -sS https://<your-domain>/.well-known/oauth-authorization-server
```

MCP initialize:

```bash
curl -sS https://<your-domain>/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

Tool list:

```bash
curl -sS https://<your-domain>/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

Direct bearer-token call for operations or non-ChatGPT clients:

```bash
curl -sS https://<your-domain>/mcp \
  -H 'Authorization: Bearer <SSH_MCP_HTTP_TOKEN>' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"health","arguments":{"note":"smoke test"}}}'
```

## Operational Rules for Agents

- Use `note` to describe why each command is being run.
- Do not ask users to paste SSH credentials into ChatGPT.
- Call `list-profiles` before selecting a non-default target. It returns only profile IDs, labels, default state, and sudo availability.
- Pass `target_id` to `exec` and `sudo-exec` when choosing a non-default profile. If the deployment has no default profile, `target_id` is required.
- Prefer short, inspectable commands.
- Use `exec` by default.
- If `exec` returns `status: "running"`, keep the returned `job_id` and poll with `exec-status` until it reaches `completed`, `failed`, `killed`, or `cancelled`. If the status is `cancelling` or `kill_requested`, the stop was requested but the SSH channel has not yet confirmed the final terminal status.
- Use `exec-cancel` when a still-running background job should be stopped before its configured `kill_time_ms`, then keep polling with `exec-status`.
- Large stdout/stderr are retained as a bounded tail controlled by `SSH_MCP_EXEC_OUTPUT_MAX_CHARS`; check `stdout_truncated` and `stderr_truncated` in tool output.
- Use `sudo-exec` only when the deployment has explicitly enabled it, the selected profile allows sudo, and the task requires privilege.
- If a command might be destructive, ask the user for confirmation before running it.

## Troubleshooting

| Symptom | Check |
| ------- | ----- |
| ChatGPT cannot connect | Confirm `https://<domain>/health` is reachable from the public Internet. |
| OAuth discovery fails | Confirm both `.well-known` endpoints return JSON and `OAUTH_BASE_URL` has no trailing slash. |
| Tool calls return 401 | Reauthorize the connector or check `OAUTH_LOGIN_SECRET` and token exchange. |
| Tool list works but calls fail | Check SSH target env vars and audit logs under `SSH_MCP_DATA_DIR/tool-calls/`. |
| `target_id is required` | Configure `SSH_MCP_DEFAULT_PROFILE`, mark exactly one profile as `default`, or pass `target_id` from `list-profiles`. |
| `Unknown SSH target_id` | Refresh connector metadata if needed, call `list-profiles`, and use one of the returned profile IDs. |
| Long deployment still running | Use `exec-status` with the returned `job_id`; stderr is output, while exit code and signal determine failure. |
| Sudo tool missing | `SSH_MCP_DISABLE_SUDO=1` hides `sudo-exec`; this is the recommended default. |
| Sudo rejected for one profile | The selected profile must set `sudo_enabled: true`; the global sudo switch must also allow sudo. |
| Accept header error | MCP POST requests must include `Accept: application/json, text/event-stream`. |

## Scope

This connector is command/tool only. It does not currently provide a ChatGPT iframe UI resource. If a visual SSH session, profile selector, or log viewer is needed later, add an Apps SDK UI resource and set the relevant UI metadata on the tool descriptor.
