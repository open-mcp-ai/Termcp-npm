# [Termcp](https://github.com/open-mcp-ai/termcp) npm 包装器

[English](./README.md) | **中文**

**termcp 自身的用法（flag、安装、MCP 客户端、Web UI）以上游 README 为准：
<https://github.com/open-mcp-ai/termcp>**

## 用法

```bash
npx -y @open-mcp-ai/termcp           # 用一次（不弹安装提示）
npm i -g @open-mcp-ai/termcp         # 或装出 termcp 命令
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
| `TERMCP_API`           | GitHub API 基址（默认 `https://api.github.com`），用于镜像或测试服务。 |
| `TERMCP_SKIP_VERIFY`   | 允许安装没有公布 SHA-256 的发行版。已公布但与字节不符的仍然失败。 |

## 渠道与切换版本

termcp 启动时**绝不自动检查更新**：常规启动只读 `~/.termcp/.version`，不发任何网络请求。
需要变动版本时：

```bash
# 切换版本
termcp use latest             # 沿 .version 当前所在的那条线走到最新
termcp use <版本>             # 任意指定版本——降级、升级或临时固定
termcp use --channel rc       # 换到 rc 线，并切到它最新的
termcp use --channel nightly  # 换到每日滚动构建线

# 更新并让运行中的实例用上新版本
termcp use latest && termcp daemon stop
```

`use` 只写 `.version`，已经在跑的实例仍然用旧二进制；`daemon stop` 把它结束，
下一次启动 termcp（`termcp` 本身、MCP 客户端或 Web UI）就会用上新版本。


## 卸载

删掉数据目录（默认 `~/.termcp`，或 `$TERMCP_DATA_DIR`）：`versions/` 下的二进制、
会话、配置。只删 `.version` 会让下次运行解析最新发行版，已装的二进制保留。

## 许可证

MIT，与 termcp 相同。本包运行的二进制遵循
[上游许可证](https://github.com/open-mcp-ai/termcp/blob/main/LICENSE)。
