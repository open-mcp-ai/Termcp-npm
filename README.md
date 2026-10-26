# [Termcp](https://github.com/open-mcp-ai/termcp) npm wrapper

**English** | [中文](./README.zh.md)

termcp's own usage (flags, setup, Web UI): <https://github.com/open-mcp-ai/termcp>

```bash
npx -y @open-mcp-ai/termcp           # once
npm i -g @open-mcp-ai/termcp         # or install the `termcp` command
```

Node 18+; no Go toolchain (the binary is fetched prebuilt, ~13 MB).

## MCP

Just the terminal tool (termcp v0.2.5+):

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

Add a second server if you also want an agent to manage releases: it serves one
tool, `use`, and takes the same lines as the shell.

```json
{
  "mcpServers": {
    "termcp": {
      "command": "npx",
      "args": ["-y", "@open-mcp-ai/termcp", "daemon", "stdio"]
    },
    "termcp-use": {
      "command": "npx",
      "args": ["-y", "@open-mcp-ai/termcp", "use", "--mcp", "--checkupdate"]
    }
  }
}
```

```bash
claude mcp add termcp     -- npx -y @open-mcp-ai/termcp daemon stdio
claude mcp add termcp-use -- npx -y @open-mcp-ai/termcp use --mcp --checkupdate
```

`--checkupdate` makes that server check for newer releases in the background while
it runs, and state what it found — in the handshake, in the tool description, and at
the end of a tool result that did not already answer it. It only ever reads the file
it wrote: nothing waits for GitHub, so a stale answer is still an answer.

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

**Switching costs no download.** `use <tag>` writes the choice to
`~/.termcp/.version`; the bytes are fetched the next time you run termcp. A
version already installed is an instant, offline switch. An instance that is
already running keeps the version it started with until it is stopped.

**`--kill` is the only action that runs a command.** It calls `daemon stop` on the
termcp already on disk — nothing is downloaded or installed to stop a process. If
the selected version was never installed, the command is refused rather than
installing something just to stop it.

**Every other word goes straight to termcp**, so `termcp --version`,
`termcp daemon stdio` and even `termcp nonsense` behave as if this wrapper were
not installed.

**Channels** are the release lines: `v0.2.8` is stable, `v0.2.8-rc.2` is rc,
`nightly-20261002` is nightly. `--channel` takes a comma-separated list and only
applies to `use latest`, `--list` and `--check`. `--check` only judges the line you
are on; other lines are told their newest tag but not whether you are behind. Its
answer is cached for a day (`--delay` changes that, `--force` asks now). The cache
and settings live in `~/.termcp/.check/` (`channel`, `delay`, `lastcheck`);
`channel` only decides what a check looks at by default, and never refuses a line.

**`--bin`** makes every launch run your own build instead (arguments included). It
is remembered in `~/.termcp/.bin`, and `use --bin off` clears it. `TERMCP_BIN`
does the same for a single run.

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

```bash
npm uninstall -g @open-mcp-ai/termcp
```

Then delete `~/.termcp` (or `$TERMCP_DATA_DIR` if you set it) — everything lives
there: downloaded binaries under `versions/`, sessions, and config.

## License

MIT, same as termcp; the binary is covered by
[the upstream license](https://github.com/open-mcp-ai/termcp/blob/main/LICENSE).
