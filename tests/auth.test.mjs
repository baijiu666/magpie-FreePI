import test from "node:test"
import assert from "node:assert/strict"

import {
  completeLogin,
  expiresAt,
  handleOf,
  jwtPayload,
  normalizeToken,
  sessionIdOf,
  startDeviceFlow,
  tokenOf,
  uidOf,
} from "../src/auth.mjs"
import { makeToken } from "./helpers.mjs"

const TOKEN = makeToken({ sub: "225b3da0-718e-4c8b-8c6f-7bb276db403b", iat: 1_760_000_000, exp: 1_767_760_000 })

test("tokenOf 同时认 oauth 的 access 与 api 的 key", () => {
  assert.equal(tokenOf({ access: " a " }), "a")
  assert.equal(tokenOf({ key: "k" }), "k")
  assert.equal(tokenOf({}), "")
  assert.equal(tokenOf(null), "")
})

test("normalizeToken 去掉 Bearer 前缀", () => {
  assert.equal(normalizeToken("Bearer abc"), "abc")
  assert.equal(normalizeToken("  abc  "), "abc")
})

test("jwtPayload / expiresAt 读 sub 与 exp", () => {
  assert.equal(jwtPayload(TOKEN)?.sub, "225b3da0-718e-4c8b-8c6f-7bb276db403b")
  assert.equal(expiresAt(TOKEN), 1_767_760_000_000)
  assert.equal(jwtPayload("not-a-jwt"), null)
  assert.equal(expiresAt(""), 0)
})

test("uidOf 优先 auth.uid，其次 JWT sub", () => {
  assert.equal(uidOf({ uid: "meta" }, TOKEN), "meta")
  assert.equal(uidOf({}, TOKEN), "225b3da0-718e-4c8b-8c6f-7bb276db403b")
})

test("handleOf 只取 handle；UUID 不会混进 accountId", () => {
  assert.equal(handleOf({ handle: "999AAAXXX", user_id: "225b3da0-718e-4c8b-8c6f-7bb276db403b" }), "999AAAXXX")
  assert.equal(handleOf({ user_id: "225b3da0-718e-4c8b-8c6f-7bb276db403b" }), "")
})

test("sessionIdOf 稳定且不含 token 原文", () => {
  const a = sessionIdOf({ access: TOKEN })
  assert.equal(a, sessionIdOf({ access: TOKEN }))
  assert.equal(a, "magpie-225b3da0718e")
  assert.ok(!a.includes(TOKEN))
})

test("completeLogin 用 handle 当名字，UUID 只进 uid", async () => {
  const client = {
    async me() {
      return {
        status: 200,
        data: {
        user_id: "225b3da0-718e-4c8b-8c6f-7bb276db403b",
        handle: "999AAAXXX",
        tier: "young",
        allowance_credits: 15_000,
        remaining_credits_today: 14_989,
        },
      }
    },
  }
  let registered = 0
  let forced = 0
  const adKeeper = {
    register() {
      registered += 1
    },
    async force() {
      forced += 1
      return { ok: true }
    },
  }

  const result = await completeLogin(TOKEN, { client, adKeeper })
  assert.equal(result.type, "success")
  assert.equal(result.access, TOKEN)
  assert.equal(result.refresh, "")
  assert.equal(result.accountId, "999AAAXXX")
  assert.equal(result.uid, "225b3da0-718e-4c8b-8c6f-7bb276db403b")
  assert.equal(result.expires, 1_767_760_000_000)
  assert.equal(result.metadata.tier, "young")
  assert.equal(registered, 1)
  assert.equal(forced, 1)
})

test("completeLogin 对 401 抛 sessionExpired，对网络错误抛 upstreamUnavailable", async () => {
  await assert.rejects(
    () => completeLogin(TOKEN, { client: { me: async () => ({ status: 401, data: { code: "unauthorized" } }) } }),
    (error) => error.code === "session_expired" && error.status === 401,
  )
  await assert.rejects(
    () => completeLogin(TOKEN, { client: { me: async () => { throw new Error("ECONNRESET") } } }),
    (error) => error.code === "upstream_unavailable" && error.status === 503,
  )
})

test("设备码：pending 两次后拿到 token", async () => {
  let polls = 0
  const client = {
    async deviceStart() {
      return { status: 200, data: {
        session_id: "sess-1",
        user_code: "259F-5565",
        verification_uri: "https://github.com/login/device",
        verification_uri_complete: "https://github.com/login/device?user_code=259F-5565",
        interval: 5,
        expires_in: 900,
      } }
    },
    async deviceToken(sessionId) {
      assert.equal(sessionId, "sess-1")
      polls += 1
      return polls < 3
        ? { status: 404, data: { code: "authorization_pending" } }
        : { status: 200, data: { token: "tok-1" } }
    },
  }

  const flow = await startDeviceFlow({ client })
  assert.equal(flow.userCode, "259F-5565")
  assert.equal(flow.verificationUriComplete, "https://github.com/login/device?user_code=259F-5565")

  const waits = []
  const token = await flow.waitForToken({
    sleepImpl: async (ms) => {
      waits.push(ms)
    },
  })
  assert.equal(token, "tok-1")
  assert.deepEqual(waits, [5_000, 5_000, 5_000])
})

test("设备码：access_denied 立刻失败，不再空转到过期", async () => {
  const client = {
    async deviceStart() {
      return { status: 200, data: { session_id: "s", user_code: "C", interval: 5, expires_in: 900 } }
    },
    async deviceToken() {
      return { status: 400, data: { code: "access_denied" } }
    },
  }
  const flow = await startDeviceFlow({ client })
  await assert.rejects(
    () => flow.waitForToken({ sleepImpl: async () => {} }),
    (error) => error.code === "sign_in_required",
  )
})

test("设备码：发起失败给出上游原文", async () => {
  const client = {
    async deviceStart() {
      return { status: 503, data: { message: "github unavailable" } }
    },
  }
  await assert.rejects(
    () => startDeviceFlow({ client }),
    (error) => error.message.includes("github unavailable"),
  )
})
