// src/ads.mjs —— 按官方 CLI 的节奏取广告（不是定时器）。
//
// free-pi-cli 0.6.19 的真实行为（pi-ads）：
//   · session start / 每个新用户消息 → 取一条 banner 广告并上报 impression；
//   · 每 5 个 turn（默认 AD_INLINE_TURN_FREQUENCY=5）→ 取一条 inline 广告；
//   · banner 是 Gravity 时跳过 inline（同一轮只展示一个第三方广告）；
//   · 没有「每 150 秒」的定时器 —— 150s 是旧 Python 反代的经验值。
//
// 插件没有终端 UI，所以「turn」按 Magpie 的一次用户请求计：relay 看到请求体最后
// 一条消息是 user 时调用 noteUserTurn()，tool 续轮不会重复刷广告。

import { sessionIdOf, tokenOf } from "./auth.mjs"

const IMP_TIMEOUT_MS = 3_000
const INLINE_EVERY = 5

function codeOf(res) {
  const code = res?.data?.code || res?.data?.error?.code
  return code ? ` (${String(code).slice(0, 40)})` : ""
}

function isGravityImpUrl(raw) {
  if (!raw) return false
  try {
    const url = new URL(raw)
    return url.protocol === "https:" && /(^|\.)trygravity\.(ai|com)$/u.test(url.hostname)
  } catch {
    return false
  }
}

/**
 * 官方 CLI 的语义：Gravity 广告先 GET 一次 imp_url，再上报 impression 并把
 * imp_fired 设为 true；其它来源不碰 imp_url，imp_fired 省略。失败不影响保活。
 */
export function fireGravityImpression(fetchImpl, ad) {
  if (ad?.source !== "gravity" || !isGravityImpUrl(ad?.imp_url)) return false
  try {
    Promise.resolve(fetchImpl(ad.imp_url, {
      method: "GET",
      signal: AbortSignal.timeout(IMP_TIMEOUT_MS),
    })).catch(() => {})
  } catch {
    // 同步抛错也只是没打成 imp_url
  }
  return true
}

function blankSlot() {
  return { ok: false, error: "", at: 0, source: "", running: null }
}

export function createAdKeeper({ client, fetchImpl = globalThis.fetch, now = () => Date.now(), logger } = {}) {
  if (!client) throw new Error("createAdKeeper 需要 client")

  /** token → 账号状态。key 必须按账号，不能按数组下标。 */
  const accounts = new Map()

  function register(auth) {
    const token = tokenOf(auth)
    if (!token) return null
    let rec = accounts.get(token)
    if (!rec) {
      rec = {
        token,
        session: sessionIdOf(auth, token),
        turns: 0,
        turnId: "",
        launched: false,
        banner: blankSlot(),
        inline: blankSlot(),
      }
      accounts.set(token, rec)
    }
    return rec
  }

  function statusOf(state) {
    if (!state) return null
    return {
      ok: state.ok,
      error: state.error,
      at: state.at || 0,
      ageMs: state.at ? Math.max(0, now() - state.at) : null,
      running: Boolean(state.running),
      source: state.source || "",
    }
  }

  /** 取一个 slot：next + Gravity imp_url + impression。同一 slot 并发合并。 */
  async function runSlot(rec, slot, { turnId } = {}) {
    if (!rec) return null
    const state = rec[slot]
    if (state.running) return state.running

    const id = turnId || rec.turnId || crypto?.randomUUID?.() || `turn-${now()}`
    state.running = (async () => {
      let next
      try {
        next = await client.adsNext(rec.token, rec.session, slot, { turnId: id })
      } catch (error) {
        state.ok = false
        state.error = `next ${slot}: ${error?.message ?? error}`.slice(0, 200)
        return statusOf(state)
      }
      if (next.status !== 200 || !next.data?.ad_id) {
        state.ok = false
        state.error = `next ${slot}: HTTP ${next.status}${codeOf(next)}`.slice(0, 200)
        return statusOf(state)
      }

      const ad = next.data
      const impFired = fireGravityImpression(fetchImpl, ad)
      try {
        const imp = await client.adsImpression(rec.token, rec.session, ad, { impFired })
        if (imp.status !== 200) {
          state.ok = false
          state.error = `impression ${slot}: HTTP ${imp.status}${codeOf(imp)}`.slice(0, 200)
          return statusOf(state)
        }
      } catch (error) {
        state.ok = false
        state.error = `impression ${slot}: ${error?.message ?? error}`.slice(0, 200)
        return statusOf(state)
      }

      state.ok = true
      state.error = ""
      state.at = now()
      state.source = String(ad.source ?? "")
      try {
        logger?.(`free-pi ${slot} 广告已上报${state.source === "gravity" ? "（Gravity）" : ""}`)
      } catch {
        // 日志钩子坏掉不影响保活
      }
      return statusOf(state)
    })().finally(() => {
      state.running = null
    })

    return state.running
  }

  /**
   * 每个新用户消息调用一次：banner + impression；每 5 轮再取 inline。
   * 返回本轮 turnId，relay 会把它作为后续 chat 请求的 x-turn-id，和 CLI 一致。
   */
  async function noteUserTurn(auth) {
    const rec = register(auth)
    if (!rec) return ""
    rec.turns += 1
    rec.turnId = crypto?.randomUUID?.() || `turn-${now()}`

    // CLI 的 newMessage 调用 renderBanner 时**没有 await**：banner 与模型请求并行。
    // inline 在 banner 结束后才决定（Gravity banner 跳过 inline），也在后台跑。
    const banner = runSlot(rec, "banner", { turnId: rec.turnId })
    banner.catch(() => {})
    if (rec.turns % INLINE_EVERY === 0) {
      banner.then(() => {
        if (rec.banner.source !== "gravity") {
          runSlot(rec, "inline", { turnId: rec.turnId }).catch(() => {})
        }
      }).catch(() => {})
    }
    return rec.turnId
  }

  /**
   * 首次登记（usage/loader）时执行一次 launch banner —— 对应 CLI 的 session_start。
   * 之后的 usage 刷新不再重复取广告。
   */
  function kick(auth) {
    const rec = register(auth)
    if (!rec) return null
    if (!rec.launched) {
      rec.launched = true
      rec.turnId ||= crypto?.randomUUID?.() || `turn-${now()}`
      runSlot(rec, "banner", { turnId: rec.turnId }).catch(() => {})
    }
    return rec
  }

  /** ads_required 时同步补一条 banner（CLI 下一次 user message 也会这么做）。 */
  async function force(auth) {
    const rec = register(auth)
    if (!rec) return null
    rec.turnId ||= crypto?.randomUUID?.() || `turn-${now()}`
    return runSlot(rec, "banner", { turnId: rec.turnId })
  }

  /** tool 续轮沿用当前 turn id；没有用户轮次时生成一个。 */
  function turnIdFor(auth) {
    const rec = register(auth)
    if (!rec) return ""
    rec.turnId ||= crypto?.randomUUID?.() || `turn-${now()}`
    return rec.turnId
  }

  function statusFor(auth) {
    const rec = accounts.get(tokenOf(auth))
    return rec ? statusOf(rec.banner) : null
  }

  function sessionFor(auth) {
    return register(auth)?.session || sessionIdOf(auth)
  }

  return { register, kick, noteUserTurn, force, runSlot, turnIdFor, statusFor, sessionFor, accounts }
}
