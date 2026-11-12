# AGENTS.md —— 给 AI 执行者的入口

这个仓库只做一件事：把 free-pi（`api.freepi.ai`）的免费模型池接进 magpie，
取代同工作区的 `freepi-proxy/freepi_proxy.py`。

## 命令

```bash
npm test          # 59 个单元测试
npm run check     # 入口唯一函数 / 模型能力布尔值 / 无本机路径
npm run probe     # 真机探测（花少量额度）
# FREEPI_TOKEN=... node scripts/probe-live.mjs
# node scripts/probe-live.mjs --accounts <accounts.json>
```

## 六条不能改坏的规则

1. **广告按 CLI 的 turn 节奏**：session start / 每个新用户消息取一条 `banner` +
   `/ads/impression`；每 5 个用户轮次再取一条 `inline`；banner 是 Gravity 时跳过
   inline。没有 150s 定时器，也没有定时退避 —— 全部在 `src/ads.mjs`。
2. **`maxConcurrency: 1`**：服务端同一账号只允许 1 个并发请求。多账号是 magpie 的事，
   不要把插件改成内部账号池 —— 那样会绕过 magpie 的额度路由。
3. **429 与 401 的语义不能混**：
   - `401` → `session_expired`，让 magpie 标记账号；
   - `429 concurrent` → 同账号短退避重试，耗尽后回 `429 rate_limited`，让 magpie 换号；
   - `429/409 concurrent_session` → `/session/reset` 后重试；
   - `402/403/429 ads_required` → 同步补刷广告后重试。
4. **成功的流式 Response 不读 body**：`src/relay.mjs` 在 `status === 200` 时直接返回，
   读 SSE 会把流读干。只有非 200 才读文本拿 code/message。
5. **没有 refresh 端点**：token 是 90 天 JWT。不要伪造续期；过期后 401 即可。
6. **模型表来自官方 CLI 的 `/client-version`**：`src/catalog.mjs` 调
   `GET /client-version`，按 `free` / `usage_x` / `section` / `note` 生成条目，
   过滤 `unavailable: true`（当前是 2 个 Gemini）。拉不到才回退
   `src/provider.mjs` 的 `MODEL_DEFS`（17 个可用模型）。上下文/输出/reasoning/工具/成本
   按 CLI：**context 200000 / output 8192 / reasoning=true / 工具由 agent 提供 / cost 0**。
   **输入模态不照抄 CLI 的 text**（它走自己的 vision 工具）：`MODEL_INPUTS` 里 4 个模型
   支持图片/视频/音频，其余 text-only。`free` 只给目录里 `free: true` 的 4 个，其余用
   `rate: "xN"`；不要自己从倍率反推免费。

## 文件

| 文件 | 管什么 |
|---|---|
| `index.mjs` | 钩子装配，不放协议细节 |
| `src/provider.mjs` | 地址、请求头、模型表、图标 |
| `src/auth.mjs` | JWT、身份、设备码登录 |
| `src/client.mjs` | 所有 HTTP 请求的唯一出口 |
| `src/ads.mjs` | 广告保活调度器（按 token 记账） |
| `src/catalog.mjs` | `/client-version` 目录拉取、缓存、映射 |
| `src/relay.mjs` | 对话转发、重试、流式透传 |
| `src/usage.mjs` | `/me` → 额度窗口 |
| `src/errors.mjs` | 错误码与 OpenAI 形状错误体 |

## 官方 CLI（free-pi-cli 0.6.19）逆向要点

- 模型目录：`GET /client-version`（Bearer 可选，头 `x-freepi-cost-exp: 1`）→ `models[]`，每项
  `{id, name, display_name, free, usage_x, section?, note?, unavailable?, stats_id?}`；
  CLI 用 `section === "defense"` 把 Defense 拆成第二个 provider。
- 默认模型：CLI 用 `models[0].id`（当前目录第一条 main 是 `particle`）；插件同样按
  目录第一条 main 标 `default`，静态兜底也把 `particle` 放第一。
- provider 配置：`baseUrl = api.freepi.ai/v1`，请求头 `x-session-id` +
  `x-client-version`，模型统一 `contextWindow=200000`、`maxTokens=8192`、
  `input=["text"]`、`reasoning=true`、`cost=0`。⚠ 这是 CLI 的 agent 配置；Magpie 直接
  透传图片，所以插件按 `MODEL_INPUTS` 给 4 个模型标了图片/视频/音频。
- `/model_requires_credits`（young 账号用 Kimi）：映射 429，让宿主换 established 账号。
- 每个对话请求还会带 `x-turn-id`（turn UUID）；广告 `/ads/next` 带
  `x-turn-id` + `x-client-os/arch/timezone/locale`，`/ads/impression` 带 `x-session-id`。
- Gravity 广告：先 GET `imp_url`（只允许 `https://*.trygravity.ai|com`），
  成功发起后 `/ads/impression` 才带 `imp_fired: true`；其它来源省略该字段。
- 首次登录：设备码建立 session 后先 `POST /auth/consent`（`consent_version: "4"`）
  再轮询 `/auth/token`；新账号没有 consent 会拿到 `consent_required`。
  条款文本写在 README「登录与条款」，插件 UI 不再弹同意问题。
- 错误码词表里有 `context_ceiling`、`context_too_long`、`hourly_ceiling`、
  `rolling_cap`、`global_cap`、`queue_wait`、`daily_cap`、`concurrent`,
  `concurrent_session`、`ads_required`、`upgrade_required` 等；插件目前只
  特殊处理 concurrent / concurrent_session / ads_required，其余按 429/上游原文透传。

## 本机现状

- 安装方式：`magpie plugin add D:\AI\magpie\magpie-FreePI`（path 安装，改代码后重启 magpie 生效）。
- provider id：`freepi`；模型前缀：`freepi/<model>`。
- 已用 `freepi-proxy/accounts.json` 里的 token 登录，卡片账号 `999AAAXXX`。
- 与 Python 反代同时跑同一个 token 会互相抢并发；调试时只留一个。

## 上游协议要点（2026-11-12 实测）

见 `README.md` 与 `src/client.mjs` 的注释。关键端点：

```
POST /auth/github/device   → { session_id, user_code, verification_uri_complete, interval, expires_in }
POST /auth/token           → { token } / { code: "authorization_pending" }
GET  /me                   → { handle, tier, allowance_credits, remaining_credits_today, refill_at }
GET  /ads/next?slot=...    → { ad_id, click_token, ... }
POST /ads/impression       → { ok: true }
POST /session/reset        → { released }
POST /v1/chat/completions  → OpenAI 兼容
```

`code` 字段在错误 body 的顶层（`{"code":"concurrent",...}`），不是只在 `error.code` 里；
`src/relay.mjs` 两个位置都读。
