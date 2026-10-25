# [Termcp](https://github.com/open-mcp-ai/termcp) npm wrapper

**English** | [中文](./README.zh.md)

termcp's own usage (flags, setup, Web UI): <https://github.com/open-mcp-ai/termcp>

```bash
npx -y @open-mcp-ai/termcp           # once
npm i -g @open-mcp-ai/termcp         # or install the `termcp` command
```

Node 18+; no Go toolchain (the binary is fetched prebuilt, ~13 MB).

## MCP

```json
{
  "mcpServers": {
    "termcp":     { "command": "npx", "args": ["-y", "@open-mcp-ai/termcp", "daemon", "stdio"] },
    "termcp-use": { "command": "npx", "args": ["-y", "@open-mcp-ai/termcp", "use", "--mcp", "--checkupdate"] }
  }
}
```

```bash
claude mcp add termcp     -- npx -y @open-mcp-ai/termcp daemon stdio
claude mcp add termcp-use -- npx -y @open-mcp-ai/termcp use --mcp --checkupdate
```

`termcp` serves `term` (v0.2.5+); `termcp-use` serves one tool, `use`, whose only
argument is the line below. `--checkupdate` adds no tool — it adds an order to the
prompt: check at session start, and say so if a newer release exists.

## `use`

```
use [<tag>|latest] [--channel <name>[,<name>]]      select (bare = status)
use --list  [--channel <name>[,<name>]]             newest per line, or a line's tags
use --check [--force] [--channel <name>[,<name>]]   is anything newer?
use --delay <30m|6h|2d|default>                     how long a check may reuse its answer
use --bin <command...>|off                          launch something else instead
use --kill [daemon flags]                           stop the running instance
use --rm <tag>                                      delete an installed release
use --mcp [--checkupdate]                           serve this over MCP
```

- **Selects, does not install.** A launch runs one line of `~/.termcp/.version`;
  the bytes arrive on the next launch, and a running instance keeps the old binary.
- **`--kill` is the only action that runs a command**: the binary's `daemon stop`
  from disk. Nothing is downloaded or installed to stop something, and a version
  that was never installed is refused, not run.
- **Any other word goes straight to the binary.**
- **Channels** are lines of releases (`v0.2.8` stable, `v0.2.8-rc.2` rc,
  `nightly-20261002` nightly). `--channel` takes a comma-separated list, only on
  `latest`, `--list` and `--check`. `--check` judges the line in use only and
  reuses its answer for a day (`--delay`; `--force` asks now). The three facts
  live in `~/.termcp/.check/{channel,delay,lastcheck}`; `channel` is a scope, not
  a permission.
- **`--bin`** points every launch at your own build, arguments included: one line
  in `~/.termcp/.bin` (`use --bin off` clears it). `TERMCP_BIN` does the same for
  one run.

## Environment

| Variable | Effect |
| :--- | :--- |
| `TERMCP_VERSION` | Pin a release, or `latest` to re-resolve. |
| `TERMCP_DATA_DIR` | Cache root (default `~/.termcp`). |
| `TERMCP_BIN` | Run this binary instead of downloading, for one run. |
| `TERMCP_MIRROR` | Comma-separated mirror prefixes to probe. |
| `TERMCP_SKIP_DOWNLOAD` | Never download; use `TERMCP_BIN` or `PATH`. |
| `TERMCP_API` | GitHub API base (default `https://api.github.com`). |
| `TERMCP_SKIP_VERIFY` | Install a release with no published digest. |
| `TERMCP_CACHE_MINUTES` | `use --list` cache TTL (default 10; `0` always asks). |
| `TERMCP_CHECK_HOURS` | `use --check` trust window (default 24; `0` always checks). |

## Uninstall

Delete `~/.termcp` (or `$TERMCP_DATA_DIR`).

## License

MIT, same as termcp; the binary is covered by
[the upstream license](https://github.com/open-mcp-ai/termcp/blob/main/LICENSE).
