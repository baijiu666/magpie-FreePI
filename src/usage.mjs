// src/usage.mjs —— /me → magpie 额度卡片。
//
// 窗口规矩（HOOKS 三 / 十一）：
//   · 每条窗口都必须有有限的 used —— 它同时是路由排序输入。
//   · aside 窗口只展示、不参与路由；只有「这个号还有别的窗口参与路由」时才用。
//   · resetsAt 必须是 ISO 字符串或数字；refill_at 已经是 ISO，解析失败就整条不写。

import { ME_TTL_MS } from "./provider.mjs"
import { ApiError, CODES } from "./errors.mjs"
import { tokenOf } from "./auth.mjs"

function finite(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function fmt(value) {
  return Number.isFinite(value) ? value.toLocaleString("en-US") : "—"
}

/** 厂商时间 → ISO；解析不了返回 undefined（绝不把原样字符串塞给 magpie）。 */
export function toIso(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  }
  if (typeof value === "string" && value.trim()) {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  }
  return undefined
}

function ageText(ms) {
  if (!Number.isFinite(ms)) return ""
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 90) return `${seconds} 秒前`
  return `${Math.round(seconds / 60)} 分钟前`
}

/**
 * @param {object} args
 * @param {object} args.auth 宿主给的账号
 * @param {object} args.me   /me 的响应
 * @param {object|null} args.ad 广告保活状态
 */
export function buildUsage({ auth, me, ad } = {}) {
  const windows = []

  const allowance = finite(me?.allowance_credits)
  const remaining = finite(me?.remaining_credits_today)

  let used = 0
  if (allowance !== undefined && allowance > 0 && remaining !== undefined) {
    used = Math.max(0, ((allowance - remaining) / allowance) * 100)
  } else if (remaining !== undefined && remaining <= 0) {
    // 上限拿不到但已经耗尽：合成 100%，让它沉底，而不是当「满额」排到队首。
    used = 100
  }

  const quota = {
    name: "今日额度",
    used,
  }
  if (allowance !== undefined && allowance > 0 && remaining !== undefined) {
    quota.amount = Math.max(0, allowance - remaining)
    quota.limit = allowance
    quota.unit = "积分"
    quota.display = `${fmt(remaining)} / ${fmt(allowance)} 积分`
  } else if (remaining !== undefined) {
    quota.display = `${fmt(remaining)} 积分（上限未知）`
  } else {
    quota.display = "额度未知"
  }
  const resetsAt = toIso(me?.refill_at)
  if (resetsAt) quota.resetsAt = resetsAt
  windows.push(quota)

  // 广告保活只做一行文字：主窗口已经参与路由，这里 aside 不会让账号在路由里消失。
  if (ad) {
    let display
    if (ad.ok) {
      display = `正常${ad.ageMs !== null && ad.ageMs !== undefined ? ` · ${ageText(ad.ageMs)}` : ""}`
    } else if (ad.running || (!ad.at && !ad.error)) {
      display = "检查中…"
    } else {
      display = `待刷新${ad.error ? `：${String(ad.error).slice(0, 80)}` : ""}`
    }
    windows.push({ name: "广告保活", used: 0, aside: true, display })
  }

  return {
    ...(me?.handle ? { user: String(me.handle) } : auth?.accountId ? { user: String(auth.accountId) } : {}),
    ...(me?.tier ? { plan: String(me.tier) } : {}),
    windows,
  }
}

function detailOf(res) {
  const message = res?.data?.message || res?.data?.error?.message
  return message ? ` · ${String(message).slice(0, 160)}` : ""
}

/**
 * /me 读取器：成功缓存 60 秒、同 token 并发合并；失败时优先回上一次的读数。
 */
export function createUsageReader({ client, adKeeper, ttlMs = ME_TTL_MS, now = () => Date.now() } = {}) {
  if (!client) throw new Error("createUsageReader 需要 client")

  const cache = new Map()
  const inflight = new Map()

  async function fetchMe(token) {
    const running = inflight.get(token)
    if (running) return running
    const task = (async () => {
      const res = await client.me(token)
      if (res.status === 401 || res.status === 403) {
        throw new ApiError("登录已失效，请重新登录", { status: 401, code: CODES.sessionExpired })
      }
      if (res.status !== 200 || !res.data) {
        throw new ApiError(
          `读取 free-pi 额度失败：HTTP ${res.status}${detailOf(res)}`,
          { status: res.status >= 500 ? 503 : 502, code: CODES.upstreamError },
        )
      }
      return res.data
    })().finally(() => inflight.delete(token))
    inflight.set(token, task)
    return task
  }

  async function read(auth) {
    const token = tokenOf(auth)
    if (!token) return { error: "未登录", windows: [] }

    // 每次读额度都顺手登记账号；到点就在后台补刷广告，不阻塞卡片。
    if (adKeeper) {
      try {
        adKeeper.kick(auth)
      } catch {
        // 保活登记失败不影响额度显示
      }
    }

    const hit = cache.get(token)
    if (hit && now() < hit.until) {
      return buildUsage({ auth, me: hit.me, ad: adKeeper?.statusFor(auth) })
    }

    try {
      const me = await fetchMe(token)
      cache.set(token, { me, until: now() + ttlMs })
      return buildUsage({ auth, me, ad: adKeeper?.statusFor(auth) })
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        cache.delete(token)
        return { error: "登录已失效，请重新登录", signIn: "expired", windows: [] }
      }
      // 接口抖一下：有旧读数就用旧的，别把卡片变成「额度未知」。
      if (hit?.me) return buildUsage({ auth, me: hit.me, ad: adKeeper?.statusFor(auth) })
      return { error: String(error?.message ?? error), windows: [] }
    }
  }

  return { read }
}
