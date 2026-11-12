import test from "node:test"
import assert from "node:assert/strict"

import { createRelay } from "../src/relay.mjs"
import { json, sse } from "./helpers.mjs"

const CHAT_URL = "https://api.freepi.ai/v1/chat/completions"

function clientFrom(sequence) {
  let index = 0
  const client = {
    chatCalls: [],
    resetCalls: [],
    async chat(args) {
      client.chatCalls.push(args)
      const item = sequence[Math.min(index, sequence.length - 1)]
      index += 1
      return typeof item === "function" ? item(args) : item
    },
    async sessionReset(token) {
      client.resetCalls.push({ token })
      return json({ released: true })
    },
  }
  return client
}

function adsStub() {
  const state = { turns: 0, forced: 0, turnId: "" }
  return {
    state,
    async noteUserTurn() {
      state.turns += 1
      state.turnId = `turn-test-${state.turns}`
      return state.turnId
    },
    turnIdFor() {
      return state.turnId || "turn-test"
    },
    async force() {
      state.forced += 1
      return { ok: true }
    },
    sessionFor() {
      return "magpie-test"
    },
  }
}

function relayFor(client, ads = adsStub()) {
  return {
    ads,
    fetch: createRelay({
      getAuth: async () => ({ access: "tok", uid: "uuid-1" }),
      client,
      adKeeper: ads,
      sleepImpl: async () => {},
    }),
  }
}

const chatInit = (body) => ({ method: "POST", body: JSON.stringify(body) })

test("/models 由插件自己回答，不打上游", async () => {
  const client = clientFrom([json({ nope: true }, 500)])
  const { fetch: relay } = relayFor(client)
  const res = await relay("https://api.freepi.ai/v1/models", { method: "GET" })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.object, "list")
  assert.equal(body.data.length, 17)
  assert.equal(client.chatCalls.length, 0)
})

test("成功的流式响应原样交回（同一个 Response 对象）", async () => {
  const upstream = sse('data: {"choices":[]}\n\n')
  const client = clientFrom([upstream])
  const { fetch: relay } = relayFor(client)

  const res = await relay(CHAT_URL, chatInit({
    model: "freepi/deepseek-v4.1-flash",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  }))

  assert.equal(res, upstream)
  assert.equal(client.chatCalls.length, 1)
  assert.equal(client.chatCalls[0].stream, true)
  // 前缀被剥掉，上游只认裸 id
  assert.equal(JSON.parse(client.chatCalls[0].bodyText).model, "deepseek-v4.1-flash")
})

test("409 concurrent_session：先 /session/reset 再重试", async () => {
  const ok = json({ choices: [] })
  const client = clientFrom([json({ code: "concurrent_session" }, 409), ok])
  const { fetch: relay } = relayFor(client)

  const res = await relay(CHAT_URL, chatInit({ model: "particle", messages: [] }))
  assert.equal(res.status, 200)
  assert.equal(client.resetCalls.length, 1)
  assert.equal(client.chatCalls.length, 2)
})

test("429 concurrent：短退避重试，仍失败则落 429 rate_limited", async () => {
  // 每次调用都要新 Response —— 同一个对象读完 body 就空了
  const client = clientFrom([() => json({ code: "concurrent", message: "one request at a time" }, 429)])
  const { fetch: relay } = relayFor(client)

  const res = await relay(CHAT_URL, chatInit({ model: "particle", messages: [] }))
  assert.equal(res.status, 429)
  const body = await res.json()
  assert.equal(body.error.code, "rate_limited")
  assert.match(body.error.message, /同一账号同时只允许一个请求/u)
  assert.equal(client.chatCalls.length, 4)
})

test("429 concurrent_session 也走 /session/reset（上游两种状态码都可能）", async () => {
  const ok = json({ choices: [] })
  const client = clientFrom([json({ code: "concurrent_session" }, 429), ok])
  const { fetch: relay } = relayFor(client)

  const res = await relay(CHAT_URL, chatInit({ model: "particle", messages: [] }))
  assert.equal(res.status, 200)
  assert.equal(client.resetCalls.length, 1)
})

test("429 ads_required 也补刷广告后重试", async () => {
  const ok = json({ choices: [] })
  const client = clientFrom([json({ code: "ads_required" }, 429), ok])
  const ads = adsStub()
  const { fetch: relay } = relayFor(client, ads)

  const res = await relay(CHAT_URL, chatInit({ model: "particle", messages: [] }))
  assert.equal(res.status, 200)
  assert.equal(ads.state.forced, 1)
})

test("402 / 403 ads_required：补刷广告后重试成功", async () => {
  const ok = json({ choices: [] })
  const client = clientFrom([json({ code: "ads_required" }, 403), ok])
  const ads = adsStub()
  const { fetch: relay } = relayFor(client, ads)

  const res = await relay(CHAT_URL, chatInit({ model: "particle", messages: [] }))
  assert.equal(res.status, 200)
  assert.equal(ads.state.forced, 1)
  assert.equal(client.chatCalls.length, 2)
})

test("401 → session_expired（让 magpie 标记账号）", async () => {
  const client = clientFrom([json({ code: "unauthorized" }, 401)])
  const { fetch: relay } = relayFor(client)

  const res = await relay(CHAT_URL, chatInit({ model: "particle", messages: [] }))
  assert.equal(res.status, 401)
  const body = await res.json()
  assert.equal(body.error.code, "session_expired")
  assert.match(body.error.message, /登录/u)
})

test("403 model_requires_credits → 429（换一个账号可能就能用）", async () => {
  const client = clientFrom([
    json({ code: "model_requires_credits", message: "This model is for credit users." }, 403),
  ])
  const { fetch: relay } = relayFor(client)

  const res = await relay(CHAT_URL, chatInit({ model: "kimi-k3.1-pro", messages: [] }))
  assert.equal(res.status, 429)
  const body = await res.json()
  assert.equal(body.error.code, "rate_limited")
  assert.match(body.error.message, /kimi-k3\.1-pro/u)
  assert.match(body.error.message, /credit users/u)
  assert.equal(client.chatCalls.length, 1)
})

test("402 额度耗尽 → 429（可换号），不落不可重试的 502", async () => {
  const client = clientFrom([json({ code: "insufficient_credits", message: "no credits" }, 402)])
  const { fetch: relay } = relayFor(client)

  const res = await relay(CHAT_URL, chatInit({ model: "particle", messages: [] }))
  assert.equal(res.status, 429)
  const body = await res.json()
  assert.equal(body.error.code, "rate_limited")
  assert.match(body.error.message, /免费额度已用尽/u)
  assert.equal(client.chatCalls.length, 1)
})

test("其它上游错误原样透传（保留厂商 message）", async () => {
  const client = clientFrom([json({ error: { message: "unsupported parameter", code: "bad_request" } }, 400)])
  const { fetch: relay } = relayFor(client)

  const res = await relay(CHAT_URL, chatInit({ model: "particle", messages: [] }))
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.error.message, "unsupported parameter")
})

test("不支持的端点用 501，不用 404", async () => {
  const client = clientFrom([json({}, 200)])
  const { fetch: relay } = relayFor(client)
  const res = await relay("https://api.freepi.ai/v1/embeddings", { method: "POST", body: "{}" })
  assert.equal(res.status, 501)
  const body = await res.json()
  assert.equal(body.error.code, "not_implemented")
})

test("非法 JSON / 缺 model → 400 invalid_request", async () => {
  const client = clientFrom([json({}, 200)])
  const { fetch: relay } = relayFor(client)

  const bad = await relay(CHAT_URL, { method: "POST", body: "{oops" })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).error.code, "invalid_request")

  const noModel = await relay(CHAT_URL, { method: "POST", body: JSON.stringify({ messages: [] }) })
  assert.equal(noModel.status, 400)
  assert.equal((await noModel.json()).error.code, "invalid_request")
})

test("网络错误 → 503（可重试），超时 → 504", async () => {
  const netClient = clientFrom([() => Promise.reject(new Error("ECONNRESET"))])
  const net = await relayFor(netClient).fetch(CHAT_URL, chatInit({ model: "particle", messages: [] }))
  assert.equal(net.status, 503)
  assert.equal((await net.json()).error.code, "upstream_unavailable")

  const slowClient = clientFrom([() => Promise.reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }))])
  const slow = await relayFor(slowClient).fetch(CHAT_URL, chatInit({ model: "particle", messages: [] }))
  assert.equal(slow.status, 504)
  assert.equal((await slow.json()).error.code, "upstream_timeout")
})
