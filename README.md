# Responses API + Edge

这个项目把本机 Microsoft Edge 通过 Playwright/CDP 暴露成 Responses API 的 function tools。它支持 OpenAI 官方端点，也支持实现了相同工具调用协议的第三方 Responses 端点。

ChatGPT Chrome Extension 不参与这条链路。扩展装在 Edge 里也不会向 Responses API 暴露浏览器实例。

## 安装

```powershell
npm install
Copy-Item .env.example .env
```

编辑 `.env`，至少填写：

```dotenv
OPENAI_API_KEY=你的密钥
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5.6
```

第三方端点只需要替换 `OPENAI_BASE_URL`、`OPENAI_API_KEY` 和 `OPENAI_MODEL`。模型名称相同不代表接口一定兼容，使用 doctor 验证完整的工具调用回路：

```powershell
npm run doctor:api
```

## 使用方式一：VS Code Codex / MCP

这个模式不需要 `OPENAI_API_KEY`。Codex 负责模型调用，MCP 服务只在本机控制 Edge。

安装（或刷新）Codex MCP 注册：

```powershell
npm run mcp:install
```

检查注册状态：

```powershell
npm run mcp:status
```

看到 `responses_edge_browser` 且状态为 `enabled` 后，完全重启 VS Code/Codex，再在对话中直接说：

```text
使用 responses_edge_browser 打开 https://example.com，读取页面内容并截图
```

Codex 会把服务名和工具名组合成 `mcp__responses_edge_browser__browser_*`。注册名必须使用下划线，才能与项目的浏览器规则保持一致。

MCP 服务也可以单独启动，通常不需要手动运行，因为 Codex 会按配置自动启动它：

```powershell
npm run mcp
```

MCP 模式只读取浏览器配置 `.env.mcp`，不读取提供商密钥文件 `.env`。MCP 客户端显式传入的环境变量优先于 `.env.mcp`。当前使用 `127.0.0.1:9333` 和项目内的 `.mcp-edge-profile`，不会连接当前用户的 Edge Profile；启动参数会禁用扩展与同步，并在 CDP 端口属于其他 Profile 时直接拒绝连接。

每个 MCP 客户端只会列出和操作自己拥有的标签页。普通导航复用当前标签；网页弹出的标签最多保留最新一个；只有显式调用 `browser_tabs new` 才保留额外标签。`EDGE_TAB_IDLE_TIMEOUT_MS` 控制闲置回收，当前值 `0` 表示关闭计时回收；客户端退出仍会清理自己的标签。冷启动前只清除专用 Profile 保存的标签会话，不删除 Cookie、登录状态或历史记录。

本机当前按用户选择使用有头模式：`EDGE_HEADLESS=false`、`EDGE_BRING_TO_FRONT=true`、`EDGE_KEEP_OPEN=true`。需要后台运行时可改成 `EDGE_HEADLESS=true` 和 `EDGE_BRING_TO_FRONT=false`。更改模式后需在没有其他活动客户端时重启专用 Edge；修改文件不会改变已经运行的浏览器进程。

多个 Codex 任务共享该专用 Edge 时，会通过 Profile 级生命周期锁和客户端 lease 协调启动与关闭。只有 `EDGE_KEEP_OPEN=false` 且最后一个客户端退出时，服务才会主动关闭项目启动的 Edge；每个客户端始终只清理自己的标签。可用以下命令验证生命周期；手动停止命令应在确认没有其他活动客户端或明确需要重启时使用：

```powershell
npm run doctor:mcp
npm run doctor:mcp -- --isolated
npm run edge:mcp:stop
```

`doctor:mcp` 验证实际配置的 MCP 导航、弹窗、截图和两个客户端的标签隔离，支持有头模式。`--isolated` 使用临时 Profile、独立端口和无头模式额外验证最后一个客户端关闭后的进程清理，不改变实际浏览器配置。

### CC Switch 管理 Codex 时

将 `responses_edge_browser` 同时保留在 CC Switch 的 Codex 通用配置和统一 MCP 列表（为 Codex 启用）。关闭通用配置合并的供应商也需要保留这项注册。只运行 `mcp:install` 不会更新 CC Switch 的持久配置来源，后续切换供应商可能重新生成配置。

```toml
[mcp_servers.responses_edge_browser]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\vscode\browser-skill\src\mcp-server.mjs']
cwd = 'C:\vscode\browser-skill'
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 120
```

安装和状态命令优先使用桌面环境的 `CODEX_CLI_PATH`，没有该变量时再使用 PATH 中的 Codex。技能文件存在、注册存在、MCP 握手成功、当前对话实际收到工具是不同的检查；修复后在重新加载 MCP 的 Codex 对话中验证 `browser_navigate` 和截图。

Windows 工作区沙箱可能以 `CodexSandboxOffline` 身份运行，而 `USERPROFILE` 仍显示桌面用户。此时 Codex CLI 可能读取沙箱账户的另一份配置。安装脚本会识别这种差异并停止，避免误注册或误报丢失；请在桌面宿主环境执行。不要把沙箱网络限制造成的浏览器超时当成网站或宿主 MCP 不可用。

## 使用方式二：直接调用 Responses API

首次运行会打开一个独立的 Edge Profile。需要登录的网站，在这个窗口中手动登录一次，登录状态会保留在 `%LOCALAPPDATA%\ResponsesEdgeProfile`。

```powershell
npm start -- "打开 https://example.com，读取页面标题和主要内容"
```

这个模式由本项目调用官方或第三方 Responses 端点，需要配置 `.env`。它不经过 Codex 的 MCP 列表。

也可以先单独启动 Edge：

```powershell
npm run edge
```

常用配置：

- `RESPONSES_STATE_MODE=manual`：兼容性最好，不依赖 `previous_response_id`。
- `RESPONSES_COMPAT_MODE=minimal`：第三方拒绝 `store`、`parallel_tool_calls` 或 `strict` 时启用。
- `BROWSER_ALLOWED_ORIGINS`：限制可访问站点，生产环境建议设置。
- `BROWSER_INLINE_SCREENSHOTS=true`：把截图作为图片工具结果发送给模型；第三方端点可能不支持。
- `EDGE_CDP_URL`：连接其他 CDP 地址。默认只允许回环地址。
- `EDGE_BRING_TO_FRONT`：是否允许工具操作把 Edge 标签切到前台；当前 MCP 配置开启。
- `EDGE_HEADLESS`：是否使用无原生窗口的 Edge headless 模式；当前 MCP 配置关闭。
- `EDGE_AUTO_CLOSE_TABS`：回收旧的隐式弹窗；显式 `browser_tabs new` 不受影响。
- `EDGE_TAB_IDLE_TIMEOUT_MS`：多久没有工具调用后关闭该客户端拥有的标签；`0` 表示禁用。
- `EDGE_CLEAR_SESSION_TABS_ON_START`：冷启动前清除专用 Profile 保存的标签会话，不影响登录状态。

## 安全

页面正文和工具结果会发送给 API 提供商。不要让不可信的第三方端点处理登录后台、个人资料、财务页面或其他敏感内容。程序不会读取 Cookie、Local Storage 或密码字段，也不允许 `file:`、`data:` 和 `javascript:` 导航。

直接调用模式下，Edge 运行期间本机其他进程也可能访问调试端口；可用 `EDGE_KEEP_OPEN=false` 在任务结束时关闭窗口。MCP 模式会自动回收各客户端标签，并在关闭保留选项且最后一个客户端退出时主动关闭项目管理的 Edge。

本地 stdio MCP 不能直接作为 Responses API 的 `server_url`。需要让云端 Responses 直接调用 MCP 时，使用公开的 Streamable HTTP MCP，或使用 OpenAI Secure MCP Tunnel；本机单机使用继续采用 `npm start` 的 function-calling 桥接即可。
