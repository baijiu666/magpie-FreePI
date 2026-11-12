// src/relay.mjs —— loader.fetch 的实现：模型目录 + 对话转发 + 失败重试。
//
// 分工：
//   · 200 的 Response **原样交回**（流式 body 一个字都不读，避免把 SSE 读干）。
//   · 409 concurrent_session → /session/reset 后重试；429 concurrent → 短退避重试；
//     402/403 ads_required → 同步补看广告后重试。
//   · 401 → 我们自己回 session_expired（让 magpie 标记这个账号）；
//     其它错误按上游原文透传，保留厂商的 message 与状态码。
//
// 重试都在**同一个账号**内完成 —— 换账号是 magpie 的事（它看到 429 会路由到别的号）。

import { CHAT_TIMEOUT_MS, CLIENT_VERSION, PROVIDER, modelsForProvider, stripModelPrefix } from "./provider.mjs"
import { ApiError, CODES, asApiError, errorResponse } from "./errors.mjs"
import { sessionIdOf, tokenOf } from "./auth.mjs"

const MODELS_PATH = /\/models\/?$/u
const CHAT_PATH = /\/chat\/completions\/?$/u

function codeOf(text) {
  try {
    const d = JSON.parse(text)
    return String(d?.code ?? d?.error?.code ?? "")
  } catch {
    return ""
  }
}

function messageOf(text) {
  try {
    const d = JSON.parse(text)
    return String(d?.message ?? d?.error?.message ?? "").slice(0, 300)
  } catch {
    return String(text ?? "").slice(0, 300)
  }
}

function responseFrom(status, text, headers) {
  const h = new Headers()
  const type = headers?.get?.("content-type")
  h.set("content-type", type || "application/json; charset=utf-8")
  const retryAfter = headers?.get?.("retry-after")
  if (retryAfter) h.set("retry-after", retryAfter)
  return new Response(text, { status, headers: h })
}

function modelsResponse() {
  const data = Object.values(modelsForProvider()).map((m) => ({
    id: m.id,
    object: "model",
    created: 0,
    owned_by: PROVIDER,
    name: m.name,
  }))
  return new Response(JSON.stringify({ object: "list", data }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

/** OpenAI SDK 可能用 string / Uint8Array / ReadableStream / Request 四种方式传 body。 */
async function readRequestBody(input, init) {
  const body = init?.body
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body))
  if (body && typeof body.getReader === "function") return await new Response(body).text()
  if (input instanceof Request) return await input.text()
  return ""
}

function signalFor(input, init, timeoutMs) {
  const external = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  const list = [AbortSignal.timeout(timeoutMs)]
  if (external) list.push(external)
  return list.length > 1 ? AbortSignal.any(list) : list[0]
}

/**
 * @param {object} args
 * @param {() => Promise<object>} args.getAuth
 * @param {object} args.client
 * @param {object} [args.adKeeper]
 * @param {(ms:number)=>Promise<void>} [args.sleepImpl]
 */
export function createRelay({
  getAuth,
  client,
  adKeeper,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  chatTimeoutMs = CHAT_TIMEOUT_MS,
  retryDelayMs = 600,
  maxAttempts = 4,
} = {}) {
  if (typeof getAuth !== "function") throw new Error("createRelay 需要 getAuth")
  if (!client) throw new Error("createRelay 需要 client")

  async function sendWithRetry({ auth, token, body, stream, signal, turnId }) {
    const bodyText = JSON.stringify(body)
    // free-pi-cli 的 provider headers：x-session-id + x-client-version；
    // turn 扩展再给每个 provider 请求加 x-turn-id（同一个用户轮次复用）。
    const sessionId = adKeeper?.sessionFor(auth) || sessionIdOf(auth, token)
    const headers = {
      "x-session-id": sessionId,
      "x-client-version": CLIENT_VERSION,
      "x-turn-id": turnId || crypto?.randomUUID?.() || `turn-${Date.now()}`,
    }
    let last = null
    let adsRetried = false
    let resets = 0

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let res
      try {
        res = await client.chat({ token, bodyText, stream, signal, headers })
      } catch (error) {
        const err = asApiError(error)
        if (signal?.aborted || err.status === 504) {
          return errorResponse(504, CODES.upstreamTimeout, `等待 free-pi 超时：${err.message}`)
        }
        if (attempt < 2) {
          await sleepImpl(retryDelayMs)
          continue
        }
        return errorResponse(503, CODES.upstreamUnavailable, `连接 free-pi 失败：${err.message}`)
      }

      // ⚠ 成功的流式响应直接交回，绝不在插件里读 body。
      if (res.status === 200) return res

      const text = await res.text().catch(() => "")
      const code = codeOf(text)
      const message = messageOf(text)
      last = { status: res.status, text, code, message, headers: res.headers }

      if (res.status === 401) {
        return errorResponse(401, CODES.sessionExpired, "free-pi 登录已失效，请重新登录")
      }

      // 账号 tier 不够（如 young 账号用 kimi-k3.1-pro）：这是**账号级**可重试，
      // 换一个有资格的账号就能跑。403 会被宿主当成模型级错误直接搁置，所以映射成 429。
      if (res.status === 403 && code === "model_requires_credits") {
        return errorResponse(
          429,
          CODES.rateLimited,
          `free-pi 账号${auth?.accountId ? ` ${auth.accountId}` : ""} 不能用 ${body.model}：`
            + `${message || "该模型需要购买 credits"}；正在尝试其他账号`,
          { "retry-after": "1" },
        )
      }

      // 免费额度用尽（非广告原因）：402 映射成 429，宿主才会换号而不是报一个不可重试的 502。
      if (res.status === 402 && code !== "ads_required") {
        return errorResponse(
          429,
          CODES.rateLimited,
          `free-pi 免费额度已用尽${message ? `：${message}` : ""}`,
          { "retry-after": "60" },
        )
      }

      const concurrent = res.status === 429 && code === "concurrent"
      const sessionStuck = (res.status === 409 || res.status === 429) && code === "concurrent_session"
      const adsRequired = (res.status === 402 || res.status === 403 || res.status === 429)
        && code === "ads_required"

      if (!concurrent && !sessionStuck && !adsRequired) {
        return responseFrom(res.status, text, res.headers)
      }

      if (sessionStuck) {
        if (resets >= 2 || attempt === maxAttempts) break
        resets += 1
        try {
          await client.sessionReset(token)
        } catch {
          // reset 失败也继续重试：下一次可能自己就释放了
        }
        await sleepImpl(retryDelayMs)
        continue
      }

      if (concurrent) {
        if (attempt === maxAttempts) break
        await sleepImpl(retryDelayMs * attempt)
        continue
      }

      // ads_required：补刷一轮广告再重试，只补一次。
      if (adsRequired) {
        if (adsRetried || attempt === maxAttempts) break
        adsRetried = true
        try {
          await adKeeper?.force(auth)
        } catch {
          // 广告失败就按下面统一出口处理
        }
        await sleepImpl(retryDelayMs)
        continue
      }
    }

    if (last) {
      if (last.code === "concurrent" || last.code === "concurrent_session") {
        return errorResponse(
          429,
          CODES.rateLimited,
          `free-pi 同一账号同时只允许一个请求；已重试 ${maxAttempts} 次仍被占用`
            + `${last.message ? `（${last.message}）` : ""}`,
          { "retry-after": "2" },
        )
      }
      if (last.code === "ads_required") {
        return errorResponse(
          429,
          CODES.rateLimited,
          `free-pi 要求先看完广告；插件已补刷但仍未通过${last.message ? `（${last.message}）` : ""}`,
          { "retry-after": "5" },
        )
      }
      return responseFrom(last.status, last.text, last.headers)
    }

    return errorResponse(503, CODES.upstreamUnavailable, "free-pi 没有返回响应")
  }

  return async function relayFetch(input, init) {
    let auth
    try {
      auth = await getAuth()
    } catch (error) {
      return errorResponse(503, CODES.upstreamUnavailable, `读取 free-pi 登录态失败：${error?.message ?? error}`)
    }

    const token = tokenOf(auth)
    if (!token) return errorResponse(401, CODES.signInRequired, "还没有登录 free-pi")

    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input?.url ?? "")
    const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    const path = String(url).split("?")[0]

    if (MODELS_PATH.test(path) && method === "GET") return modelsResponse()

    if (!CHAT_PATH.test(path) || method !== "POST") {
      // 不支持端点用 501，绝不能用 404（会被当成「模型不存在」而搁置模型）。
      return errorResponse(
        501,
        CODES.notImplemented,
        `该端点没有实现：${method} ${url}。本插件只提供 /chat/completions 与 /models。`,
      )
    }

    const text = await readRequestBody(input, init)
    let body
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      return errorResponse(400, CODES.invalidRequest, `请求体不是合法 JSON：${String(text).slice(0, 200)}`)
    }

    const requested = String(body?.model ?? "").trim()
    const model = stripModelPrefix(requested)
    if (!model) return errorResponse(400, CODES.invalidRequest, "请求里没有 model")
    body.model = model

    const stream = body.stream === true
    const signal = signalFor(input, init, chatTimeoutMs)

    // CLI 的节奏：每个新用户消息取一条 banner（await，和 before_agent_start 一样），
    // tool 续轮沿用同一个 x-turn-id、不重复刷广告。
    const messages = Array.isArray(body?.messages) ? body.messages : []
    const lastRole = String(messages[messages.length - 1]?.role ?? "")
    const userTurn = messages.length === 0 || lastRole === "user"

    let turnId = ""
    if (adKeeper) {
      try {
        turnId = userTurn ? await adKeeper.noteUserTurn(auth) : adKeeper.turnIdFor(auth)
      } catch {
        // 广告失败不阻塞对话；chat 仍会带一个 turn id
      }
    }
    if (!turnId) turnId = crypto?.randomUUID?.() || `turn-${Date.now()}`

    try {
      return await sendWithRetry({ auth, token, body, stream, signal, turnId })
    } catch (error) {
      const err = asApiError(error)
      return errorResponse(err.status || 502, err.code || CODES.upstreamError, err.message)
    }
  }
}
