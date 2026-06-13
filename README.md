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
| `exec` | Executes a bounded shell command on the server-side configured SSH target. |
| `sudo-exec` | Executes a bounded shell command through sudo when enabled server-side. |

The SSH target is intentionally server-side configuration. ChatGPT should not choose arbitrary hosts or receive raw credentials from a user prompt.

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
        "--maxChars=1000"
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
| `SSH_MCP_HOST` / `SSH_HOST` | SSH target host. |
| `SSH_MCP_PORT` / `SSH_PORT` | SSH target port, default `22`. |
| `SSH_MCP_USER` / `SSH_USER` | SSH username. |
| `SSH_MCP_PASSWORD` / `SSH_PASSWORD` | Optional SSH password. Prefer key auth in production. |
| `SSH_MCP_PRIVATE_KEY` / `SSH_PRIVATE_KEY` | Optional private key content. Escaped `\n` sequences are supported. |
| `SSH_MCP_KEY` / `SSH_KEY` | Optional path to a mounted private key file. |
| `SSH_MCP_DISABLE_SUDO` | Set `1` to hide `sudo-exec`. Recommended unless needed. |
| `SSH_MCP_SUDO_PASSWORD` | Optional sudo password used only server-side. |
| `SSH_MCP_MAX_CHARS` | Maximum command length. Use `none` or `0` to disable. |
| `SSH_MCP_DATA_DIR` | Data directory for redacted audit logs. |
| `SSH_MCP_TOOL_CALL_LOG_ENABLED` | Set `0` to disable audit logging. |
| `SSH_MCP_TOOL_CALL_NOTE_REQUIRED` | Set `1` to require `note` on tool calls. |

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
- Keep `SSH_MCP_MAX_CHARS` bounded for ChatGPT-facing deployments.
- Review redacted audit logs in `SSH_MCP_DATA_DIR/tool-calls/` when investigating tool use.
- Use OAuth for ChatGPT connector setup. Static bearer tokens are best reserved for direct API clients and operations.

## References

- OpenAI Apps SDK: build an MCP server for ChatGPT Apps
- OpenAI Apps SDK: authentication and OAuth metadata
- OpenAI Apps SDK: security and privacy guidance
- Model Context Protocol SDK

## License

MIT. This fork preserves the original `ssh-mcp` stdio behavior while adding ChatGPT-compatible remote connector support.
