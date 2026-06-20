#!/usr/bin/env python3
"""Recreate ssh-mcp-chatgpt-korea so --env-file changes take effect."""
from __future__ import annotations

import sys
import time

import paramiko

from host_registry import (
    KOREA_SSH_MCP,
    KOREA_SSH_MCP_CONTAINER,
    KOREA_SSH_MCP_PORT,
    deploy_password,
)

KOREA_OPT = "/opt/ssh-mcp-chatgpt-korea"
KOREA_ENV = f"{KOREA_OPT}/env"
KOREA_DATA = f"{KOREA_OPT}/data"  # must match SSH_MCP_DATA_DIR in env (oauth-clients.json lives here)
IMAGE = "guangshanshui/ssh-mcp-chatgpt:pr8-4d4f"


def main() -> int:
    pw = deploy_password()
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(KOREA_SSH_MCP.ipv4, username=KOREA_SSH_MCP.ssh_user, password=pw, timeout=60)

    remote = f"""
set -e
PW='{pw}'
echo "$PW" | sudo -S docker rm -f {KOREA_SSH_MCP_CONTAINER} 2>/dev/null || true
echo "$PW" | sudo -S docker run -d --restart unless-stopped --name {KOREA_SSH_MCP_CONTAINER} --network host \\
  --env-file {KOREA_ENV} \\
  -v {KOREA_OPT}/profiles.json:/run/secrets/ssh-mcp-profiles.json:ro \\
  -v {KOREA_DATA}:{KOREA_DATA} \\
  {IMAGE}
echo RECREATED
"""
    _, o1, _ = c.exec_command(remote, timeout=120)
    print(o1.read().decode())

    for i in range(20):
        time.sleep(3)
        _, o2, _ = c.exec_command(
            f"curl -fsS -m 8 http://127.0.0.1:{KOREA_SSH_MCP_PORT}/health 2>&1",
            timeout=15,
        )
        h = o2.read().decode()
        if '"status":"ok"' in h or '"status": "ok"' in h:
            print(h)
            print("RECREATE_OK")
            c.close()
            return 0
        print(f"wait {i+1}: {h.strip()[:160]}")

    c.close()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())