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

只要终端工具（termcp v0.2.5+）：

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

再想让 agent 也管版本，就加第二个 server：它只提供一个 tool `use`，接受的行和 shell 里一样。

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

`--checkupdate` 让这个 server 在运行期间自己后台查更新，把结果写进握手的 instructions、tool 描述，
以及没自己回答过这个问题的工具结果末尾。它只读自己写下的那个文件：从不为此等 GitHub，所以旧答案也算答案。

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

**切换版本不下载。** `use <版本>` 只是把选择写进 `~/.termcp/.version`；真正的下载发生在你
下一次运行 termcp 的时候。已经装过的版本是离线瞬时切换；已经在运行的实例继续用它启动时的
版本，直到被停掉。

**`--kill` 是唯一会执行命令的动作。** 它调用盘上已有的 termcp 的 `daemon stop` —— 为了停一个
进程不会去下载或安装任何东西。如果选中的版本根本没装，就直接拒绝，而不是先装一个再来停。

**其他词原样交给 termcp**，所以 `termcp --version`、`termcp daemon stdio`，甚至
`termcp nonsense`，都跟没装这层包装一样。

**渠道**是发行版的线：`v0.2.8` 属于 stable，`v0.2.8-rc.2` 属于 rc，`nightly-20261002` 属于
nightly。`--channel` 收逗号分隔的名字，只对 `use latest`、`--list`、`--check` 有效。`--check`
只判断你当前所在的那条线；其他线只告诉你它们最新的版本，不判断你是否落后。检查结果缓存一天
（`--delay` 可改，`--force` 立刻重新查）。缓存和设置放在 `~/.termcp/.check/`
（`channel`、`delay`、`lastcheck`）；`channel` 只决定默认检查哪些线，不会拒绝任何线。

**`--bin`** 让每次启动跑你自己的构建（参数保留），记在 `~/.termcp/.bin`，
`use --bin off` 清除；`TERMCP_BIN` 只影响一次运行。

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

```bash
npm uninstall -g @open-mcp-ai/termcp
```

然后删掉 `~/.termcp`（设了 `$TERMCP_DATA_DIR` 就删那个）—— 东西都在这里：
`versions/` 下下载的二进制、会话、配置。

## 许可证

MIT，与 termcp 相同；本包运行的二进制遵循
[上游许可证](https://github.com/open-mcp-ai/termcp/blob/main/LICENSE)。
