# Long Command Optimization

Linear: ZER-496. This document gives the plan to make long remote work reliable.

## Problem

Today the connector has only `exec` and `sudo-exec`. To put a file on a remote
host, the agent must put the full file body inside one shell command, usually
with a here-document. This causes these failures:

- Quoting errors. Single quotes, backticks, `$`, and CRLF characters break the
  here-document.
- Client-side size limits. Large payloads make one very long tool argument.
- No verification. The tool result does not prove what is on the disk.
- No safe retry. A partial write leaves a broken file, and a second try must
  start again from the first byte.

## Goal

Give the agent this loop: write the content, verify the content, then run a
short command. The file body must not go through the shell command line.

## New tools

| Tool | Function |
| ---- | -------- |
| `fs-read` | Resolve the canonical path and read a bounded line window. Return numbered lines, total lines, truncation state, and sha256. |
| `fs-write` | Send text or binary data through SFTP staging. Check the old sha256 before backup or replacement. Support `sudo -n install` for elevated writes. |
| `fs-edit` | Replace exact text. Read the source, stage the result, and recheck the source sha256 immediately before replacement. |
| `run-script` | Run content or an existing path with an explicit interpreter and a syntax check before execution. |

## Write sequence

1. Resolve the target with remote `realpath`.
2. Resolve each allowed root and compare canonical paths.
3. Upload the complete body to `/tmp/.mcp/staging/<uuid>` through SFTP.
4. Check the staging sha256.
5. Check `expected_sha256` against the target before any backup or write.
6. Skip the write when the target already has the same sha256.
7. Back up the target by default.
8. Install to a temporary file in the target directory and rename it.
9. Return bytes and sha256. When `verify` is true, reject a read-back mismatch.

## Safety rules

- The remote path must be absolute. The server rejects `..`, NUL characters,
  and newline characters in the path.
- File tools are disabled by default.
- `SSH_MCP_FS_ALLOWED_ROOTS` gives the permitted canonical directories. An
  empty allowlist denies every user-supplied path.
- The file body is never put into the shell command line. SFTP carries the body.
- `SSH_MCP_FS_MAX_BYTES` limits one write.
- `fs-read` limits both lines and characters on the remote host before stdout
  reaches Node.
- `fs-edit` uses the hash from its read as a mandatory write-time precondition.
- The audit log records the path, the byte count, and the sha256 value. It does
  not record the content.

## Syntax check

When the deployment enables the check, the server validates the new file before
it replaces the old file:

- `.sh`, `.bash`: `bash -n`
- `.py`: parse with Python `ast`
- `.json`: parsed on the server

If the check fails, the temporary file is removed and the original file stays.

## Command selection

`exec` accepts only one-line commands. Use `fs-write` for file content,
`fs-edit` for exact changes, `fs-read` for file reads, and `run-script` for
newlines, heredocs, loops, conditionals, or functions.
