# [Termcp](https://github.com/open-mcp-ai/termcp) npm wrapper

It does one thing: download the termcp release binary for your platform (once,
cached under termcp's data directory), then run it with your argv — nothing
else. Same flags, same Web UI, same MCP endpoint as the binary.

**termcp's own usage (flags, setup, MCP clients, Web UI) lives in the upstream
README: <https://github.com/open-mcp-ai/termcp>.**

## Use

```bash
npx @open-mcp-ai/termcp              # once
npm i -g @open-mcp-ai/termcp         # or install the `termcp` command
```

```bash
termcp                  # Web UI + MCP on http://127.0.0.1:18765
termcp --help           # every flag is the binary's own
```

Node 18+; no Go toolchain (the binary is fetched prebuilt).

### Startup logs

On the first run, the wrapper reports each stage to stderr: release selection,
release metadata, source probing, download, verification, installation, and
launch. The download shows live progress in an interactive terminal. If one
source fails, the log identifies the failure and the next source being tried.
Later runs report the remembered version, cache hit, and launch without another
download. A pinned version or `TERMCP_BIN` override is also shown before launch.
The binary's own stdout and stderr remain connected to your terminal.

## Which version runs

| Order | Source | Effect |
| :---- | :----- | :----- |
| 1 | `$TERMCP_VERSION` | Use exactly this release, e.g. `0.2.3`. Read from env only — never written. Set it in CI, a Dockerfile or a systemd unit to freeze a version. `latest` re-resolves the newest release. |
| 2 | `$TERMCP_DATA_DIR/.version` | The version remembered from the last resolve. |
| 3 | newest release | Resolved with the GitHub API, then remembered. |

Everything lives under termcp's own data directory — `$TERMCP_DATA_DIR` when
set, otherwise `~/.termcp` — so one variable relocates the wrapper's cache and
termcp's sessions together. Binaries go to
`<data dir>/versions/<version>/termcp` and are reused as-is, so a normal run is
one `stat` and no network. Versions coexist: pinning one does not disturb the
remembered one. To move to the newest release, run
`TERMCP_VERSION=latest termcp --version`.

## Environment

| Variable               | Effect                                                                |
| :--------------------- | :-------------------------------------------------------------------- |
| `TERMCP_VERSION`       | Pin a release, or `latest` to re-resolve.         |
| `TERMCP_DATA_DIR`      | Where the cache lives (`~/.termcp` by default) — same root termcp uses.|
| `TERMCP_BIN`           | Run this binary instead of downloading one (e.g. a local build).       |
| `TERMCP_MIRROR`        | Comma-separated mirror prefixes to probe instead of the built-in list. |
| `TERMCP_SKIP_DOWNLOAD` | Never download; use `TERMCP_BIN` or whatever `termcp` is on `PATH`.    |

### Checksums and mirrors

When available, the sha256 comes from the GitHub releases API
(`assets[].digest`), while the binary bytes can come from mirrors. Every source
(including `github.com`) is probed in parallel; the fastest one is used, and a
mid-download failure hands over to the next source at the same byte offset.
With a published digest, the finished file must match it or installation fails.
If the API or digest is unavailable, the wrapper clearly warns that it cannot
verify the download's checksum.

## Uninstall

Delete the data directory (`~/.termcp` by default, or `$TERMCP_DATA_DIR`):
binaries under `versions/`, sessions, and config. Deleting just `.version`
makes the next run resolve the newest release, keeping installed binaries.

## License

MIT, same as termcp. The binary this package runs is covered by
[the upstream license](https://github.com/open-mcp-ai/termcp/blob/main/LICENSE).
