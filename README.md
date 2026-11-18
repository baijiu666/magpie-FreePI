# magpie-FreePI

把 [free-pi](https://freepi.ai)（`api.freepi.ai`）的免费模型池接进 magpie。
**不需要再跑 Python 反代**：登录、看广告保活、并发会话释放、流式透传都在插件里完成。

> 上游是 OpenAI 兼容接口，但免费额度靠「按用户消息看广告」维持 —— 这正是本插件存在的理由。
> 它取代同工作区的 `freepi-proxy/freepi_proxy.py`，两者不要同时用同一个 token（会互相抢并发）。

## 安装

```bash
magpie plugin add github:baijiu666/magpie-FreePI
```

本机开发时也可以直接装路径：

```bash
magpie plugin add D:\AI\magpie\magpie-FreePI
```

装完在 magpie 的「供应商」里会出现 **free-pi**，登录后即可选模型。

## 登录

两种方式，任选其一：

| 方式 | 做什么 | 适合 |
|---|---|---|
| **GitHub 设备码登录**（推荐） | magpie 打开 GitHub 授权页并预填代码，授权后自动完成 | 第一次用 free-pi |
| **粘贴 Bearer token** | 把已有 token 粘进去（例如 `freepi-proxy/accounts.json` 里的 `token` 字段） | 已经在别处登录过 |

登录态由 magpie 自己保存（`~/.config/magpie/plugin-auth.json`），插件不落盘任何凭据。
token 是 90 天 JWT；**上游没有续期端点**，过期后重新登录即可。

> **登录即表示你同意 free-pi 的条款**：免费版靠展示广告维持，并可能用对话训练模型。
> [Terms](https://freepi.ai/terms) · [Privacy](https://freepi.ai/privacy)

## 模型

模型表不是写死的：`provider.models` 调用官方 CLI 的 `GET /client-version`（0.6.23）
拿目录，按官方字段 `free` / `usage_x` / `section` / `note` 生成；拉不到才回退
`src/provider.mjs` 的 `MODEL_DEFS`（与 2026-11-18 的目录一致，18 个可用模型）。

官方 CLI 的 provider 配置对所有模型一视同仁：

- **上下文 200,000 tokens、最大输出 8,192 tokens**（CLI 的 `CONTEXT_WINDOW` / `MAX_OUTPUT_TOKENS`；
  网页上写的 1M 是底层模型的原始窗口，不是 free-pi CLI 实际使用的配置）
- **输入模态按模型真实能力**：`deepseek-v4.1-flash`、`glm-5.3-flash`、`kimi-k3.1-pro`、
  `mimo-v2.6-flash` 支持图片（后两者还支持视频，mimo 还支持音频）；其余 text-only。
  CLI 的 provider 配置把 input 固定为 text，是因为它走单独的 vision 工具；Magpie
  直接透传图片，所以这里按实测/站点详情页标注。
- `reasoning: true`，工具由 agent 统一提供
- 成本 0；真正扣的是「今日额度」积分

| 模型 ID | 计费 | 输入 | 备注 |
|---|---|---|---|
| `particle` | 免费无限 | 文本 | 默认（CLI 的 models[0]） |
| `deepseek-v4.1-flash` | 免费无限 | 文本 / 图片 | |
| `deepseek-v4-flash` | 免费无限 | 文本 | |
| `glm-5.3-flash` | 免费无限 | 文本 / 图片 / 视频 | |
| `hy4-flash` | x0.2 | 文本 | |
| `solar-pro-4` | x1.2 | 文本 | |
| `mimo-v2.6-flash` | x0.8 | 文本 / 图片 / 音频 / 视频 | |
| `qwen3.5-35b-darkbloom` | x2.1 | 文本 | |
| `deepseek-v4-pro` | x5.9 | 文本 | |
| `abliterated-large-flash` | x20 | 文本 | Defense |
| `deepseek-v4.1-flash-abliterated` | x20 | 文本 | Defense |
| `gemma-4-uncensored` | x20 | 文本 | Defense |
| `glm-4.7-flash-heretic` | x20 | 文本 | Defense |
| `qwen3.6-plus-uncensored` | x37 | 文本 | Defense |
| `uncensored-1.2` | x20 | 文本 | Defense |
| `kimi-k3.1-pro` | x22 | 文本 / 图片 / 视频 | premium credits |
| `abliterated-large-v2` | x60 | 文本 | Defense |
| `deepseek-v4.1-flash-1017-ultrafast` | x1.6 | 文本 | |

## 它替你做了什么

对照原来的 Python 反代：

| 反代里的能力 | 插件里的实现 |
|---|---|
| 广告按 CLI 的 turn 节奏 | 启动/每个用户消息一条 banner；每 5 个用户轮次一条 inline；Gravity banner 跳过 inline |
| Gravity 广告的 `imp_url` | 先 GET 一次外部曝光地址，再上报 `imp_fired: true`（与 CLI 一致） |
| 官方模型目录 | `src/catalog.mjs` 调 `GET /client-version`，按 10 分钟缓存；失败回静态兜底 |
| 官方 CLI 请求头 | chat 带 `x-session-id` / `x-client-version` / `x-ad-context: none` / `x-turn-id`；广告带 `x-turn-id` |
| 429 `concurrent` 自动换号 | magpie 自己的多账号路由；插件在同账号内短退避重试，仍失败就回 429 让宿主换号 |
| 409 `concurrent_session` 释放会话 | `src/relay.mjs` 调 `/session/reset` 后重试 |
| 402/403 `ads_required` 补刷广告 | 同步补刷一轮再重试 |
| 流式透传 | 成功的 `Response` 原样交回，插件不读 SSE body |
| 额度监控 / 停用失效 token | `src/usage.mjs` 读 `/me`；401 返回 `signIn: "expired"` |
| 可视化面板 / 本地端口 | 不需要：额度直接显示在 magpie 的账号卡片上 |
| 多账号池 | 在 magpie 里登录多个账号即可；每账号并发上限 1 |

## 额度卡片

- **今日额度**：`剩余 / 总量 积分`，`used` 参与 magpie 的路由排序。
- **广告保活**：显示「正常 · N 秒前」或「待刷新：原因」；它只展示，不参与路由。

`/me` 60 秒；广告按 CLI 的 turn 节奏（见上），没有定时器。

## 已知限制

- **同一账号同时只能跑 1 个请求**（服务端硬限制）。要给多个 agent 并发，就在 magpie 里多登几个账号。
- **上下文 200K / 输出 8K**（官方 CLI 的配置）；超长会拿到 `context_ceiling` / `context_too_long`。
- 上游要求客户端版本 ≥ **0.6.21**；插件按官方 CLI **0.6.23** 发 `x-client-version`，低于 min 会返回 426 并提示 `npx free-pi-cli@latest`。
- `kimi-k3.1-pro` 在 `young` 账号上会返回 `403 model_requires_credits`（需要购买 credits 或换
  `established` 账号）。插件把它映射成 429，让 Magpie 自动换一个有资格的账号。
- **上下文缓存不可用**（`cached_tokens` 恒为 0），每轮全量重传历史。
- 免费模型是官方限时活动（`Free Unlimited: limited time`），活动结束即失效。
- token 90 天，无续期；过期后重新登录。
- 插件不实现 `refresh` 钩子：上游没有可调用的续期接口。
- 没有签到活动；插件不实现 `checkin` 钩子，所以用量卡片里不会出现签到入口；广告保活是全自动的。

## 自检

```bash
npm test          # 59 个单元测试（登录 / 广告 / 重试 / 额度窗口）
npm run check     # 交付形状检查（入口唯一函数、模型能力布尔值、无本机路径）
npm run probe     # 真机探测（会花少量额度）

# probe 需要 token：
FREEPI_TOKEN=eyJ... node scripts/probe-live.mjs
# 或从本机反代的账号池读：
node scripts/probe-live.mjs --accounts D:\AI\magpie\freepi-proxy\accounts.json
```

## 文件

| 文件 | 作用 |
|---|---|
| `index.mjs` | 钩子的装配 |
| `src/provider.mjs` | 地址、请求头、静态模型表、图标 |
| `src/auth.mjs` | JWT、身份、设备码登录 |
| `src/client.mjs` | 对 `api.freepi.ai` 的唯一出口 |
| `src/ads.mjs` | 广告保活调度器 |
| `src/catalog.mjs` | `/client-version` 模型目录、缓存、映射 |
| `src/relay.mjs` | 对话转发、重试、流式透传 |
| `src/usage.mjs` | `/me` → 额度窗口 |
| `src/errors.mjs` | 错误码与 OpenAI 形状错误体 |

## 许可

MIT。与 free-pi 官方无关，只是把它的公开接口接进 magpie。
