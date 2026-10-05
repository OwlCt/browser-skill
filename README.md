# Responses Edge Browser

[English](README_EN.md) | [简体中文](README.md)

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP Compatible](https://img.shields.io/badge/MCP-1.29.0-purple.svg)](https://modelcontextprotocol.io/)
[![Playwright Core](https://img.shields.io/badge/playwright--core-1.61.1-orange.svg)](https://playwright.dev/)
[![Tests](https://img.shields.io/badge/tests-58%20passed-success.svg)](test)

**Responses Edge Browser** 是一个专为 AI Agent 设计的本地浏览器控制桥接工具。它通过 Playwright / CDP（Chrome DevTools Protocol）将本机的 **Microsoft Edge**（或 **Google Chrome**）能力完整暴露给大语言模型。

它不仅支持作为标准的 **stdio MCP（Model Context Protocol）服务器** 无缝接入 **VS Code Codex**、**Cursor**、**Claude Desktop**、**Antigravity** 与 **Windsurf** 等客户端，还内置了基于 **OpenAI Responses API**（以及任何兼容该工具调用规范的第三方推理服务）的自主 Agent CLI。

---

## 目录

- [核心特性](#核心特性)
- [架构与运行模式](#架构与运行模式)
  - [模式一：Stdio MCP 服务器（推荐日常搭配 Agent IDE 使用）](#模式一stdio-mcp-服务器推荐日常搭配-agent-ide-使用)
  - [模式二：独立 Responses API Agent CLI（自动化终端代理）](#模式二独立-responses-api-agent-cli自动化终端代理)
- [快速开始](#快速开始)
  - [环境准备](#环境准备)
  - [安装步骤](#安装步骤)
- [MCP 客户端接入配置](#mcp-客户端接入配置)
  - [VS Code Codex](#vs-code-codex)
  - [CC Switch 管理 Codex](#cc-switch-管理-codex)
  - [Cursor](#cursor)
  - [Claude Desktop / Windsurf](#claude-desktop--windsurf)
- [工具集完整清单（21 个专用工具）](#工具集完整清单21-个专用工具)
  - [1. 页面导航与感知](#1-页面导航与感知)
  - [2. 页面元素交互](#2-页面元素交互)
  - [3. 多标签页会话管理](#3-多标签页会话管理)
  - [4. 只读诊断与调试](#4-只读诊断与调试)
  - [5. 运行时控制与安全接管](#5-运行时控制与安全接管)
- [核心机制深入解析](#核心机制深入解析)
  - [动态运行时控制（browser_runtime）](#动态运行时控制browser_runtime)
  - [Profile 隔离与多客户端租约机制](#profile-隔离与多客户端租约机制)
  - [安全架构与零凭证泄露原则](#安全架构与零凭证泄露原则)
  - [人机协同验证（browser_handoff）](#人机协同验证browser_handoff)
  - [站点访问白名单策略（browser_site）](#站点访问白名单策略browser_site)
- [配置参数参考（.env 与 .env.mcp）](#配置参数参考env-与-envmcp)
- [诊断、测试与排错工具](#诊断测试与排错工具)
  - [测试套件（npm test）](#测试套件npm-test)
  - [体检工具（Doctor 工具集）](#体检工具doctor-工具集)
  - [安全关闭受管浏览器](#安全关闭受管浏览器)
- [常见问题与排错（FAQ）](#常见问题与排错faq)

---

## 核心特性

- **双引擎支持**：原生优先支持 Microsoft Edge，同时支持 Google Chrome，无需修改代码即可在运行时通过工具平滑切换。
- **21 个细粒度控制工具**：覆盖从语义 DOM 快照、点击、输入、滚动、悬停、双击、文件上传、原生对话框预挂载、多标签页调度、截图到控制台与网络请求诊断的全流程操作。
- **多客户端并发隔离与租约锁**：多个 Codex 或 Agent 任务并发访问同一浏览器时，各客户端严格隔离专属标签页，通过 Profile 级排他文件锁与客户端活跃租约（Lease）协调生命周期，杜绝跨会话误关标签或进程冲突。
- **零凭据与隐私零泄露设计**：
  - 绝不向大模型泄露 Cookies、Local Storage、Session Storage、密码字段明文或敏感请求体。
  - URL 中的敏感查询参数（`token`, `password`, `key` 等）自动脱敏。
  - 严禁 `file:`, `data:`, `javascript:` 伪协议导航，CDP 调试端口默认强制绑定回环地址 `127.0.0.1`。
- **人机协同验证与接管（Handoff）**：遇到 Cloudflare Turnstile、CAPTCHA 人机验证码或扫码登录时，模型自动识别并挂起自动化操作，提示人类在当前可视窗口完成验证后再无缝继续任务，避免封号与无意义重试。
- **独立环境配置解耦**：MCP 模式完全解耦大模型 API Key（仅读取 `.env.mcp` 浏览器配置），API 调用由宿主 IDE 全权负责；CLI 模式单独通过 `.env` 管理 API 凭证。
- **完善的测试与诊断机制**：自带 58 项单元与集成测试，配套针对浏览器 CDP 通信、Responses API 端点兼容性、MCP 多客户端并发的自动化体检脚本。

---

## 架构与运行模式

本项目提供两种独立而互补的工作模式：

```mermaid
graph TD
    subgraph 模式一：MCP 协议桥接
        A[VS Code Codex / Cursor / Claude Desktop] -->|标准 stdio JSON-RPC| B(src/mcp-server.mjs)
        B -->|CDP 协议 / 端口 9333| C[专用 Microsoft Edge / Chrome Profile]
    end

    subgraph 模式二：独立 CLI Responses Agent
        D[npm start / CLI] -->|读取 .env| E(src/responses-agent.mjs)
        E -->|OpenAI Responses API| F[OpenAI / 兼容第三方服务]
        E -->|CDP 协议 / 端口 9222| C
    end
```

### 模式一：Stdio MCP 服务器（推荐日常搭配 Agent IDE 使用）

- **工作方式**：作为宿主开发工具（如 Codex、Cursor 等）的子进程运行，通过标准输入输出（stdio）遵循 MCP 协议通信。
- **凭据要求**：**不需要**填写 `OPENAI_API_KEY`。大模型的调度推理由宿主环境完成，MCP 服务器仅负责在本机可靠控制浏览器。
- **配置隔离**：只读取专门的 `.env.mcp` 浏览器启动配置，不读取含模型密钥的 `.env`。
- **端口与数据目录**：默认监听回环地址 `http://127.0.0.1:9333`，使用项目内的独立专用资料目录 `.mcp-edge-profile`，绝不污染你日常上网的 Edge/Chrome 用户数据。

### 模式二：独立 Responses API Agent CLI（自动化终端代理）

- **工作方式**：命令行自主执行任务的完整 Agent 循环。
- **凭据要求**：需要配置 `.env` 文件中的 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `OPENAI_MODEL`。
- **协议兼容性**：支持官方 OpenAI Responses API，也支持实现相同 `tools` / `function_call` 规范的第三方端点。内置 `RESPONSES_STATE_MODE=manual` 与 `RESPONSES_COMPAT_MODE=minimal` 等选项，以适配各类不完全兼容的第三方中继 API。
- **端口与数据目录**：默认监听 `http://127.0.0.1:9222`，资料目录保存在 `%LOCALAPPDATA%\ResponsesEdgeProfile`。

---

## 快速开始

### 环境准备

1. **操作系统**：Windows 10/11（推荐，内置 Edge 支持最好），也可运行于 macOS / Linux（需配置对应 Edge 或 Chrome 可执行路径）。
2. **Node.js**：`>= 20.0.0`。
3. **已安装浏览器**：Microsoft Edge 或 Google Chrome。

### 安装步骤

1. 克隆代码仓库并安装依赖：
   ```powershell
   git clone https://github.com/OwlCt/browser-skill.git
   cd browser-skill
   npm install
   ```

2. 运行完整测试套件，验证环境一切正常：
   ```powershell
   npm test
   ```
   所有 58 项测试应全部通过（`pass 58, fail 0`）。

3. 初始化配置文件：
   - **如果打算使用 MCP 模式（如配合 Codex）**：
     检查并确认项目根目录下的 `.env.mcp` 配置即可（默认开箱即用，指向专用 Profile 与 9333 端口）。
   - **如果打算使用 CLI 模式（直接运行任务）**：
     ```powershell
     Copy-Item .env.example .env
     ```
     编辑 `.env`，填入你的大模型提供商凭据：
     ```dotenv
     OPENAI_API_KEY=sk-xxxxxx
     OPENAI_BASE_URL=https://api.openai.com/v1
     OPENAI_MODEL=gpt-5.6
     ```
     执行端点兼容性体检：
     ```powershell
     npm run doctor:api
     ```

---

## MCP 客户端接入配置

### VS Code Codex

本项目提供了一键注册脚本，能够自动解析宿主环境并写入 Codex 配置。

1. **注册 MCP 服务**：
   ```powershell
   npm run mcp:install
   ```

2. **检查注册状态**：
   ```powershell
   npm run mcp:status
   ```
   输出中显示 `responses_edge_browser` 且状态为 `enabled` 即代表注册成功。

3. **完全重启 VS Code / Codex**，在对话中直接发送指令测试：
   > "使用 responses_edge_browser 打开 https://example.com 并读取页面标题"

   Codex 会自动将服务名与工具名前缀组合为 `mcp__responses_edge_browser__browser_*` 进行调用。

> [!NOTE]
> Windows 工作区沙箱说明：在部分沙箱中执行命令时，环境可能以沙箱身份运行，导致读取到另一套配置文件。安装脚本内置了沙箱环境探测，如提示不一致请在 Windows 桌面原生 PowerShell 宿主环境中执行安装。

### CC Switch 管理 Codex

若你使用 **CC Switch** 集中管理 Codex 的配置与供应商切换，请将 `responses_edge_browser` 配置持久化保留在 CC Switch 的 Codex 通用配置及 MCP 统一列表中（避免在切换供应商时被覆盖）：

```toml
[mcp_servers.responses_edge_browser]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\vscode\browser-skill\src\mcp-server.mjs']
cwd = 'C:\vscode\browser-skill'
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 120
```

### Cursor

在 Cursor 中通过 `Settings -> Features -> MCP` 添加新服务，或者在项目或全局的 `.cursor/mcp.json` 中配置：

```json
{
  "mcpServers": {
    "responses_edge_browser": {
      "command": "node",
      "args": ["C:/vscode/browser-skill/src/mcp-server.mjs"],
      "cwd": "C:/vscode/browser-skill"
    }
  }
}
```

### Claude Desktop / Windsurf

在 `claude_desktop_config.json` 中的 `mcpServers` 对象下添加：

```json
{
  "mcpServers": {
    "responses_edge_browser": {
      "command": "node",
      "args": ["C:/vscode/browser-skill/src/mcp-server.mjs"],
      "cwd": "C:/vscode/browser-skill"
    }
  }
}
```

---

## 工具集完整清单（21 个专用工具）

所有工具均具备类型严格的 JSON Schema 校验，并遵循原子性操作原则。

### 1. 页面导航与感知

| 工具名称 | 参数 | 说明 |
| :--- | :--- | :--- |
| `browser_navigate` | `url` (string, 必填) | 在当前活动标签页导航到指定的绝对 HTTP(S) URL，并返回最新的页面状态快照。 |
| `browser_snapshot` | 无 | 获取当前页面的完整语义快照（包括 URL、标题、可见文本摘要、滚动进度及带编号的可交互元素，如 `e1`, `e2`，同源 iframe 元素形如 `f1e2`）。 |
| `browser_history` | `action`: `"back"` \| `"reload"` | 执行浏览器后退或重新加载当前页面。 |
| `browser_wait` | `milliseconds` (0~30000)<br>`text` (string)<br>`url` (string)<br>`load_state`: `"none"` \| `"domcontentloaded"` \| `"load"` \| `"networkidle"` | 等待页面满足特定条件（指定文本出现、URL 变更或特定网络加载状态），超时后返回最新快照。 |
| `browser_screenshot` | `full_page` (boolean, 必填) | 捕获当前页面截图。默认保存为 `artifacts/` 目录下的 PNG 文件；当配置 `BROWSER_INLINE_SCREENSHOTS=true` 时可直接返回图像数据。 |

### 2. 页面元素交互

| 工具名称 | 参数 | 说明 |
| :--- | :--- | :--- |
| `browser_click` | `ref` (string, 必填) | 点击快照中标识的可交互元素（如 `e3` 或 `f1e2`）。 |
| `browser_type` | `ref` (string)<br>`text` (string)<br>`submit` (boolean) | 在可编辑元素中填充文本内容。**自动阻止向密码输入框填充明文**；可选在填充后按 Enter 提交。 |
| `browser_press` | `ref` (string)<br>`key` (string) | 在目标元素上按下指定按键或组合键（例如 `Enter`, `Escape`, `ArrowDown`, `Control+A`）。 |
| `browser_select` | `ref` (string)<br>`value` (string) | 根据指定的选项 value 值选择 `<select>` 下拉菜单中的选项。 |
| `browser_scroll` | `direction`: `"up"` \| `"down"`<br>`amount` (50~3000) | 在活动页面上按指定像素垂直滚动内容。 |
| `browser_hover` | `ref` (string, 必填) | 将鼠标指针悬停在指定元素上方（常用于唤起悬浮菜单、Tooltip 等）。 |
| `browser_double_click` | `ref` (string, 必填) | 双击快照中指定的元素。 |
| `browser_file` | `ref` (string)<br>`path` (string) | 为 `<input type="file">` 元素选择本机文件以上传。支持绝对路径或项目相对路径，上传内容绝不会被倒读给模型。 |
| `browser_dialog` | `action`: `"status"` \| `"arm"`<br>`decision`: `"keep"` \| `"accept"` \| `"dismiss"`<br>`prompt_text` (string) | 预挂载对下一个原生 `alert`、`confirm` 或 `prompt` 弹窗的处理策略。**未预挂载的弹窗将被自动取消（dismiss）**，防止页面永久挂起。 |

### 3. 多标签页会话管理

| 工具名称 | 参数 | 说明 |
| :--- | :--- | :--- |
| `browser_tabs` | `action`: `"list"` \| `"new"` \| `"switch"` \| `"close"`<br>`tab_id` (string)<br>`url` (string) | 管理当前客户端拥有的标签页。支持查看列表、新建、切换或关闭标签。 |

- **标签隔离原则**：每个 MCP 客户端只能看到和操作自己创建的标签页。
- **自动弹窗清理**：非显式调用的 `window.open` 弹窗会自动回收旧页面，始终仅保留最新一个；只有调用 `browser_tabs new` 显式创建的标签才会常驻。
- **闲置回收机制**：由 `EDGE_TAB_IDLE_TIMEOUT_MS` 控制；客户端断开连接时，其所有的独占标签页均会被安全清理，不影响其他客户端。

### 4. 只读诊断与调试

为了兼顾开发者排错需要与安全红线，下列诊断工具遵循**严格只读**原则，杜绝代码注入或敏感数据嗅探：

| 工具名称 | 参数 | 说明 |
| :--- | :--- | :--- |
| `browser_console` | `action`: `"list"` \| `"clear"`<br>`level`: `"all"` \| `"error"` \| `"warning"` \| `"info"` \| `"log"` | 读取或清空控制台最近的输出日志与页面报错信息。**不执行任何页面 JS 脚本**。 |
| `browser_network` | `action`: `"list"` \| `"clear"`<br>`limit` (1~100) | 查看最近网络请求的元数据（请求方法、URL、资源类型、状态码）。**严格过滤并剥离 Request/Response Body、Cookies 与 Headers**。 |
| `browser_styles` | `ref` (string, 必填) | 读取指定元素的一组固定计算样式（display, position, color, margin 等）与尺寸布局信息。 |

### 5. 运行时控制与安全接管

| 工具名称 | 参数 | 说明 |
| :--- | :--- | :--- |
| `browser_runtime` | 多字段（详情见下文） | 在运行过程中动态查询或调整浏览器启动参数（Edge/Chrome、有头/无头、窗口大小、扩展、Profile 目录等），无需重启服务或改动配置文件。 |
| `browser_site` | `action`: `"status"` \| `"decide"`<br>`origin` (string)<br>`decision`: `"keep"` \| `"allow_once"` \| `"allow"` \| `"block"` | 当站点安全策略开启为 `ask` 模式时，针对未经允许的公共域名进行授权决策（本次允许、永久允许、阻止）。 |
| `browser_handoff` | `action`: `"status"` \| `"pause"` \| `"resume"` | 遇到人机验证（Cloudflare、CAPTCHA、2FA）或扫码登录时，主动挂起自动化交互，移交由人工在原生窗口中完成验证，完成后恢复执行。 |

---

## 核心机制深入解析

### 动态运行时控制（browser_runtime）

在 Agent 交互过程中，经常遇到需要改变窗口大小、启用无头后台运行、加载浏览器扩展或切换至 Chrome 的场景。使用 `browser_runtime` 工具无需手动停止服务或修改配置文件：

- **保持原样传参**：不希望改变的属性直接传入 `"keep"`。
- **持久化配置**：成功应用的变更会自动写入 `.runtime/browser.json`，在下一次受管启动时继续生效。
- **支持变更的项目**：
  - `browser`：`edge` 或 `chrome`。
  - `headless`：`true` 或 `false`。若已有打开的实例，服务会在无并发活动客户端时安全重启。
  - `load_extensions`：是否启用已安装的浏览器扩展（移除 `--disable-extensions`）。
  - `stealth`：实验性防检测开关，省略 `--enable-automation` 标志（注：不伪造 Canvas/WebGL，不承诺 100% 绕过高风控反爬）。
  - `connection_mode`：`managed`（由服务管理启停）或 `attach`（仅连接现有回环 CDP，不主动接管生命周期）。
  - `profile_target`：`dedicated`（默认独立 Profile）、`user`（系统用户原生 Profile）或 `custom`（自定义路径）。切换到非专用 Profile 时必须明确附加 `confirm_external_profile: "true"`。
  - `window`：设定固定窗口大小，如 `1280x720`；传入 `default` 恢复系统默认。
  - `bring_to_front`：是否在操作时强制将浏览器窗口激活并置顶。

### Profile 隔离与多客户端租约机制

为了保证开发时的绝对稳定性，项目引入了严密的生命周期与并发控制层（`src/edge-lifecycle.mjs`）：

1. **专用 Profile**：默认将配置与存储隔离在项目内的 `.mcp-edge-profile`，冷启动时只清空上次遗留的未关闭标签页，保留所有 Cookie、登录态与缓存，绝不影响开发者的个人日常浏览器。
2. **Profile 排他文件锁**：防止两个独立的 MCP 进程在同个端口和数据目录下产生文件冲突。
3. **活动租约（Lease）管理**：每个连接的 MCP 客户端持有一份带心跳的时间戳租约。
4. **协同退出**：只有当 `EDGE_KEEP_OPEN=false` 且**最后一个活跃客户端退出**时，MCP 服务才会关闭受管浏览器；任何非托管（attach）模式下接入的外部浏览器绝不会被本程序关闭。

### 安全架构与零凭证泄露原则

本项目的核心设计理念之一是**防范 Prompt 注入攻击与数据外泄**：

- **拒绝敏感存储读取**：不提供获取 Cookies、LocalStorage、IndexedDB 的指令。
- **密码保护**：`browser_type` 内部识别 `input[type="password"]` 并直接抛出拒绝异常。
- **查询参数脱敏**：导航和页面状态中的 URL 若包含 `access_token`、`secret`、`password` 等关键字，其参数值在返回给模型前会被强制抹除为 `[redacted]`。
- **严格协议白名单**：杜绝通过 `file:///` 读取本地文件、通过 `data:text/html` 注入恶意脚本，或者触发 `javascript:...` 执行。

### 人机协同验证（browser_handoff）

自动化爬虫与 Agent 最忌讳陷入反爬死循环。系统在快照分析中内置了对 Cloudflare Turnstile、reCAPTCHA、hCaptcha 及安全验证文本的正则特征检测：

1. 检测到验证拦截页或登录界面时，Agent 自动感知并**停止所有机械重试**。
2. 调用 `browser_handoff pause` 挂起任务，并在对话中向用户发出明确提示。
3. 用户在弹出的有头浏览器窗口中完成人工打勾、滑块或两步验证。
4. 用户通知 Agent 后，Agent 调用 `browser_handoff resume` 确认页面已放行并继续后续工作流程。

### 站点访问白名单策略（browser_site）

当环境变量配置 `BROWSER_SITE_POLICY=ask`（默认）时：
- 所有本机回环地址（`localhost`、`127.0.0.1`）以及在 `BROWSER_ALLOWED_ORIGINS` 中声明的源默认直接放行。
- 一旦访问任何新的外部公网源（例如 `https://github.com`），导航将直接抛出授权请求。
- 模型必须向用户明确展示目标域名，并在获得人类首肯后调用 `browser_site`：
  - `allow_once`：仅在本次 MCP 会话周期内有效。
  - `allow`：永久写入 `.runtime/site-policy.json`，后续直接允许。
  - `block`：持久记录阻止状态，后续尝试将被立即拦截。

若需要恢复无限制导航模式，将 `.env.mcp` 中的 `BROWSER_SITE_POLICY` 设为 `allow` 即可。

---

## 配置参数参考（.env 与 .env.mcp）

下表列出所有关键环境变量的作用与默认行为：

| 变量名称 | 适用模式 | 默认值 | 详细说明 |
| :--- | :--- | :--- | :--- |
| `OPENAI_API_KEY` | CLI | 空 | 大模型提供商 API 密钥（MCP 模式下不使用此变量）。 |
| `OPENAI_BASE_URL` | CLI | `https://api.openai.com/v1` | Responses 接口地址。 |
| `OPENAI_MODEL` | CLI | `gpt-5.6` | 调用的模型名称。 |
| `RESPONSES_STATE_MODE` | CLI | `manual` | Responses 历史状态模式：`manual` 重发历史消息（兼容性最好）；`previous` 使用服务端 `previous_response_id`。 |
| `RESPONSES_COMPAT_MODE` | CLI | `standard` | 协议兼容级别：`standard` 发送完整字段；`minimal` 剥离 `store`、`strict` 等字段，适配部分非标第三方中继。 |
| `BROWSER_PRODUCT` | 全部 | `edge` | 浏览器引擎产品：`edge` 或 `chrome`。 |
| `EDGE_CDP_URL` | 全部 | `http://127.0.0.1:9333` (MCP)<br>`http://127.0.0.1:9222` (CLI) | CDP 调试协议监听地址。出于安全考量，默认必须是回环地址。 |
| `EDGE_USER_DATA_DIR` | 全部 | `.mcp-edge-profile` | 浏览器 Profile 数据存储路径。 |
| `EDGE_HEADLESS` | 全部 | `false` | 是否开启无头模式。`false` 会弹出原生可视窗口，方便观察与人工接管；`true` 在后台隐式运行。 |
| `EDGE_BRING_TO_FRONT` | 全部 | `true` | 进行导航或关键操作时，是否自动将浏览器窗口与标签页置顶激活。 |
| `EDGE_KEEP_OPEN` | 全部 | `true` | 会话任务结束后是否保持浏览器开启，避免频繁销毁与冷启动。 |
| `EDGE_AUTO_CLOSE_TABS` | 全部 | `true` (MCP) | 是否自动清理未被显式保留的孤立弹窗页面。 |
| `EDGE_CLEAR_SESSION_TABS_ON_START` | 全部 | `true` (MCP) | 冷启动时清空上一轮遗留的标签页，但不清除 Cookie 或登录凭据。 |
| `EDGE_TAB_IDLE_TIMEOUT_MS` | 全部 | `0` | 标签页闲置自动回收时间（毫秒）。`0` 代表禁用闲置回收。 |
| `BROWSER_SITE_POLICY` | 全部 | `ask` | 外部域名访问策略：`ask`（访问非回环地址需人工授权）或 `allow`（直接放行）。 |
| `BROWSER_ALLOWED_ORIGINS` | 全部 | 空 | 预先信任的源白名单，以逗号分隔，例如 `https://github.com,https://api.example.com`。 |
| `BROWSER_INLINE_SCREENSHOTS` | 全部 | `true` (MCP)<br>`false` (CLI) | 是否将截图以 Multimodal Base64 格式内联返回给模型。 |
| `BROWSER_ARTIFACTS_DIR` | 全部 | `artifacts` | 屏幕截图与页面下载文件的本地保存目录。 |

---

## 诊断、测试与排错工具

本项目提供全方位的诊断命令，帮助你在遇到任何问题时迅速定位：

### 测试套件（npm test）

运行内置的 58 个自动化单元与集成测试（覆盖所有工具方法、生命周期锁、会话隔离与策略验证）：

```powershell
npm test
```

### 体检工具（Doctor 工具集）

1. **本地浏览器与 CDP 交互体检**：
   ```powershell
   npm run doctor
   ```
   检查 Edge/Chrome 可执行文件路径、CDP 通信、自动创建测试页面并验证语义快照提取、输入、点击等基础闭环。

2. **Responses API 端点兼容性体验**：
   ```powershell
   npm run doctor:api
   ```
   向配置的 `OPENAI_BASE_URL` 发送测试请求，验证模型是否能正确理解并返回本项目的 Function Calling 规范。

3. **MCP 协议多客户端与生命周期体检**：
   ```powershell
   npm run doctor:mcp
   ```
   在当前配置环境下，启动真实的 Stdio MCP 服务，模拟两个独立的并发客户端验证多标签隔离、弹窗回收与截图生成。

4. **沙箱隔离级 MCP 体检**：
   ```powershell
   npm run doctor:mcp -- --isolated
   ```
   使用随机空闲端口、独立临时目录和无头模式执行上述测试，彻底验证最后一个客户端退出后的进程回收机制，不会触动你的日常配置。

### 安全关闭受管浏览器

若因调试需要强行关闭当前 MCP 占用的浏览器实例：

```powershell
npm run edge:mcp:stop
```

> [!CAUTION]
> 仅在没有其他活动 Codex/Agent 会话时执行此命令，否则会导致其他正在进行中的浏览任务中断。

---

## 常见问题与排错（FAQ）

### Q1: 在 Codex 中调用工具提示 `Tool not found` 或没看到浏览器工具？
1. 执行 `npm run mcp:status` 确保 `responses_edge_browser` 为 `enabled`。
2. 完全退出并重新启动 VS Code（而不仅仅是重载窗口）。
3. 检查 Codex 提示词是否指定了正确的服务名前缀，通常调用为 `mcp__responses_edge_browser__browser_navigate`。

### Q2: 为什么提示 `Origin ... is not in BROWSER_ALLOWED_ORIGINS` 或 `Site approval required`？
这是默认的安全策略生效的表现。当配置为 `BROWSER_SITE_POLICY=ask` 时，访问新的外部网站需要向用户请求授权。模型会调用 `browser_site` 记录你的决定。如果你希望免受打扰，可以在 `.env.mcp` 中设置 `BROWSER_SITE_POLICY=allow`。

### Q3: 为什么导航到某些网页时停下来不操作了？
请查看终端输出或页面状态。如果网页出现了 Cloudflare 人机挑战（Turnstile/Captcha）或登录页，系统触发了安全保护机制并调用了 `browser_handoff pause`。请在弹出的浏览器中手动点击完成验证，然后再让 Agent 继续执行。

### Q4: 如何从 Edge 切换到 Google Chrome？
无需改动代码，在对话中直接让 Agent 调用 `browser_runtime` 将 `browser` 设为 `chrome`，或在 `.env.mcp` 中将 `BROWSER_PRODUCT=chrome`，系统将自动寻址本机的 Chrome 可执行文件并使用独立的 `.mcp-chrome-profile` 资料目录。

### Q5: 遇到端口占用或 `EADDRINUSE` 错误？
确认是否有残留的旧 Edge/Chrome 调试实例未完全退出。你可以运行 `npm run edge:mcp:stop`，或在任务管理器中结束对应端口的 `msedge.exe` / `chrome.exe` 进程。

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
