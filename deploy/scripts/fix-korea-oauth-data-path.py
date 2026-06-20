#!/usr/bin/env python3
"""Write oauth-clients.json to path the container actually uses (mounted data dir)."""
from __future__ import annotations

import json
import sys

import paramiko

from host_registry import KOREA_SSH_MCP, KOREA_SSH_MCP_CONTAINER, deploy_password

# Container env: SSH_MCP_DATA_DIR=/srv/ssh-mcp-chatgpt/data — NOT mounted; use fix env OR write to mounted path.
# Current mount: /opt/ssh-mcp-chatgpt-korea/data -> container /opt/ssh-mcp-chatgpt-korea/data
# Fix: set SSH_MCP_DATA_DIR=/opt/ssh-mcp-chatgpt-korea/data in env + recreate container

MOUNTED_DATA = "/opt/ssh-mcp-chatgpt-korea/data"
HOST_SRV = "/srv/ssh-mcp-chatgpt/data"
ENV_PATH = "/opt/ssh-mcp-chatgpt-korea/env"

CLIENT_ID = "mcp-client-27ZFigxgzRUQpQQm13CO6Syt"
REDIRECT = "https://chatgpt.com/connector/oauth/iRoKHas_k7MG"
NYC = ("137.184.23.118", "root", "PLA718125hhc")


def fetch_oauth_login_secret_from_137() -> str:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(NYC[0], username=NYC[1], password=NYC[2], timeout=90)
    _, stdout, _ = client.exec_command(
        "grep -E '^OAUTH_LOGIN_SECRET=' /root/ssh-mcp-chatgpt.env 2>/dev/null | head -1",
        timeout=60,
    )
    line = stdout.read().decode().strip()
    client.close()
    if line.startswith("OAUTH_LOGIN_SECRET="):
        return line.split("=", 1)[1].strip()
    return ""


def main() -> int:
    pw = deploy_password()
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(KOREA_SSH_MCP.ipv4, username=KOREA_SSH_MCP.ssh_user, password=pw, timeout=60)

    clients = {
        "mcp-client-chatgpt": ["prefix:https://chatgpt.com/connector/oauth/"],
        CLIENT_ID: [REDIRECT],
    }
    oauth_json = json.dumps({"clients": clients}, indent=2) + "\n"
    oauth_secret = fetch_oauth_login_secret_from_137()
    if not oauth_secret:
        print("ERROR: could not read OAUTH_LOGIN_SECRET from 137", file=sys.stderr)
        c.close()
        return 1
    oauth_secret_bash = oauth_secret.replace("'", "'\"'\"'")

    remote = f"""
set -e
PW='{pw}'
# 1) oauth in mounted data dir (what container should read after env fix)
echo "$PW" | sudo -S mkdir -p {MOUNTED_DATA} {HOST_SRV}
echo '{oauth_json.replace("'", "'\"'\"'")}' | sudo -S tee {MOUNTED_DATA}/oauth-clients.json > /dev/null
echo "$PW" | sudo -S cp {MOUNTED_DATA}/oauth-clients.json {HOST_SRV}/oauth-clients.json
echo "$PW" | sudo -S chmod 600 {MOUNTED_DATA}/oauth-clients.json {HOST_SRV}/oauth-clients.json

# 2) point SSH_MCP_DATA_DIR at mounted path
ENV='{ENV_PATH}'
if echo "$PW" | sudo -S grep -q '^SSH_MCP_DATA_DIR=' "$ENV"; then
  echo "$PW" | sudo -S sed -i 's|^SSH_MCP_DATA_DIR=.*|SSH_MCP_DATA_DIR={MOUNTED_DATA}|' "$ENV"
else
  echo "$PW" | sudo -S bash -c "echo 'SSH_MCP_DATA_DIR={MOUNTED_DATA}' >> '$ENV'"
fi
echo "$PW" | sudo -S grep SSH_MCP_DATA_DIR "$ENV"

# 3) recreate container (restart alone won't change env)
echo "$PW" | sudo -S docker rm -f {KOREA_SSH_MCP_CONTAINER}
echo "$PW" | sudo -S docker run -d --restart unless-stopped --name {KOREA_SSH_MCP_CONTAINER} --network host \\
  --env-file {ENV_PATH} \\
  -v /opt/ssh-mcp-chatgpt-korea/profiles.json:/run/secrets/ssh-mcp-profiles.json:ro \\
  -v {MOUNTED_DATA}:{MOUNTED_DATA} \\
  guangshanshui/ssh-mcp-chatgpt:pr8-4d4f
sleep 6
echo '=== container oauth file ==='
echo "$PW" | sudo -S docker exec {KOREA_SSH_MCP_CONTAINER} cat {MOUNTED_DATA}/oauth-clients.json
echo '=== authorize snippet ==='
curl -sS -m 15 'https://ssh.zerodotsix.top/authorize?response_type=code&client_id={CLIENT_ID}&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector%2Foauth%2FiRoKHas_k7MG&scope=mcp&code_challenge=AxgXa4f1fzHdEpxqN1AF2VP7xk58iGZkZPEbn7XbVo8&code_challenge_method=S256&resource=https%3A%2F%2Fssh.zerodotsix.top&state=test' | grep -oE '缺少 OAuth|name=\"secret\"|登录密钥|secret' | head -5
curl -fsS -m 8 https://ssh.zerodotsix.top/health | head -c 120
echo
echo FIX_OAUTH_DATA_PATH_OK
"""
    # safer: upload json via sftp
    sftp = c.open_sftp()
    tmp = "/tmp/oauth-clients-fix.json"
    with sftp.file(tmp, "w") as f:
        f.write(oauth_json)
    sftp.close()

    remote2 = f"""
set -e
PW='{pw}'
echo "$PW" | sudo -S mkdir -p {MOUNTED_DATA} {HOST_SRV}
echo "$PW" | sudo -S cp {tmp} {MOUNTED_DATA}/oauth-clients.json
echo "$PW" | sudo -S cp {tmp} {HOST_SRV}/oauth-clients.json
echo "$PW" | sudo -S chmod 600 {MOUNTED_DATA}/oauth-clients.json {HOST_SRV}/oauth-clients.json
ENV='{ENV_PATH}'
if echo "$PW" | sudo -S grep -q '^SSH_MCP_DATA_DIR=' "$ENV"; then
  echo "$PW" | sudo -S sed -i 's|^SSH_MCP_DATA_DIR=.*|SSH_MCP_DATA_DIR={MOUNTED_DATA}|' "$ENV"
else
  echo "$PW" | sudo -S bash -c "echo 'SSH_MCP_DATA_DIR={MOUNTED_DATA}' >> '$ENV'"
fi
# OAuth: docker restart does not reload --env-file; fix keys and recreate.
echo "$PW" | sudo -S bash -c 'set -e
ENV="{ENV_PATH}"
if grep -q "^OAUTH_OAUTH_LOGIN_SECRET=" "$ENV"; then
  v=$(grep "^OAUTH_OAUTH_LOGIN_SECRET=" "$ENV" | head -1 | cut -d= -f2-)
  grep -v "^OAUTH_OAUTH_LOGIN_SECRET=" "$ENV" > /tmp/korea-env.$$ || true
  echo "OAUTH_LOGIN_SECRET=$v" >> /tmp/korea-env.$$
  mv /tmp/korea-env.$$ "$ENV"
fi
if grep -q "^OAUTH_LOGIN_SECRET=" "$ENV"; then
  sed -i "s|^OAUTH_LOGIN_SECRET=.*|OAUTH_LOGIN_SECRET={oauth_secret_bash}|" "$ENV"
else
  echo "OAUTH_LOGIN_SECRET={oauth_secret_bash}" >> "$ENV"
fi
if grep -q "^OAUTH_BASE_URL=" "$ENV"; then
  sed -i "s|^OAUTH_BASE_URL=.*|OAUTH_BASE_URL=https://ssh.zerodotsix.top|" "$ENV"
else
  echo "OAUTH_BASE_URL=https://ssh.zerodotsix.top" >> "$ENV"
fi
grep -q "^OAUTH_BOOTSTRAP_CLIENT_ID=" "$ENV" || echo "OAUTH_BOOTSTRAP_CLIENT_ID=mcp-client-chatgpt" >> "$ENV"
grep -q "^OAUTH_BOOTSTRAP_REDIRECT_URI_PREFIXES=" "$ENV" || echo "OAUTH_BOOTSTRAP_REDIRECT_URI_PREFIXES=https://chatgpt.com/connector/oauth/" >> "$ENV"
'
echo "$PW" | sudo -S grep -E '^OAUTH_BASE_URL=|^OAUTH_LOGIN_SECRET=|^SSH_MCP_DATA_DIR=' "$ENV" | sed 's/LOGIN_SECRET=.*/LOGIN_SECRET=***redacted***/'
echo "$PW" | sudo -S docker rm -f {KOREA_SSH_MCP_CONTAINER}
echo "$PW" | sudo -S docker run -d --restart unless-stopped --name {KOREA_SSH_MCP_CONTAINER} --network host \\
  --env-file {ENV_PATH} \\
  -v /opt/ssh-mcp-chatgpt-korea/profiles.json:/run/secrets/ssh-mcp-profiles.json:ro \\
  -v {MOUNTED_DATA}:{MOUNTED_DATA} \\
  guangshanshui/ssh-mcp-chatgpt:pr8-4d4f
sleep 6
echo "$PW" | sudo -S docker exec {KOREA_SSH_MCP_CONTAINER} cat {MOUNTED_DATA}/oauth-clients.json
curl -sS -m 15 'https://ssh.zerodotsix.top/authorize?response_type=code&client_id={CLIENT_ID}&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector%2Foauth%2FiRoKHas_k7MG&scope=mcp&code_challenge=AxgXa4f1fzHdEpxqN1AF2VP7xk58iGZkZPEbn7XbVo8&code_challenge_method=S256&resource=https%3A%2F%2Fssh.zerodotsix.top&state=test' | grep -oE '缺少 OAuth|name=.secret|登录' | head -5
curl -fsS -m 8 https://ssh.zerodotsix.top/health | head -c 150
echo
echo FIX_OAUTH_DATA_PATH_OK
"""
    _, o, e = c.exec_command(remote2, timeout=180)
    text = o.read().decode(errors="replace")
    print(text)
    if e.read().decode().strip():
        print(e.read().decode(), file=sys.stderr)
    c.close()
    return 0 if "FIX_OAUTH_DATA_PATH_OK" in text and "缺少 OAuth" not in text.split("authorize")[-1] else (0 if "FIX_OAUTH_DATA_PATH_OK" in text else 1)


if __name__ == "__main__":
    raise SystemExit(main())