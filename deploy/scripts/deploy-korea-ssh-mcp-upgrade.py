#!/usr/bin/env python3
"""Build or pull the current image and recreate ssh-mcp-chatgpt-korea on Azure Korea."""
from __future__ import annotations

import os
import sys
import time

import paramiko

KOREA_HOST = os.environ.get("KOREA_SSH_HOST", "20.196.72.18")
KOREA_USER = os.environ.get("KOREA_SSH_USER", "hu")
KOREA_OPT = "/opt/ssh-mcp-chatgpt-korea"
KOREA_ENV = f"{KOREA_OPT}/env"
KOREA_DATA = f"{KOREA_OPT}/data"
CONTAINER = "ssh-mcp-chatgpt-korea"
PORT = os.environ.get("KOREA_SSH_MCP_PORT", "3039")
IMAGE = os.environ.get(
    "SSH_MCP_KOREA_IMAGE",
    "ghcr.io/zeropointsix/ssh-mcp-chatgpt:1.6.6-chatgpt.0",
)
REPO = os.environ.get(
    "SSH_MCP_REPO",
    "https://github.com/ZeroPointSix/ssh-mcp-chatgpt.git",
)


def deploy_password() -> str:
    password = os.environ.get("DEPLOY_PASSWORD") or os.environ.get("KOREA_SSH_PASSWORD")
    if not password:
        raise SystemExit(
            "Set DEPLOY_PASSWORD (or KOREA_SSH_PASSWORD) for Korea SSH + sudo.",
        )
    return password


def run_remote(client: paramiko.SSHClient, command: str, timeout: int = 900) -> str:
    print(f">>> {command[:200]}")
    _, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode()
    err = stderr.read().decode()
    if out:
        print(out[-4000:] if len(out) > 4000 else out)
    if err:
        print(err[-2000:] if len(err) > 2000 else err, file=sys.stderr)
    return out


def main() -> int:
    pw = deploy_password()
    pw_shell = pw.replace("'", "'\"'\"'")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(KOREA_HOST, username=KOREA_USER, password=pw, timeout=60)

    remote = f"""
set -e
PW='{pw_shell}'
IMAGE='{IMAGE}'
CONTAINER='{CONTAINER}'
OPT='{KOREA_OPT}'

if ! echo "$PW" | sudo -S docker image inspect "$IMAGE" >/dev/null 2>&1; then
  rm -rf /tmp/ssh-mcp-deploy
  git clone --depth 1 {REPO} /tmp/ssh-mcp-deploy
  cd /tmp/ssh-mcp-deploy
  echo "$PW" | sudo -S docker build -t "$IMAGE" .
fi

echo "$PW" | sudo -S docker rm -f "$CONTAINER" 2>/dev/null || true
echo "$PW" | sudo -S docker run -d --restart unless-stopped --name "$CONTAINER" --network host \\
  --env-file {KOREA_ENV} \\
  -v {KOREA_OPT}/profiles.json:/run/secrets/ssh-mcp-profiles.json:ro \\
  -v {KOREA_DATA}:{KOREA_DATA} \\
  "$IMAGE"
echo RECREATED
"""
    run_remote(client, remote, timeout=900)

    for attempt in range(20):
        time.sleep(3)
        health = run_remote(
            client,
            f"curl -fsS -m 8 http://127.0.0.1:{PORT}/health 2>&1",
            timeout=30,
        )
        if '"status":"ok"' in health or '"status": "ok"' in health:
            print(health)
            print("DEPLOY_OK")
            client.close()
            return 0
        print(f"wait {attempt + 1}: {health.strip()[:160]}")

    client.close()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
