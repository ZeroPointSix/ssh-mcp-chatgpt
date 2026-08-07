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
| `fs-write` | Send text to a remote path through the SSH channel stdin as base64. Modes: `create`, `overwrite`, `append`. Writes to a temporary file and then moves it into place. Returns bytes, sha256, and a short preview. |
| `fs-read` | Read a bounded window of a remote file. Returns bytes, sha256, the selected lines, and truncation metadata. |
| `fs-patch` | Replace one exact and unique string in a remote file. Keeps a backup copy. Returns sha256 before and after. |
| `write-and-run` | Do `fs-write` and then run the file with the same background job behavior as `exec`. |

## Long content

Large files use more than one `fs-write` call:

1. First call uses `mode: "overwrite"`.
2. Each next call uses `mode: "append"`.
3. The last call sends `expected_sha256` of the full file. The server compares
   the value and fails if the file is different.

## Safety rules

- The remote path must be absolute. The server rejects `..`, NUL characters,
  and newline characters in the path.
- `SSH_MCP_FS_ALLOWED_ROOTS` gives the permitted directories. A path outside
  these roots is rejected.
- The file body is never put into the shell command line. Only the quoted path
  goes into the command.
- `SSH_MCP_FS_MAX_BYTES` limits one write.
- The audit log records the path, the byte count, and the sha256 value. It does
  not record the content.

## Syntax check

When the deployment enables the check, the server validates the new file before
it replaces the old file:

- `.sh`, `.bash`: `bash -n`
- `.py`: `python3 -m py_compile`
- `.json`: parsed on the server

If the check fails, the temporary file is removed and the original file stays.

## Phases

1. Phase 1: `fs-write`, `fs-read`, `write-and-run`, path guards, audit fields.
2. Phase 2: `fs-patch` and the syntax check.
3. Phase 3: a persistent shell session and a code execution mode.
