# dsh-plugin-grok-balance-ultimate

[English](#english) | [中文](#中文)

<a id="english"></a>
Grok subscription integration for the DeepSeek Harness Web GUI: sign in with
your xAI account, watch usage on a dedicated page, search the web through the
subscription, and chat with Grok models — no API key pasted anywhere.

## What it does

- **OAuth login** through the xAI device flow (`auth.x.ai`): click **Sign in
  to Grok**, approve in the browser tab, done. The login is stored in the
  grok-build-compatible `~/.grok/auth.json` (one scope; other scopes are left
  untouched), so the native Grok CLI and this plugin share one session.
- **Usage page** (sidebar entry) over the same account surfaces grok-build
  reads: credit-usage percent, the current billing period with a reset
  countdown, prepaid balance, per-cycle history, the auto top-up rule, and
  the active subscription tier.
- **Composer credit ring**: one compact ring on the conversation composer
  shows the remaining credit for Grok-model sessions; the popover adds the
  period countdown, balance, and links to the page and the SuperGrok console.
- **Grok LLM route**: after sign-in the `grok` provider offers `grok-4.7`,
  `grok-4.7-build-fast`, `grok-4.6`, and `grok-4.5` (500k context) in the Models page — inference rides the
  subscription token (`cli-chat-proxy.grok.com`), refreshed in the
  background. An API-key mode (`XAI_API_KEY`) remains available.
- **Subscription web search**: registers a `grok` web-search provider on the
  harness web seam. On Grok-model sessions, `web_search` runs through the
  subscription (server-side `web_search` tool with citations) instead of
  failing on a missing DeepSeek API key.
- **Models settings row**: a **Grok account** row at the bottom of
  Settings → Models mirrors the DeepSeek account row — sign-in state, account
  e-mail, expiry, sign-out.

## Install

```sh
dsh plugin --profile web add /absolute/path/to/dsh-plugin-grok-balance-ultimate
```

Refresh the Web GUI (F5) after installing; the sidebar entry **Grok usage**
appears.

## First-time setup

1. Open the sidebar page **Grok usage**.
2. Click **Sign in to Grok**. A new browser tab opens the xAI consent page;
   the page shows the confirmation code and a countdown while the Host polls.
3. The page switches to the dashboard: tier, credit percent, period, balance,
   and history load immediately. The Grok provider appears on the Models page
   and is usable without any key.

## Configuration

Persisted in `$DSH_HOME/grok-balance.json`; editable from the page's settings
card.

| Key | Default | Meaning |
| --- | --- | --- |
| `refreshMinutes` | `30` | Background usage refresh interval. |
| `showIndicatorWhenLoggedOut` | `false` | Keep the composer ring mounted while signed out. |
| `webSearchEnabled` | `true` | Register the `grok` web-search provider. |
| `searchModel` | `grok-4.6` | Model used for the auxiliary search request. |
| `proxyUrl` | `""` | HTTP(S) proxy for all xAI traffic; empty honors the proxy environment. |

## How it works

- The Host half mounts same-origin routes under `/grok-balance` (status,
  login, login poll, logout, config, overview). Every route re-uses the
  connection carrier's browser-session gate, so a LAN peer that reaches the
  port cannot read account data.
- The OAuth flow follows grok-build's protocol: device code at
  `/oauth2/device/code`, token polling at the discovery-provided token
  endpoint, refresh-token rotation inside the final minute of the token TTL,
  and the `grok-shell/1.0.45` client identity on every upstream call.
- Account surfaces live on the subscription proxy:
  `GET /billing?format=credits`, `GET /user?include=subscription`, and
  `GET /auto-topup-rule`. Responses are normalized defensively; a failing
  surface never blanks the page, and a total failure serves the last good
  snapshot marked stale.
- Web search issues one `POST /responses` request with the server-side
  `web_search` tool and collects `url_citation` annotations as sources.

## Security notes

- Tokens live in `~/.grok/auth.json` (mode 0600, the same file grok-build
  uses). They never enter the Harness settings document, a session log, or a
  plugin route response.
- Sign out before uninstalling. DSH has no uninstall callback; a removed
  plugin cannot delete its login. Without a sign-out, remove the plugin's
  scope entry from `~/.grok/auth.json` manually (or run `grok logout`).

## Troubleshooting

- **Login expires repeatedly** — the refresh token rotates on every refresh;
  if the native Grok CLI is signed in with the same scope, both clients share
  one login and refresh cooperatively. Signing out in one signs out both.
- **web_search says insufficient quota** — the subscription covers search;
  an API-key Grok deployment pays per search. Check the deployment mode.
- **No usage numbers** — the account surfaces need a Grok subscription
  (SuperGrok); a plain xAI API-key account has no billing document.

## Development

```sh
npm install --include=dev
npm run build:client   # bundle src/client -> lib/client.js (esbuild)
npm test               # node --test tests/host/*.test.mjs tests/client/*.test.mjs
```

## Known limits

- Usage data ends where xAI's surfaces end: no per-model breakdown, no MCP
  or tool usage, no reset-opportunity mechanics (there is nothing to reset).
- The composer ring shows the credit percent only; Grok has no multi-window
  quota like the BigModel Coding Plan.
- API-key inference mode sends a bare `Authorization: Bearer` header; the
  subscription handshake headers are subscription-only.

<a id="中文"></a>
# dsh-plugin-grok-balance-ultimate（中文）

Grok 订阅集成插件（DeepSeek Harness Web GUI）：用 xAI 账号 OAuth 登录，在独立页面查看用量，用订阅完成联网搜索，直接对话 Grok 模型——全程不需要粘贴任何 API key。

## 功能

- **OAuth 登录**：走 xAI 设备码流程（`auth.x.ai`），点击「登录 Grok」、在浏览器标签页确认即可。登录写入 grok-build 兼容的 `~/.grok/auth.json`（插件只占一个 scope，其它 scope 原样保留），原生 Grok CLI 与本插件共享同一会话。
- **用量页**（侧边栏入口）：读取 grok-build 同源的账户接口——额度使用百分比、当前计费周期与重置倒计时、预付费余额、按周期用量历史、自动充值规则、生效的订阅档位。
- **输入框额度环**：Grok 模型会话的输入框旁一个紧凑圆环显示剩余额度；浮窗补充周期倒计时、余额、页面与 SuperGrok 控制台入口。
- **Grok 模型路由**：登录后 Models 页出现 `grok` 供应商（`grok-4.7` / `grok-4.7-build-fast` / `grok-4.6` / `grok-4.5`，50 万上下文）——推理走订阅令牌（`cli-chat-proxy.grok.com`），后台自动刷新；也保留 API key 模式（`XAI_API_KEY`）。
- **订阅联网搜索**：向 Harness web 接缝注册 `grok` 搜索 provider。Grok 模型会话的 `web_search` 走订阅（服务端 `web_search` 工具 + 引用），不再因缺少 DeepSeek API key 而失败。
- **模型设置横栏**：设置 → 模型 底部的「Grok 账号」横栏与 DeepSeek 账号横栏同款——登录状态、账号邮箱、有效期、退出登录。

## 安装

```sh
dsh plugin --profile web add /dsh-plugin-grok-balance-ultimate 的绝对路径
```

安装后刷新 Web GUI（F5），侧边栏出现「Grok 用量」入口。

## 首次使用

1. 打开侧边栏「Grok 用量」页面。
2. 点击「登录 Grok」，新标签页打开 xAI 确认页；页面显示确认码与倒计时，Host 后台轮询。
3. 授权后自动进入面板：档位、额度百分比、周期、余额、历史立即加载。Models 页出现 Grok 供应商，无需任何密钥即可选择对话。

## 配置

保存在 `$DSH_HOME/grok-balance.json`，可在页面设置卡片修改。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `refreshMinutes` | `30` | 后台用量刷新间隔（分钟）。 |
| `showIndicatorWhenLoggedOut` | `false` | 未登录时也保留输入框额度环。 |
| `webSearchEnabled` | `true` | 是否注册 `grok` 联网搜索 provider。 |
| `searchModel` | `grok-4.6` | 辅助搜索请求使用的模型。 |
| `proxyUrl` | `""` | xAI 流量的 HTTP(S) 代理；留空时按代理环境变量。 |

## 工作原理

- Host 半边在 `/grok-balance` 下挂同源路由（status、login、login poll、logout、config、overview）。每条路由复用连接层的浏览器会话门禁，局域网内其它设备无法读取账户数据。
- OAuth 严格遵循 grok-build 协议：`/oauth2/device/code` 申请设备码、discovery 提供的 token 端点轮询、令牌到期前最后一分钟轮换 refresh token、每个上游请求带 `grok-shell/1.0.45` 客户端身份。
- 账户接口在订阅代理上：`GET /billing?format=credits`、`GET /user?include=subscription`、`GET /auto-topup-rule`。响应做防御式归一化；单个接口失败不会清空页面，整体失败时回退到标记为过期的最后一份好数据。
- 联网搜索发一次带服务端 `web_search` 工具的 `POST /responses` 请求，从 `url_citation` 注解提取引用来源。

## 安全说明

- 令牌只存在于 `~/.grok/auth.json`（0600，与 grok-build 同一文件）。不进 Harness 设置文档、不进会话日志、不进插件路由响应。
- 卸载前先退出登录。DSH 没有卸载回调，插件被移除后无法清理登录；若忘记退出，请手动删除 `~/.grok/auth.json` 中本插件的 scope 条目（或执行 `grok logout`）。

## 故障排查

- **登录频繁过期** —— refresh token 每次刷新都会轮换；若原生 Grok CLI 用同一 scope 登录，两个客户端共享同一登录并协同刷新，一端退出即两端退出。
- **web_search 提示配额不足** —— 订阅已包含搜索；API key 模式的 Grok 部署按次计费，请检查部署模式。
- **看不到用量** —— 账户接口需要 Grok 订阅（SuperGrok）；纯 xAI API key 账号没有账单文档。

## 开发

```sh
npm install --include=dev
npm run build:client   # 将 src/client 打包为 lib/client.js（esbuild）
npm test               # node --test tests/host/*.test.mjs tests/client/*.test.mjs
```

## 已知限制

- 用量数据止步于 xAI 的接口：没有按模型明细、没有 MCP/工具用量、没有重置机会机制（Grok 没有可重置的额度）。
- 输入框额度环只显示额度百分比；Grok 没有 BigModel 编程套餐那样的多时间窗配额。
- API key 推理模式只发裸 `Authorization: Bearer`；订阅握手头仅订阅模式使用。
