# [Termcp](https://github.com/open-mcp-ai/termcp) npm wrapper

**English** | [中文](./README.zh.md)

**termcp's own usage (flags, setup, MCP clients, Web UI) lives in the upstream
README: <https://github.com/open-mcp-ai/termcp>**

## Use

```bash
npx -y @open-mcp-ai/termcp           # once (no install prompt)
npm i -g @open-mcp-ai/termcp         # or install the `termcp` command
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
| `TERMCP_API`           | GitHub API base (default `https://api.github.com`); for a mirror or a test server. |
| `TERMCP_SKIP_VERIFY`   | Install a release that publishes no SHA-256 digest. A digest that disagrees with the bytes still fails. |
| `TERMCP_CACHE_MINUTES` | How long `termcp list` reuses a fetched release list (default 10; `0` asks GitHub every time). |

## Channels and switching versions

termcp never checks for updates on its own: a regular launch reads
`~/.termcp/.version` and touches no network. When you want to move:

```bash
termcp list                   # the newest release on each line
termcp use latest             # newest release on the line .version is already on
termcp use <tag>              # one specific release — downgrade, upgrade, or pinned
termcp use --channel rc       # move onto the rc line and switch to its newest

# Update and stop the running instance in one go
termcp use latest && termcp kill

# Drop a version you no longer need (each is ~13 MB)
termcp rm <tag>
```

`use` only writes `.version`, so an instance already serving keeps the old binary.
`kill` ends the background daemon (a manually started instance is left alone);
whatever connects next starts the selected release.

## MCP tool for an agent

`--mcp` serves the same commands over stdio as one tool, `termcp`, so an agent can
move termcp between versions itself. Nothing is launched and no binary is needed
for status:

```json
{
  "mcpServers": {
    "termcp-versions": {
      "command": "npx",
      "args": ["-y", "@open-mcp-ai/termcp", "--mcp"]
    }
  }
}
```

The tool takes one argument, `cmd`: empty for status, or a command from the list
above (`list`, `use <tag>|latest [--channel <name>]`, `kill`, `rm <tag>`).


## Uninstall

Delete the data directory (`~/.termcp` by default, or `$TERMCP_DATA_DIR`):
binaries under `versions/`, sessions, and config. Deleting just `.version`
makes the next run resolve the newest release, keeping installed binaries.

## License

MIT, same as termcp. The binary this package runs is covered by
[the upstream license](https://github.com/open-mcp-ai/termcp/blob/main/LICENSE).
