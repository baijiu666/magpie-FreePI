# 错误码规范

一条错误必须同时说清三件事：**状态码**（宿主拿它决定换号 / 换模型 / 退避）、
**稳定的 code**（机器读）、**有信息量的 message**（人读，保留上游原文）。

## 状态码 → 宿主行为

| 状态 | 含义 | magpie 的行为 |
|---|---|---|
| 400 | 请求体坏了 | 不重试，直接报给用户 |
| 401 | 登录失效 | 标记这个账号（`signIn: "expired"`） |
| 403 / 404 | 模型级不可用 | 只搁置这个模型 |
| 409 | 会话冲突 | 宿主可重试 |
| 429 | 限流 / 账号被占用 | 换账号或按退避重试 |
| 501 | 端点没实现 | 不重试 |
| 503 / 504 | 上游不可用 / 超时 | 可重试、可换号 |
| 502 | 插件内部错误 | **不重试**（不要拿它当上游错误） |

## code 词表（冻结）

| code | 什么时候用 |
|---|---|
| `sign_in_required` | 还没登录就发请求 |
| `session_expired` | token 被上游 401 拒绝 |
| `invalid_request` | 请求体不是 JSON、缺 `model` |
| `rate_limited` | 429 concurrent 重试耗尽、402 额度用尽、ads_required 补刷失败 |
| `upstream_unavailable` | 连不上 free-pi（网络错误、5xx 重试后） |
| `upstream_timeout` | 等待上游超时 / 客户端中止 |
| `upstream_error` | 其它上游错误（通常直接透传上游 body） |
| `internal_error` | 插件自身 bug |
| `not_implemented` | 请求了 `/chat/completions`、`/models` 之外的端点 |

## 本插件的具体映射

| 上游情况 | 插件出口 | 说明 |
|---|---|---|
| `200` | 原样 `Response` | 流式 body 不读，直接交给宿主 |
| `401` | `401 session_expired` | 让 magpie 标记这个账号 |
| `429` + `code: "concurrent"` | 短退避重试 3 次；仍失败 → `429 rate_limited` | 不换号是插件的事，换号是宿主的事 |
| `409` + `code: "concurrent_session"` | `/session/reset` 后重试 2 次；仍失败 → `429 rate_limited` | reset 失败也继续重试 |
| `402/403` + `code: "ads_required"` | 同步补刷广告后重试 1 次；仍失败 → `429 rate_limited` | 补刷失败不阻塞错误出口 |
| `402`（其它 code） | `429 rate_limited` | 免费额度用尽；429 才会让宿主换号 |
| `400`（上游参数错） | 原样透传 | 保留厂商 message |
| 网络错误 | `503 upstream_unavailable` | 可重试 |
| `AbortError` / `TimeoutError` | `504 upstream_timeout` | 可重试 |

## 流式通道

流式请求在 `200` 之后无法再改状态码。本插件**不在插件里读 SSE body**：上游发什么就转什么；
上游在流中自行发错误帧时，由客户端按 OpenAI 语义处理。这是与 Python 反代一致的行为。

## 验收清单

- [ ] 每个非 2xx 出口都有 `status` + `code` + `message`
- [ ] 401 只用于登录失效，不用于模型错误
- [ ] 超时 / 断连落 503 / 504，不落 502
- [ ] 不支持的端点落 501，不落 404
- [ ] 流式成功路径返回原始 `Response`
