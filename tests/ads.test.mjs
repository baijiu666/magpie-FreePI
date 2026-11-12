import test from "node:test"
import assert from "node:assert/strict"

import { createAdKeeper, fireGravityImpression } from "../src/ads.mjs"
import { makeToken } from "./helpers.mjs"

const AUTH_A = { access: makeToken({ sub: "225b3da0-1111-4c8b-8c6f-7bb276db403b" }) }
const AUTH_B = { access: makeToken({ sub: "718e4c8b-2222-4c8b-8c6f-000000000000" }) }

function setup({ ad = null, failFirstBanner = false } = {}) {
  const calls = []
  const impressions = []
  const fetched = []
  let bannerNexts = 0
  const client = {
    async adsNext(token, session, slot, opts = {}) {
      calls.push(["next", slot, session, opts])
      if (slot === "banner" && failFirstBanner && bannerNexts === 0) {
        bannerNexts += 1
        return { status: 500, data: { code: "server_error" } }
      }
      if (slot === "banner") bannerNexts += 1
      return {
        status: 200,
        data: ad ?? { ad_id: `ad-${slot}`, click_token: `ct-${slot}` },
      }
    },
    async adsImpression(token, session, item, opts = {}) {
      calls.push(["imp", item.ad_id, session, opts])
      impressions.push(opts)
      return { status: 200, data: { ok: true } }
    },
  }
  const fetchImpl = async (url, init) => {
    fetched.push([String(url), init?.method ?? "GET"])
    return new Response("ok")
  }
  const keeper = createAdKeeper({
    client,
    fetchImpl,
    now: () => 1_000_000,
  })
  return { keeper, calls, impressions, fetched }
}

/** 等后台 launch/inline 广告收尾。 */
async function settle(keeper, auth) {
  let quiet = 0
  for (let i = 0; i < 200; i += 1) {
    const rec = keeper.accounts.get(auth.access)
    const busy = Boolean(rec?.banner.running || rec?.inline.running)
    if (busy) quiet = 0
    else {
      quiet += 1
      if (quiet >= 2) return
    }
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

test("kick 首次发一条 launch banner（session_start），之后不重复", async () => {
  const { keeper, calls, impressions } = setup()
  keeper.kick(AUTH_A)
  await settle(keeper, AUTH_A)

  assert.deepEqual(calls.map((c) => c[0]), ["next", "imp"])
  assert.equal(calls[0][1], "banner")
  assert.equal(keeper.statusFor(AUTH_A).ok, true)
  assert.equal(impressions[0].impFired, false)

  const before = calls.length
  keeper.kick(AUTH_A)
  await settle(keeper, AUTH_A)
  assert.equal(calls.length, before, "launch banner 只发一次")
})

test("每个用户消息一条 banner；第 5 轮再加一条 inline，共用同一个 turnId", async () => {
  const { keeper, calls } = setup()
  const turnIds = []
  for (let turn = 1; turn <= 5; turn += 1) {
    turnIds.push(await keeper.noteUserTurn(AUTH_A))
    await settle(keeper, AUTH_A)
  }

  const nexts = calls.filter((c) => c[0] === "next")
  assert.equal(nexts.filter((c) => c[1] === "banner").length, 5)
  assert.equal(nexts.filter((c) => c[1] === "inline").length, 1, "第 5 轮才有 inline")
  assert.equal(calls.filter((c) => c[0] === "imp").length, 6)

  const turn5 = calls.filter((c) => c[3]?.turnId === turnIds[4])
  assert.deepEqual(turn5.map((c) => c[1]).sort(), ["banner", "inline"])
  assert.equal(turnIds.length, new Set(turnIds).size, "每个用户轮次一个 turnId")
  assert.equal(keeper.turnIdFor(AUTH_A), turnIds[4], "tool 续轮复用当前 turnId")
})

test("Gravity banner 的第 5 轮不取 inline（CLI 的互斥规则）", async () => {
  const ad = {
    ad_id: "ad-gravity",
    click_token: "ct-gravity",
    source: "gravity",
    imp_url: "https://server.trygravity.ai/ack?p=abc",
  }
  const { keeper, calls, fetched, impressions } = setup({ ad })
  for (let turn = 1; turn <= 5; turn += 1) {
    await keeper.noteUserTurn(AUTH_A)
    await settle(keeper, AUTH_A)
  }

  assert.equal(calls.filter((c) => c[0] === "next" && c[1] === "inline").length, 0)
  assert.equal(calls.filter((c) => c[0] === "next" && c[1] === "banner").length, 5)
  assert.equal(fetched.length, 5, "每条 Gravity banner 打一次 imp_url")
  assert.ok(impressions.every((o) => o.impFired === true))
})

test("force 只补一条 banner（ads_required 用）", async () => {
  const { keeper, calls } = setup()
  const status = await keeper.force(AUTH_A)
  assert.equal(status.ok, true)
  assert.deepEqual(calls.map((c) => [c[0], c[1]]), [
    ["next", "banner"],
    ["imp", "ad-banner"],
  ])
})

test("失败：记录错误；下一次用户消息会重新尝试（没有定时退避）", async () => {
  const { keeper, calls } = setup({ failFirstBanner: true })
  await keeper.noteUserTurn(AUTH_A)
  await settle(keeper, AUTH_A)
  assert.equal(keeper.statusFor(AUTH_A).ok, false)
  assert.match(keeper.statusFor(AUTH_A).error, /HTTP 500/u)

  await keeper.noteUserTurn(AUTH_A)
  await settle(keeper, AUTH_A)
  assert.equal(keeper.statusFor(AUTH_A).ok, true)
  assert.equal(calls.length, 3) // 失败那轮只到 next；成功那轮 next + impression
})

test("每个账号用自己的会话名", async () => {
  const { keeper, calls } = setup()
  await keeper.noteUserTurn(AUTH_A)
  await keeper.noteUserTurn(AUTH_B)
  await settle(keeper, AUTH_A)
  await settle(keeper, AUTH_B)
  const sessions = new Set(calls.map((c) => c[2]))
  assert.equal(sessions.size, 2)
  for (const session of sessions) assert.match(session, /^magpie-[0-9a-f]{12}$/u)
})

test("fireGravityImpression 只认 gravity + trygravity 的 https 地址", () => {
  const fetched = []
  const impl = async (url, init) => {
    fetched.push([url, init.method])
    return new Response("")
  }
  assert.equal(fireGravityImpression(impl, { source: "own", imp_url: "https://server.trygravity.ai/x" }), false)
  assert.equal(fireGravityImpression(impl, { source: "gravity", imp_url: "http://server.trygravity.ai/x" }), false)
  assert.equal(fireGravityImpression(impl, { source: "gravity", imp_url: "https://server.trygravity.ai/x" }), true)
  assert.equal(fireGravityImpression(impl, { source: "gravity", imp_url: "https://api.trygravity.com/x" }), true)
  assert.equal(fetched.length, 2)
})
