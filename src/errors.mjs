// src/errors.mjs —— 错误语义只在这里定义一次（词表与 ERROR-CODES.md 同步）。
//
// 三条规矩：
//   ① 每个出口都带 status + code + 有信息量的 message
//   ② 登录失效才用 401；模型级错误用 404，绝不拿 401 顶
//   ③ 超时 / 连不上落 503 / 504（可重试），不落 502（宿主不换号）

export const CODES = Object.freeze({
  signInRequired: "sign_in_required",
  sessionExpired: "session_expired",
  invalidRequest: "invalid_request",
  rateLimited: "rate_limited",
  upstreamUnavailable: "upstream_unavailable",
  upstreamTimeout: "upstream_timeout",
  upstreamError: "upstream_error",
  internalError: "internal_error",
  notImplemented: "not_implemented",
})

export class ApiError extends Error {
  constructor(message, { status = 0, code = "", url = "", internal = false } = {}) {
    super(String(message ?? ""))
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.url = url
    this.internal = internal
  }
}

/** 任意异常 → 带 status/code 的 ApiError。 */
export function asApiError(error, fallbackMessage = "插件内部错误") {
  if (error instanceof ApiError) return error
  const message = error?.message ?? String(error ?? fallbackMessage)
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return new ApiError(`上游等待超时：${message}`, { status: 504, code: CODES.upstreamTimeout })
  }
  return new ApiError(message, { status: 502, code: CODES.internalError, internal: true })
}

/** 非 2xx 的 OpenAI 形状响应；所有错误出口都走这里。 */
export function errorResponse(status, code, message, headers = {}) {
  const payload = {
    error: {
      message: String(message ?? ""),
      type: "upstream_error",
      code,
      status,
    },
  }
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  })
}
