# [Termcp](https://github.com/open-mcp-ai/termcp) npm wrapper

**English** | [中文](./README.zh.md)

**termcp's own usage (flags, setup, MCP clients, Web UI) lives in the upstream
README: <https://github.com/open-mcp-ai/termcp>**

## Use

```bash
npx -y @open-mcp-ai/termcp           # once (no install prompt)
npm i -g @open-mcp-ai/termcp         # or install the `termcp` command
```

```bash
termcp                  # Web UI + MCP on http://127.0.0.1:18765
termcp --help           # every flag is the binary's own
```

Node 18+; no Go toolchain (the binary is fetched prebuilt).

## MCP over stdio (termcp v0.2.5+)

```json
{
  "mcpServers": {
    "termcp": {
      "command": "npx",
      "args": ["-y", "@open-mcp-ai/termcp", "daemon", "stdio"]
    }
  }
}
```

```bash
claude mcp add termcp -- npx -y @open-mcp-ai/termcp daemon stdio
```

## Environment

| Variable               | Effect                                                                |
| :--------------------- | :-------------------------------------------------------------------- |
| `TERMCP_VERSION`       | Pin a release, or `latest` to re-resolve.         |
| `TERMCP_DATA_DIR`      | Where the cache lives (`~/.termcp` by default) — same root termcp uses.|
| `TERMCP_BIN`           | Run this binary instead of downloading one (e.g. a local build).       |
| `TERMCP_MIRROR`        | Comma-separated mirror prefixes to probe instead of the built-in list. |
| `TERMCP_SKIP_DOWNLOAD` | Never download; use `TERMCP_BIN` or whatever `termcp` is on `PATH`.    |


## Uninstall

Delete the data directory (`~/.termcp` by default, or `$TERMCP_DATA_DIR`):
binaries under `versions/`, sessions, and config. Deleting just `.version`
makes the next run resolve the newest release, keeping installed binaries.

## License

MIT, same as termcp. The binary this package runs is covered by
[the upstream license](https://github.com/open-mcp-ai/termcp/blob/main/LICENSE).
