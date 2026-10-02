# [Termcp](https://github.com/open-mcp-ai/termcp) npm 包装器

[English](./README.md) | **中文**

**termcp 自身的用法（flag、安装、MCP 客户端、Web UI）以上游 README 为准：
<https://github.com/open-mcp-ai/termcp>**

## 用法

```bash
npx -y @open-mcp-ai/termcp           # 用一次（不弹安装提示）
npm i -g @open-mcp-ai/termcp         # 或装出 termcp 命令
```

```bash
termcp                  # Web UI + MCP：http://127.0.0.1:18765
termcp --help           # 每个 flag 都是二进制自己的
```

需要 Node 18+；不需要 Go 工具链（二进制是预编译下载的）。

## stdio 方式的 MCP（termcp v0.2.5+）

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

## 环境变量

| 变量                   | 作用                                                                |
| :--------------------- | :-------------------------------------------------------------------- |
| `TERMCP_VERSION`       | 固定一个发行版，或用 `latest` 重新解析。         |
| `TERMCP_DATA_DIR`      | 缓存位置（默认 `~/.termcp`）——与 termcp 用的是同一个根目录。|
| `TERMCP_BIN`           | 用这个二进制而不是下载（例如本地构建）。       |
| `TERMCP_MIRROR`        | 逗号分隔的镜像前缀，替代内置列表来探测。 |
| `TERMCP_SKIP_DOWNLOAD` | 从不下载；用 `TERMCP_BIN` 或 `PATH` 上的 `termcp`。    |


## 卸载

删掉数据目录（默认 `~/.termcp`，或 `$TERMCP_DATA_DIR`）：`versions/` 下的二进制、
会话、配置。只删 `.version` 会让下次运行解析最新发行版，已装的二进制保留。

## 许可证

MIT，与 termcp 相同。本包运行的二进制遵循
[上游许可证](https://github.com/open-mcp-ai/termcp/blob/main/LICENSE)。
