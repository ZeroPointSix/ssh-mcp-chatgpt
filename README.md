# SSH MCP for ChatGPT Apps

This repository adapts the original local `ssh-mcp` server into a deployment shape that ChatGPT Apps and Connectors can use directly.

It keeps the existing stdio CLI for local MCP clients and adds a remote HTTP entrypoint for ChatGPT:

- `GET /health` for non-secret readiness checks
- `POST /mcp` for JSON-RPC MCP calls over Streamable HTTP style requests
- `GET /mcp` for SSE endpoint probing
- OAuth 2.1 authorization-code with PKCE for ChatGPT connector login
- Per-tool `securitySchemes` metadata for ChatGPT tool discovery
- Redacted JSONL audit logs with an optional `note` parameter on every tool

> SSH is powerful. Do not paste SSH passwords, private keys, host details, or sudo credentials into ChatGPT prompts. Configure them only on the server through environment variables.

## Tools

| Tool | Description |
| ---- | ----------- |
| `health` | Returns non-secret service status and deployment capabilities. |
| `list-profiles` | Lists read-only, non-secret SSH profile IDs, labels, default state, and sudo availability. |
| `exec` | Executes a shell command on a server-side configured SSH profile. Long commands return a `job_id` after `expire_time_ms` and keep running in the background. |
| `sudo-exec` | Executes a shell command through sudo when enabled globally and for the selected profile, with the same background job behavior. |
| `exec-status` | Polls stdout, stderr, exit status, and progress for a background `job_id`. |
| `exec-cancel` | Requests cancellation for a running background `job_id`; poll `exec-status` until the final status is confirmed. |

SSH targets are intentionally server-side configuration. ChatGPT should not choose arbitrary hosts or receive raw credentials from a user prompt. Use `list-profiles` to discover configured profile IDs and pass `target_id` to `exec` or `sudo-exec`. If a default profile is configured, `target_id` may be omitted; otherwise the tool returns a clear missing-target error. Profiles are read-only at runtime and there are no profile CRUD tools.

`exec` and `sudo-exec` return `status: "completed"` when the command finishes quickly. If the command is still running after `expire_time_ms`, they return `status: "running"` and a `job_id`; call `exec-status` with that ID until the job reaches `completed`, `failed`, `killed`, or `cancelled`. `exec-cancel` and `kill_time_ms` first move a job to `cancelling` or `kill_requested`; keep polling until the SSH channel confirms the final terminal status. Stderr is returned as command output and does not by itself make the tool fail; the remote exit code and signal determine the command status. Long-running stdout/stderr are retained as a bounded tail and report truncation metadata.

## Quick Start: ChatGPT HTTP Mode

1. Install and build:

```bash
npm ci
npm run build
```

2. Create an environment file from `deploy/.env.example` and set real values:

```bash
cp deploy/.env.example .env
```

Minimum production values:

```env
NODE_ENV=production
PORT=3000
OAUTH_BASE_URL=https://ssh-mcp.example.com
OAUTH_LOGIN_SECRET=change-me-to-random-login-secret
SSH_MCP_HTTP_TOKEN=change-me-to-random-api-token
SSH_MCP_HOST=example.com
SSH_MCP_USER=deploy
SSH_MCP_PRIVATE_KEY=-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----
SSH_MCP_DISABLE_SUDO=1
```

For multi-VPS routing, configure `SSH_MCP_PROFILES_FILE` or `SSH_MCP_PROFILES_JSON` instead of the single-target `SSH_MCP_HOST` fallback. `exec`, `sudo-exec`, background job status, and audit logs all report the resolved `target_id`.

3. Start the HTTP server:

```bash
npm run start:http
```

4. Verify locally or behind your HTTPS reverse proxy:

```bash
curl https://ssh-mcp.example.com/health
curl -i https://ssh-mcp.example.com/.well-known/oauth-protected-resource
```

The ChatGPT connector URL is:

```text
https://ssh-mcp.example.com/mcp
```

## ChatGPT Connector Setup

Use the detailed setup guide in [docs/CHATGPT.md](docs/CHATGPT.md).

Production **ssh-mcp-chatgpt** public origin is **`https://ssh.zerodotsix.top`** on Azure Korea **`20.196.72.18`** (DNS cutover 2026-06-18). Legacy NYC **`137.184.23.118`** is standby; **not** Singapore (`139.59.96.181` / `mcp.zerodotsix.top`, remote-dev-mcp). See [docs/DEPLOYMENT-HOSTS.md](docs/DEPLOYMENT-HOSTS.md).

High-level flow:

1. Deploy this service behind a public HTTPS URL.
2. Set `OAUTH_BASE_URL` to that public origin.
3. Set a strong `OAUTH_LOGIN_SECRET`.
4. Open ChatGPT Settings -> Apps & Connectors -> Create.
5. Use `https://<your-domain>/mcp` as the connector URL.
6. Select OAuth and use the discovery endpoints exposed by this service.
7. During first authorization, enter the server-side login secret on the `/authorize` page.

## Docker

```bash
docker build -t ssh-mcp-chatgpt .
docker run --rm -p 3000:3000 --env-file .env ssh-mcp-chatgpt
```

For production, put a reverse proxy such as Nginx, Caddy, or a managed load balancer in front of the container and terminate HTTPS there. ChatGPT should connect to the HTTPS `/mcp` URL, not a raw local port.

## Existing Stdio Mode

The original local MCP usage still works:

```bash
npx -y ssh-mcp -- --host=1.2.3.4 --port=22 --user=root --password=pass
```

Example MCP client config:

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "npx",
      "args": [
        "ssh-mcp",
        "-y",
        "--",
        "--host=1.2.3.4",
        "--port=22",
        "--user=root",
        "--password=pass",
        "--timeout=30000",
        "--maxChars=none"
      ]
    }
  }
}
```

## Environment Variables

| Variable | Purpose |
| -------- | ------- |
| `PORT` | HTTP listen port, default `3000`. |
| `OAUTH_BASE_URL` | Public HTTPS origin for OAuth discovery and redirects. |
| `OAUTH_LOGIN_SECRET` | Human-entered secret required on `/authorize`. |
| `SSH_MCP_HTTP_TOKEN` / `MCP_TOKEN` | Optional static bearer token for non-ChatGPT API clients. |
| `ALLOWED_ORIGINS` | Comma-separated browser origins allowed for `/mcp`. |
| `SSH_MCP_PROFILES_FILE` | Optional path to a JSON file with multiple server-side SSH profiles. Preferred for multi-target deployments. |
| `SSH_MCP_PROFILES_JSON` | Optional inline JSON profile configuration. Used only when `SSH_MCP_PROFILES_FILE` is not set. |
| `SSH_MCP_DEFAULT_PROFILE` / `SSH_MCP_DEFAULT_PROFILE_ID` | Optional default profile ID used when a tool call omits `target_id`. If unset and no profile is marked default, callers must pass `target_id`. |
| `SSH_MCP_HOST` / `SSH_HOST` | Legacy single-target fallback host, used only when no profile config is provided. |
| `SSH_MCP_PORT` / `SSH_PORT` | Legacy single-target fallback port, default `22`. |
| `SSH_MCP_USER` / `SSH_USER` | Legacy single-target fallback username. |
| `SSH_MCP_PASSWORD` / `SSH_PASSWORD` | Optional SSH password. Prefer key auth in production. |
| `SSH_MCP_PRIVATE_KEY` / `SSH_PRIVATE_KEY` | Optional private key content. Escaped `\n` sequences are supported. |
| `SSH_MCP_KEY` / `SSH_KEY` | Optional path to a mounted private key file. |
| `SSH_MCP_DISABLE_SUDO` | Set `1` to hide `sudo-exec`. Recommended unless needed. |
| `SSH_MCP_SUDO_PASSWORD` | Optional sudo password used only server-side. |
| `SSH_MCP_MAX_CHARS` | Maximum command length. Defaults to `none`; set a positive integer to enforce a deployment limit. |
| `SSH_MCP_EXEC_EXPIRE_TIME_MS` | HTTP `exec` wait window before returning a background `job_id`, default `55000`. |
| `SSH_MCP_EXEC_KILL_TIME_MS` | Optional hard deadline for killing background commands. Defaults to `none`; set a positive millisecond value to enforce. |
| `SSH_MCP_EXEC_OUTPUT_MAX_CHARS` | Maximum retained stdout and stderr tail per background job, default `200000`. Set `none` to disable truncation. |
| `SSH_MCP_DATA_DIR` | Data directory for redacted audit logs. |
| `SSH_MCP_TOOL_CALL_LOG_ENABLED` | Set `0` to disable audit logging. |
| `SSH_MCP_TOOL_CALL_NOTE_REQUIRED` | Set `1` to require `note` on tool calls. |

### SSH Profiles

Profile JSON may be an object with `profiles` and an optional `default`, or an array of profiles. Object maps are also accepted. Each profile supports `id`, `label` or `name`, `host`, `port`, `user` or `username`, `password`, `private_key`, `private_key_path`, `sudo_enabled`, and `default`. Hostnames and credentials never appear in `list-profiles`, `health`, tool descriptions, or audit arguments.

If `SSH_MCP_PROFILES_FILE` or `SSH_MCP_PROFILES_JSON` is set, the profile config must contain at least one profile. Empty profile configs such as `[]`, `{ "profiles": [] }`, or `{ "profiles": {} }` fail startup instead of silently falling back to the legacy single-target env.

Example `profiles.json`:

```json
{
  "default": "dev",
  "profiles": [
    {
      "id": "dev",
      "label": "Development VPS",
      "host": "dev.example.com",
      "user": "deploy",
      "private_key_path": "/run/secrets/dev_key",
      "sudo_enabled": false
    },
    {
      "id": "ops",
      "label": "Operations VPS",
      "host": "ops.example.com",
      "user": "deploy",
      "password": "change-me-in-secret-store",
      "sudo_enabled": true
    }
  ]
}
```

`SSH_MCP_DISABLE_SUDO=1` is still a global kill switch: it hides `sudo-exec` even when a profile has `sudo_enabled: true`. When the global switch is off, `sudo-exec` still requires the resolved profile to opt in with `sudo_enabled: true`.

## Development

```bash
npm ci
npm run build
npm test
npm run dev:http
```

HTTP smoke request:

```bash
curl -sS http://127.0.0.1:3000/health
curl -sS \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  http://127.0.0.1:3000/mcp
```

## Safety Notes

- Keep SSH credentials in server environment variables or mounted secret files.
- Prefer a dedicated low-privilege SSH user and disable `sudo-exec` by default.
- Use server-side profiles for multi-VPS routing; do not expose profile CRUD or raw host details to ChatGPT.
- Keep `SSH_MCP_MAX_CHARS`, `SSH_MCP_EXEC_KILL_TIME_MS`, and `SSH_MCP_EXEC_OUTPUT_MAX_CHARS` bounded for ChatGPT-facing deployments when your environment needs stricter guardrails.
- Review redacted audit logs in `SSH_MCP_DATA_DIR/tool-calls/` when investigating tool use.
- Use OAuth for ChatGPT connector setup. Static bearer tokens are best reserved for direct API clients and operations.

## Operations

- ChatGPT OAuth and Korea production: [docs/CHATGPT.md](./docs/CHATGPT.md)
- Docker `--env-file` vs `restart` (agent runbook): [docs/DOCKER-ENV-FILE-RECREATE.md](./docs/DOCKER-ENV-FILE-RECREATE.md)

## References

- OpenAI Apps SDK: build an MCP server for ChatGPT Apps
- OpenAI Apps SDK: authentication and OAuth metadata
- OpenAI Apps SDK: security and privacy guidance
- Model Context Protocol SDK

## License

MIT. This fork preserves the original `ssh-mcp` stdio behavior while adding ChatGPT-compatible remote connector support.
