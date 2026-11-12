import test from "node:test"
import assert from "node:assert/strict"

import { buildUsage, toIso } from "../src/usage.mjs"

const ME = {
  user_id: "uuid-1234",
  handle: "999AAAXXX",
  tier: "young",
  allowance_credits: 15_000,
  remaining_credits_today: 14_989,
  remaining_usd_today: 1.124,
  refill_at: "2026-11-13T00:00:00.000Z",
}

test("今日额度：used / amount / limit / display / resetsAt 都对", () => {
  const usage = buildUsage({
    auth: { accountId: "999AAAXXX" },
    me: ME,
    ad: { ok: true, ageMs: 42_000, error: "" },
  })

  const quota = usage.windows[0]
  assert.equal(quota.name, "今日额度")
  assert.ok(Math.abs(quota.used - (11 / 15_000) * 100) < 1e-9)
  assert.equal(quota.amount, 11)
  assert.equal(quota.limit, 15_000)
  assert.equal(quota.unit, "积分")
  assert.equal(quota.display, "14,989 / 15,000 积分")
  assert.equal(quota.resetsAt, "2026-11-13T00:00:00.000Z")
  assert.equal(quota.aside, undefined)
  assert.equal(usage.user, "999AAAXXX")
  assert.equal(usage.plan, "young")

  const ad = usage.windows[1]
  assert.equal(ad.name, "广告保活")
  assert.equal(ad.aside, true)
  assert.equal(ad.used, 0)
  assert.equal(ad.amount, undefined)
  assert.equal(ad.limit, undefined)
  assert.match(ad.display, /^正常/u)
})

test("额度耗尽：used 给 100，不把耗尽账号排到队首", () => {
  const usage = buildUsage({
    me: { allowance_credits: 15_000, remaining_credits_today: 0 },
  })
  assert.equal(usage.windows[0].used, 100)
  assert.equal(usage.windows[0].amount, 15_000)
})

test("上限缺失：仍然给有限 used；耗尽时按 100 处理", () => {
  const zero = buildUsage({ me: { remaining_credits_today: 0 } })
  assert.equal(zero.windows[0].used, 100)
  const some = buildUsage({ me: { remaining_credits_today: 500 } })
  assert.equal(some.windows[0].used, 0)
  assert.match(some.windows[0].display, /上限未知/u)
})

test("任何情况下第一条窗口都有有限的 used（路由要读）", () => {
  for (const me of [ME, {}, { allowance_credits: 0, remaining_credits_today: 0 }, { allowance_credits: null, remaining_credits_today: null }]) {
    const usage = buildUsage({ me })
    assert.ok(Number.isFinite(usage.windows[0].used), JSON.stringify(me))
  }
})

test("refill_at 解析不了就不写 resetsAt，绝不把原样字符串塞进去", () => {
  const usage = buildUsage({ me: { allowance_credits: 10, remaining_credits_today: 5, refill_at: "not a date" } })
  assert.equal(usage.windows[0].resetsAt, undefined)
  assert.equal(toIso("2026-11-13T00:00:00.000Z"), "2026-11-13T00:00:00.000Z")
  assert.equal(toIso(1_764_000_000), new Date(1_764_000_000_000).toISOString())
})

test("首次检查中显示「检查中…」，而不是当成失败", () => {
  const usage = buildUsage({ me: ME, ad: { ok: false, running: true, at: 0, error: "", ageMs: null } })
  assert.equal(usage.windows[1].display, "检查中…")
})

test("广告失败显示待刷新，且错误被截断", () => {
  const usage = buildUsage({ me: ME, ad: { ok: false, error: "x".repeat(500), ageMs: null } })
  const ad = usage.windows[1]
  assert.match(ad.display, /^待刷新/u)
  assert.ok(ad.display.length < 300)
})

test("没有广告状态就不画广告窗口", () => {
  const usage = buildUsage({ me: ME, ad: null })
  assert.equal(usage.windows.length, 1)
})
