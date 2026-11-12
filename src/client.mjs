// src/client.mjs —— 对 api.freepi.ai 的唯一出口。
//
// 端点（2026-11-12 实测）：
//   POST /auth/github/device   → { session_id, user_code, verification_uri, ... }
//   POST /auth/token           → { token } / { code: "authorization_pending" }
//   GET  /me                   → 额度、tier、handle
//   GET  /ads/next?slot=…      → 一条广告
//   POST /ads/impression       → 上报曝光（保活的关键一步）
//   POST /session/reset        → 释放卡住的并发会话
//   POST /v1/chat/completions  → OpenAI 兼容对话（流式/非流式）
//
// 请求头与 freepi_proxy.py 保持一致：/me、/ads、/auth 带 x-client-*；
// chat 只带 authorization / content-type / accept（反代实测如此）。

import { ORIGIN, CLIENT_VERSION, CONSENT_VERSION, REQUEST_TIMEOUT_MS, CHAT_TIMEOUT_MS } from "./provider.mjs"

function localeDefaults() {
  try {
    const { timeZone, locale } = Intl.DateTimeFormat().resolvedOptions()
    return { timeZone: timeZone || "Asia/Shanghai", locale: locale || "en-US" }
  } catch {
    return { timeZone: "Asia/Shanghai", locale: "en-US" }
  }
}

const LOCALE = localeDefaults()
// 官方 CLI 的 authedFetch 在 /ads/next 上用运行时平台 / 架构 / 时区 / locale。
const APP_HEADERS = Object.freeze({
  "x-client-version": CLIENT_VERSION,
  "x-client-os": process.platform || "win32",
  "x-client-arch": process.arch || "x64",
  "x-client-timezone": LOCALE.timeZone,
  "x-client-locale": LOCALE.locale,
})

function timeoutSignal(ms, signal) {
  const list = []
  if (Number.isFinite(ms) && ms > 0) list.push(AbortSignal.timeout(ms))
  if (signal) list.push(signal)
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  return AbortSignal.any(list)
}

async function readJson(res) {
  let text = ""
  try {
    text = await res.text()
  } catch {
    // 读失败也照样把 status 交给调用方
  }
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  return { status: res.status, ok: res.ok, text, data, headers: res.headers }
}

export function createClient({
  fetchImpl = globalThis.fetch,
  origin = ORIGIN,
  clientVersion = CLIENT_VERSION,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("createClient 需要 fetch")

  async function request(path, {
    method = "GET",
    token = "",
    session = "",
    body,
    rawBody,
    headers,
    accept,
    appHeaders = true,
    timeout = REQUEST_TIMEOUT_MS,
    signal,
  } = {}) {
    const h = new Headers()
    if (appHeaders) {
      for (const [key, value] of Object.entries(APP_HEADERS)) h.set(key, value)
      h.set("x-client-version", clientVersion)
    }
    if (token) h.set("authorization", `Bearer ${token}`)
    if (session) h.set("x-session-id", session)
    if (accept) h.set("accept", accept)
    for (const [key, value] of Object.entries(headers ?? {})) h.set(key, value)

    let payload
    if (rawBody !== undefined) {
      payload = rawBody
      if (!h.has("content-type")) h.set("content-type", "application/json")
    } else if (body !== undefined) {
      payload = JSON.stringify(body)
      if (!h.has("content-type")) h.set("content-type", "application/json")
    }

    return fetchImpl(`${origin}${path}`, {
      method,
      headers: h,
      body: payload,
      signal: timeoutSignal(timeout, signal),
    })
  }

  return {
    /** 设备码登录第一步。这个端点不鉴权。 */
    async deviceStart() {
      return readJson(await request("/auth/github/device", { method: "POST", body: {}, appHeaders: false }))
    },

    /** 设备码登录轮询。pending 时上游回 4xx + code，不当异常。 */
    async deviceToken(sessionId, { signal } = {}) {
      return readJson(await request("/auth/token", {
        method: "POST",
        body: { session_id: sessionId },
        appHeaders: false,
        signal,
      }))
    },

    /** 账号与今日额度。 */
    async me(token, { signal } = {}) {
      return readJson(await request("/me", { token, appHeaders: false, signal }))
    },

    /**
     * 官方 CLI 的模型目录（GET /client-version）。
     * 返回 { min, latest, model, models: [...], fusion?, ... }。
     */
    async clientVersion(token, { signal } = {}) {
      return readJson(await request("/client-version", {
        token,
        headers: { "x-freepi-cost-exp": "1" },
        appHeaders: false,
        signal,
        timeout: 5_000,
      }))
    },

    /** 新用户同意条款（free-pi-cli 的 consent_version=4）。 */
    async consent(sessionId, consentVersion = CONSENT_VERSION, { signal } = {}) {
      return readJson(await request("/auth/consent", {
        method: "POST",
        body: { session_id: sessionId, consent_version: consentVersion },
        appHeaders: false,
        signal,
        timeout: 15_000,
      }))
    },

    /** 拉一条广告。slot ∈ banner / inline；x-turn-id 与 CLI 一致。 */
    async adsNext(token, session, slot, { signal, turnId } = {}) {
      return readJson(await request(`/ads/next?slot=${encodeURIComponent(slot)}`, {
        token,
        session,
        headers: turnId ? { "x-turn-id": turnId } : undefined,
        signal,
        timeout: 5_000,
      }))
    },

    /**
     * 上报曝光 —— 只 next 不 impression 不算看完。
     * imp_fired 只有真的打了 Gravity 的 imp_url 才为 true（CLI 的语义）。
     */
    async adsImpression(token, session, ad, { signal, impFired = false } = {}) {
      return readJson(await request("/ads/impression", {
        method: "POST",
        token,
        session,
        body: {
          ad_id: ad?.ad_id,
          click_token: ad?.click_token,
          ...(impFired ? { imp_fired: true } : {}),
        },
        appHeaders: false,
        signal,
        timeout: 5_000,
      }))
    },

    /** 释放卡住的会话（CLI 的 close-other-session：只带 authorization）。 */
    async sessionReset(token, { signal } = {}) {
      return readJson(await request("/session/reset", {
        method: "POST",
        token,
        appHeaders: false,
        signal,
        timeout: 20_000,
      }))
    },

    /**
     * 对话。bodyText 已经是 JSON 字符串（插件不改写用户的请求体）。
     * 成功时返回原始 Response —— 流式 body 直接交给宿主，绝不在这里读。
     */
    async chat({ token, bodyText, stream, signal, headers, timeout = CHAT_TIMEOUT_MS }) {
      return request("/v1/chat/completions", {
        method: "POST",
        token,
        rawBody: bodyText,
        accept: stream ? "text/event-stream" : "application/json",
        headers,
        appHeaders: false,
        timeout,
        signal,
      })
    },
  }
}
