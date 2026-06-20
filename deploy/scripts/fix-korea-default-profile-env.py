#!/usr/bin/env python3
"""Set SSH_MCP_DEFAULT_PROFILE=azure-kr-001 on Korea and restart ssh-mcp container.

Note: docker restart reloads profiles.json mount but does NOT reload --env-file.
If you also changed OAUTH_* or SSH_MCP_DATA_DIR, use recreate-korea-ssh-mcp-container.py instead.
"""
from __future__ import annotations

import paramiko
import sys
import time

from host_registry import KOREA_SSH_MCP, KOREA_SSH_MCP_CONTAINER, KOREA_SSH_MCP_PORT, deploy_password

ENV_PATH = "/opt/ssh-mcp-chatgpt-korea/env"
NEW_DEFAULT = "azure-kr-001"


def main() -> int:
    pw = deploy_password()
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(KOREA_SSH_MCP.ipv4, username=KOREA_SSH_MCP.ssh_user, password=pw, timeout=60)

    remote = f"""
set -e
PW='{pw}'
ENV='{ENV_PATH}'
if ! echo "$PW" | sudo -S test -f "$ENV"; then
  echo ENV_MISSING
  exit 1
fi
if echo "$PW" | sudo -S grep -q '^SSH_MCP_DEFAULT_PROFILE=' "$ENV"; then
  echo "$PW" | sudo -S sed -i 's/^SSH_MCP_DEFAULT_PROFILE=.*/SSH_MCP_DEFAULT_PROFILE={NEW_DEFAULT}/' "$ENV"
else
  echo "$PW" | sudo -S bash -c "echo 'SSH_MCP_DEFAULT_PROFILE={NEW_DEFAULT}' >> '$ENV'"
fi
echo "$PW" | sudo -S grep '^SSH_MCP_DEFAULT_PROFILE=' "$ENV"
echo "$PW" | sudo -S docker restart {KOREA_SSH_MCP_CONTAINER}
echo RESTARTED
"""
    _, o1, e1 = c.exec_command(remote, timeout=120)
    t1 = o1.read().decode()
    print(t1)
    if e1.read().decode().strip():
        print(e1.read().decode(), file=sys.stderr)

    for i in range(15):
        time.sleep(4)
        _, o2, _ = c.exec_command(f"curl -fsS -m 6 http://127.0.0.1:{KOREA_SSH_MCP_PORT}/health 2>&1", timeout=20)
        h = o2.read().decode()
        if "ssh_profile_count" in h:
            print(h)
            print("FIX_OK")
            c.close()
            return 0
        print(f"wait {i+1}: {h.strip()[:120]}")

    c.close()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())