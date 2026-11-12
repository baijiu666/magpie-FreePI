// src/auth.mjs —— token 的形状、身份、设备码登录。
//
// free-pi 只有一种凭据：Bearer token（JWT，90 天）。没有 refresh_token、
// 没有续期端点 —— 过期只能重新登录，所以 refresh 钩子故意不实现。

import { ORIGIN } from "./provider.mjs"
import { ApiError, CODES } from "./errors.mjs"

/** getAuth 给的对象可能是 oauth（access）也可能是 api（key）——两种都认。 */
export function tokenOf(auth) {
  return String(auth?.access || auth?.key || "").trim()
}

export function normalizeToken(raw) {
  return String(raw ?? "").trim().replace(/^Bearer\s+/iu, "").trim()
}

/** 不验签，只读 payload：上游 JWT 的 sub / iat / exp 都是我们要的。 */
export function jwtPayload(token) {
  const parts = String(token ?? "").trim().split(".")
  if (parts.length < 2) return null
  try {
    const b64 = parts[1].replace(/-/gu, "+").replace(/_/gu, "/")
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4)
    const bin = atob(padded)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    const data = JSON.parse(new TextDecoder().decode(bytes))
    return data && typeof data === "object" ? data : null
  } catch {
    return null
  }
}

/** 厂商身份：token 里的 sub 是稳定的 user_id。 */
export function uidOf(auth, token = tokenOf(auth)) {
  return String(auth?.uid || jwtPayload(token)?.sub || "")
}

/** JWT exp → 毫秒；没有就是 0（= 永不续期）。 */
export function expiresAt(token) {
  const exp = Number(jwtPayload(token)?.exp)
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0
}

/**
 * 卡片上显示的名字：/me 的 handle（例如 999AAAXXX）。
 * user_id 是 UUID —— 那是身份，进 uid，绝不进 accountId。
 */
export function handleOf(me) {
  return String(me?.handle ?? "").trim()
}

/** /auth/next + /ads/next 用的会话名。同一 token 每次启动都稳定。 */
export function sessionIdOf(auth, token = tokenOf(auth)) {
  const uid = uidOf(auth, token).replace(/-/gu, "").slice(0, 12)
  return `magpie-${uid || "anon"}`
}

/** 可中断的 sleep（登录 poll 要在用户取消时立刻退出）。 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("登录已取消"), { name: "AbortError" }))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(Object.assign(new Error("登录已取消"), { name: "AbortError" }))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** 设备码登录的「发起」：POST /auth/github/device。 */
export async function startDeviceFlow({ client }) {
  const res = await client.deviceStart()
  if (res.status !== 200 || !res.data?.session_id) {
    throw new ApiError(
      `free-pi 设备码登录发起失败：HTTP ${res.status}${detailOf(res)}`,
      { status: res.status === 429 ? 429 : 503, code: CODES.upstreamUnavailable },
    )
  }

  const d = res.data
  const sessionId = String(d.session_id)
  const intervalMs = Math.max(3, Number(d.interval) || 5) * 1000
  const expiresInMs = (Number(d.expires_in) || 15 * 60) * 1000

  return {
    sessionId,
    userCode: String(d.user_code ?? ""),
    verificationUri: String(d.verification_uri ?? ""),
    verificationUriComplete: String(d.verification_uri_complete || d.verification_uri || ""),
    intervalMs,
    expiresInMs,

    /**
     * 轮询 /auth/token。上游的 pending 不是错误：非 200 且 code 是
     * authorization_pending / slow_down 就继续等；明确的过期/拒绝立刻失败。
     */
    async waitForToken({ signal, sleepImpl = sleep, now = () => Date.now() } = {}) {
      const deadline = now() + expiresInMs
      let wait = intervalMs
      let networkErrors = 0

      while (now() < deadline) {
        await sleepImpl(wait, signal)
        let r
        try {
          r = await client.deviceToken(sessionId, { signal })
        } catch (error) {
          if (error?.name === "AbortError") throw new ApiError("登录已取消", { status: 499, code: CODES.signInRequired })
          networkErrors += 1
          if (networkErrors >= 3) {
            throw new ApiError(`轮询登录状态失败：${error?.message ?? error}`, {
              status: 503,
              code: CODES.upstreamUnavailable,
            })
          }
          continue
        }
        networkErrors = 0

        if (r.status === 200 && r.data?.token) return String(r.data.token)
        const code = String(r.data?.code ?? "").toLowerCase()
        if (code === "slow_down") {
          wait += 5_000
          continue
        }
        if (code === "authorization_pending" || code === "pending") continue
        if (code === "expired_token" || code === "access_denied" || code === "invalid_grant") {
          throw new ApiError(`GitHub 授权未完成（${code}）`, { status: 401, code: CODES.signInRequired })
        }
        if (r.status === 404) {
          throw new ApiError("设备码会话已失效，请重新发起登录", { status: 401, code: CODES.signInRequired })
        }
        // 其余非 200（含上游偶发 5xx）继续轮询，直到设备码过期。
      }
      throw new ApiError("设备码已过期，请重新发起登录", { status: 401, code: CODES.signInRequired })
    },
  }
}

/**
 * token → magpie 登录态。会先打一次 /me 验证并拿 handle。
 * 返回的形状里 `refresh` 必须在（宿主靠它判断这是 oauth 账号），值可以是空串。
 */
export async function completeLogin(raw, { client, adKeeper } = {}) {
  const token = normalizeToken(raw)
  if (!token) throw new ApiError("登录凭据为空", { status: 400, code: CODES.invalidRequest })

  let res
  try {
    res = await client.me(token)
  } catch (error) {
    throw new ApiError(`连接 free-pi 失败：${error?.message ?? error}`, {
      status: 503,
      code: CODES.upstreamUnavailable,
    })
  }

  if (res.status === 401 || res.status === 403) {
    throw new ApiError("free-pi token 无效或已过期，请重新登录", { status: 401, code: CODES.sessionExpired })
  }
  if (res.status !== 200 || !res.data) {
    throw new ApiError(
      `读取 free-pi 账号信息失败：HTTP ${res.status}${detailOf(res)}`,
      { status: res.status >= 500 ? 503 : 502, code: CODES.upstreamError },
    )
  }

  const me = res.data
  const handle = handleOf(me)
  const uid = String(me.user_id || jwtPayload(token)?.sub || "")
  const auth = { access: token, uid }

  // 登录成功立刻刷一次广告：反代也是这么做的，免费额度从这一刻起可用。
  if (adKeeper) {
    adKeeper.register(auth)
    try {
      await adKeeper.force(auth)
    } catch {
      // 广告失败不阻塞登录：聊天时遇到 ads_required 还会再补刷。
    }
  }

  return {
    type: "success",
    access: token,
    // 没有 refresh_token；这个空串只是让宿主知道「这是 oauth 账号」。
    refresh: "",
    expires: expiresAt(token),
    ...(handle ? { accountId: handle } : {}),
    ...(uid ? { uid } : {}),
    metadata: {
      site: ORIGIN,
      ...(handle ? { handle } : {}),
      ...(uid ? { userId: uid } : {}),
      ...(me.tier ? { tier: me.tier } : {}),
    },
  }
}

function detailOf(res) {
  const message = res?.data?.message || res?.data?.error?.message
  return message ? ` · ${String(message).slice(0, 160)}` : ""
}
