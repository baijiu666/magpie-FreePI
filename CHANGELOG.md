# Changelog

## 0.1.7 — 2026-11-12

- 恢复多模态输入：`deepseek-v4.1-flash`（文本/图片）、`glm-5.3-flash`（文本/图片/视频）、
  `kimi-k3.1-pro`（文本/图片/视频）、`mimo-v2.6-flash`（文本/图片/音频/视频）。
  之前照抄 CLI 的 `input=["text"]` 是错的 —— 那是 CLI 自己走 vision 工具的配置；
  Magpie 直接透传图片，按实测/站点详情页标注。上下文/输出/reasoning/工具仍按 CLI。
- `kimi-k3.1-pro` 在 `young` 账号上会 403 `model_requires_credits`；插件把它映射成
  429 `rate_limited`，让 Magpie 自动换一个 `established` 账号（实测 established 可跑）。
- 测试 59 个。

## 0.1.6 — 2026-11-12

- 去掉设备码登录里的条款 prompt（用量卡片上那块「同意并继续/不同意」）。
  条款移到 README「登录与条款」；登录时仍按 CLI 自动 `POST /auth/consent`（4）。
- 测试 57 个。

## 0.1.5 — 2026-11-12

- 修正广告节奏：**150 秒是旧 Python 反代的经验值，不是官方 CLI**。CLI 的真实行为是
  session start / 每个新用户消息取一条 banner + impression，每 5 个用户轮次取一条
  inline，banner 为 Gravity 时跳过 inline。插件改为同样的 turn 驱动，删掉 150s
  定时器和定时退避；tool 续轮沿用同一 turn id，不重复刷广告。
- 测试 58 个（广告测试按 turn 重写）。

## 0.1.4 — 2026-11-12

- 清理未使用代码：`DEVICE_TIMEOUT_MS`、`modelEntries` 导出、`_internal`、client 的
  `request`/`readJson` 暴露、广告的 `forceByToken` / `uid` / `lastSeen`、usage 的
  `clear`、`sleep` / `modelsResponse` / `CATALOG_TTL_MS` 的多余导出，以及
  `modelNotFound` / `concurrencyConflict` 两个从未使用的错误码。
- 全面对齐 CLI 的默认模型：按 `models[0].id`（当前 `particle`）标 default；
  静态兜底也把 `particle` 放第一。
- `/client-version` 请求补上 CLI 的 `x-freepi-cost-exp: 1`。
- 请求头严格对齐 CLI：`/auth/*`、`/me`、`/client-version`、`/ads/impression`
  不再带多余的 `x-client-*`；`/session/reset` 只带 authorization（与
  `/close-other-session` 一致）。
- 测试 60 个。

## 0.1.3 — 2026-11-12

- 去掉 `auth.checkin` 钩子：free-pi 没有每日签到，免费额度靠后台广告保活。
  之前返回 `inactive` 仍会让宿主在用量里画「立即签到」，现在整块入口消失。

## 0.1.2 — 2026-11-12

逆向官方 `free-pi-cli@0.6.19` 的 dist 后，把插件对齐到 CLI 的真实行为：

- **模型目录改为动态**：`provider.models` 调 `GET /client-version`，按官方的
  `free` / `usage_x` / `section` / `note` 生成条目，过滤 `unavailable`；
  10 分钟缓存，失败回 `MODEL_DEFS` 静态兜底（17 个可用模型）。
- **模型能力按 CLI 的 provider 配置统一**：context 200,000 / max output 8,192 /
  纯文本输入 / `reasoning: true` / 工具由 agent 提供 / `cost: 0`。
  不再使用网页的 1M 上下文与图片/视频模态声明（CLI 走自己的 vision 工具）。
- **对话请求头**：带 `x-session-id` + `x-client-version` + `x-turn-id`，与 CLI 的
  `buildProviderConfig` / turn header 扩展一致。
- **广告**：`/ads/next` 带 `x-turn-id`；Gravity 广告先 GET `imp_url`
  （只允许 `https://*.trygravity.ai|com`），再上报 `imp_fired: true`；
  其它来源省略该字段。
- **设备码登录**：先弹出条款同意（consent_version=4），设备码 session 建立后
  调 `POST /auth/consent`，再轮询 `/auth/token`，与 CLI 顺序一致。
- 测试 60 个。

## 0.1.1 — 2026-11-12

模型表扩到 [freepi.ai/models](https://freepi.ai/models) 的完整清单（17 个）：

- **4 个免费无限**：`deepseek-v4.1-flash`（默认）、`deepseek-v4-flash`、`glm-5.3-flash`、`particle`，仍标 `free: true`。
- **13 个按用量计费**：`free: false`，带上站点的 `~Nx usage` 倍率（`rate`），不会进 Free first 优先档。
- 上下文 / 输出 / 输入模态 / 工具 / 推理 / 发布日期按各模型详情页填写；站点没给规格的
  Defense 系列与 Ultrafast 版不编 `limit`，保守标 text-only、不声明工具。
- `particle` 的工具调用 2026-11-12 实测通过，转为 `toolcall: true`。
- 测试 56 个（新增完整模型表的免费/倍率/模态/规格断言）。

## 0.1.0 — 2026-11-12

首个版本：把 `freepi-proxy` 的 Python 反代改写成 magpie 原生插件。

- **登录**：GitHub 设备码登录（`/auth/github/device` + `/auth/token` 轮询）；
  也支持直接粘贴 Bearer token。
- **广告保活**：进程级调度器，每 150 秒对每个账号拉 banner / inline 两条广告并上报曝光；
  失败按 30s / 60s / 120s 退避。
- **对话转发**：`/v1/chat/completions` 流式 / 非流式透传；200 的 `Response` 原样交回。
- **并发处理**：`409 concurrent_session` 自动 `/session/reset` 重试；
  `429 concurrent` 同账号短退避重试，耗尽后回 429 让 magpie 换号。
- **广告要求**：`402/403 ads_required` 同步补刷后重试。
- **额度卡片**：`/me` → 「今日额度」窗口（`used` 参与路由）+「广告保活」aside 文字。
- **模型**：`deepseek-v4.1-flash`（默认）、`deepseek-v4-flash`、`glm-5.3-flash`、`particle`，
  全部 `free: true`；图片与工具调用能力按 2026-11-12 真机实测标注。
- **无 refresh**：上游 token 是 90 天 JWT，没有续期端点；过期后重新登录。
- **测试**：52 个单元测试覆盖登录、广告调度、重试分支、额度窗口与入口装配。
