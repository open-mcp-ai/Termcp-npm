# [Termcp](https://github.com/open-mcp-ai/termcp) npm 包装器

[English](./README.md) | **中文**

**termcp 自身的用法（flag、安装、Web UI）以上游 README 为准：
<https://github.com/open-mcp-ai/termcp>**

```bash
npx -y @open-mcp-ai/termcp           # 用一次
npm i -g @open-mcp-ai/termcp         # 或装出 termcp 命令
```

需要 Node 18+；不需要 Go 工具链（二进制是预编译下载的，约 13 MB）。

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

`termcp` 提供 `term`（v0.2.5+）；`termcp-use` 只提供一个 tool `use`，唯一参数就是下一节那些行。
`--checkupdate` 不给 tool 加东西 —— 它往提示词里加一条：会话开始查一次，有更新就说出来。

## `use`

```
use [<版本>|latest] [--channel <名字>[,<名字>]]     选择（不带参数 = 看状态）
use --list  [--channel <名字>[,<名字>]]             每条线最新的，或某条线的全部 tag
use --check [--force] [--channel <名字>[,<名字>]]   有没有更新的？
use --delay <30m|6h|2d|default>                     一次检查的结果能复用多久
use --bin <命令...>|off                             启动改成跑别的东西
use --kill [daemon flags]                           停掉运行中的实例
use --rm <版本>                                     删掉一个已装的发行版
use --mcp [--checkupdate]                           以 MCP 提供上面这些
```

- **是选择，不是安装。** 启动跑 `~/.termcp/.version` 里的一行；字节下次启动才到，
  运行中的实例在那之前仍用旧二进制。
- **`--kill` 是唯一执行命令的动作**：跑盘上二进制的 `daemon stop`。为了停东西不下载、
  不安装，没装过的版本直接拒绝，不会被执行。
- **其余的词原样交给二进制。**
- **渠道**就是一条线（`v0.2.8` stable、`v0.2.8-rc.2` rc、`nightly-20261002` nightly）。
  `--channel` 收逗号列表，只对 `latest`、`--list`、`--check` 有效。`--check` 只判决当前
  那条线，答案复用一天（`--delay`；`--force` 当场问）。三个事实放在
  `~/.termcp/.check/{channel,delay,lastcheck}`；`channel` 是范围，不是许可。
- **`--bin`** 让每次启动跑自己的构建（参数保留）：`~/.termcp/.bin` 里的一行
  （`use --bin off` 清掉）。`TERMCP_BIN` 同样只影响一次。

## 环境变量

| 变量 | 作用 |
| :--- | :--- |
| `TERMCP_VERSION` | 固定一个发行版，或用 `latest` 重新解析。 |
| `TERMCP_DATA_DIR` | 缓存根目录（默认 `~/.termcp`）。 |
| `TERMCP_BIN` | 用这个二进制而不是下载，只对这一次运行有效。 |
| `TERMCP_MIRROR` | 逗号分隔的镜像前缀，替代内置列表来探测。 |
| `TERMCP_SKIP_DOWNLOAD` | 从不下载；用 `TERMCP_BIN` 或 `PATH` 上的 `termcp`。 |
| `TERMCP_API` | GitHub API 基址（默认 `https://api.github.com`）。 |
| `TERMCP_SKIP_VERIFY` | 允许安装没有公布 SHA-256 的发行版。 |
| `TERMCP_CACHE_MINUTES` | `use --list` 的缓存分钟数（默认 10；`0` 每次都问）。 |
| `TERMCP_CHECK_HOURS` | `use --check` 信任那份列表的小时数（默认 24；`0` 每次都查）。 |

## 卸载

删掉 `~/.termcp`（或 `$TERMCP_DATA_DIR`）。

## 许可证

MIT，与 termcp 相同；本包运行的二进制遵循
[上游许可证](https://github.com/open-mcp-ai/termcp/blob/main/LICENSE)。
