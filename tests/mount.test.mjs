import test from "node:test"
import assert from "node:assert/strict"

import * as mod from "../index.mjs"
import { json, makeToken, sse } from "./helpers.mjs"

const TOKEN = makeToken({ sub: "uuid-mount" })

function fetchMock(overrides = {}) {
  const calls = []
  const impl = async (url, init = {}) => {
    const href = String(url)
    calls.push({ href, init })
    if (overrides[href]) return overrides[href](init)
    if (href.endsWith("/me")) {
      return json({
        user_id: "uuid-mount",
        handle: "999AAAXXX",
        tier: "young",
        allowance_credits: 100,
        remaining_credits_today: 50,
        refill_at: "2026-11-13T00:00:00.000Z",
      })
    }
    if (href.includes("/ads/next")) return json({ ad_id: "ad-1", click_token: "ct-1" })
    if (href.includes("/ads/impression")) return json({ ok: true })
    if (href.endsWith("/v1/chat/completions")) return sse("data: {}\n\n")
    return json({})
  }
  return { impl, calls }
}

test("入口只导出一个函数（多导一个会被当成第二个插件）", () => {
  const funcs = Object.entries(mod).filter(([, value]) => typeof value === "function")
  assert.deepEqual(funcs.map(([name]) => name), ["FreePiPlugin"])
})

test("config 钩子提供 provider 与完整静态模型表；用户已配置时不覆盖", async () => {
  const plugin = await mod.FreePiPlugin({}, { fetch: fetchMock().impl })

  const cfg = {}
  await plugin.config(cfg)
  const provider = cfg.provider.freepi
  assert.equal(provider.name, "free-pi")
  assert.equal(provider.npm, "@ai-sdk/openai-compatible")
  assert.equal(provider.api, "https://api.freepi.ai/v1")
  assert.equal(provider.searches, false)
  assert.equal(Object.keys(provider.models).length, 18)

  const custom = { provider: { freepi: { name: "自定义", models: { x: { id: "x" } } } } }
  await plugin.config(custom)
  assert.equal(custom.provider.freepi.name, "自定义")
  assert.deepEqual(Object.keys(custom.provider.freepi.models), ["x"])
})

test("auth 钩子：两条登录方式、单账号并发 1、没有签到入口", async () => {
  const plugin = await mod.FreePiPlugin({}, { fetch: fetchMock().impl })
  assert.equal(plugin.auth.provider, "freepi")
  assert.equal(plugin.auth.maxConcurrency, 1)
  assert.equal(plugin.auth.methods.length, 2)
  assert.match(plugin.auth.methods[0].label, /设备码/u)
  // 条款写在 README，设备码登录不再弹 prompt
  assert.equal(plugin.auth.methods[0].prompts, undefined)
  assert.equal(plugin.auth.methods[1].prompts[0].key, "token")
  // 没有每日签到；不实现 checkin 钩子，magpie 才不会在用量里画「立即签到」。
  assert.equal(plugin.auth.checkin, undefined)
})

test("loader 返回 baseURL / fetch，并给上游带 Bearer token", async () => {
  const mock = fetchMock()
  const plugin = await mod.FreePiPlugin({}, { fetch: mock.impl })
  const loader = await plugin.auth.loader(async () => ({ access: TOKEN, uid: "uuid-mount" }))

  assert.equal(loader.baseURL, "https://api.freepi.ai/v1")
  assert.equal(typeof loader.fetch, "function")

  const res = await loader.fetch("https://api.freepi.ai/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "particle", messages: [], stream: true }),
  })
  assert.equal(res.status, 200)

  const chatCall = mock.calls.find((c) => c.href.endsWith("/v1/chat/completions"))
  assert.ok(chatCall)
  assert.equal(chatCall.init.headers.get("authorization"), `Bearer ${TOKEN}`)
  assert.equal(chatCall.init.headers.get("accept"), "text/event-stream")
  // 官方 CLI 的 provider headers
  assert.match(chatCall.init.headers.get("x-session-id"), /^magpie-/u)
  assert.equal(chatCall.init.headers.get("x-client-version"), "0.6.23")
  assert.match(chatCall.init.headers.get("x-turn-id"), /^[0-9a-f-]{36}$/u)
  assert.equal(chatCall.init.headers.get("x-ad-context"), "none")
})

test("usage 钩子从 /me 算出已用百分比", async () => {
  const plugin = await mod.FreePiPlugin({}, { fetch: fetchMock().impl })
  const usage = await plugin.auth.usage(async () => ({ access: TOKEN, uid: "uuid-mount" }))

  assert.equal(usage.user, "999AAAXXX")
  assert.equal(usage.plan, "young")
  const quota = usage.windows[0]
  assert.equal(quota.used, 50)
  assert.equal(quota.amount, 50)
  assert.equal(quota.limit, 100)
  assert.equal(quota.resetsAt, "2026-11-13T00:00:00.000Z")
})

test("usage 钩子对 401 明确翻成 signIn expired", async () => {
  const mock = fetchMock({
    "https://api.freepi.ai/me": () => json({ code: "unauthorized" }, 401),
  })
  const plugin = await mod.FreePiPlugin({}, { fetch: mock.impl })
  const usage = await plugin.auth.usage(async () => ({ access: TOKEN, uid: "uuid-mount" }))
  assert.equal(usage.signIn, "expired")
  assert.match(usage.error, /重新登录/u)
})

test("设备码登录：authorize 返回 GitHub URL 和代码说明", async () => {
  const mock = fetchMock({
    "https://api.freepi.ai/auth/github/device": () => json({
      session_id: "sess-1",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      verification_uri_complete: "https://github.com/login/device?user_code=ABCD-1234",
      expires_in: 900,
      interval: 5,
    }),
  })
  const plugin = await mod.FreePiPlugin({}, { fetch: mock.impl })
  const flow = await plugin.auth.methods[0].authorize()

  assert.equal(flow.url, "https://github.com/login/device?user_code=ABCD-1234")
  assert.equal(flow.opened, false)
  assert.match(flow.instructions, /ABCD-1234/u)
  assert.equal(typeof flow.callback, "function")
})

test("粘贴 token 登录：callback 验证后返回 success", async () => {
  const mock = fetchMock()
  const plugin = await mod.FreePiPlugin({}, { fetch: mock.impl })
  const method = plugin.auth.methods.find((m) => m.label.includes("粘贴"))
  const flow = await method.authorize({ token: TOKEN })

  assert.equal(flow.opened, true)
  const result = await flow.callback()
  assert.equal(result.type, "success")
  assert.equal(result.accountId, "999AAAXXX")
  assert.equal(result.access, TOKEN)
})

test("provider.models 无登录时返回静态兜底目录", async () => {
  const plugin = await mod.FreePiPlugin({}, { fetch: fetchMock().impl })
  const models = await plugin.provider.models(undefined, {})
  assert.equal(Object.keys(models).length, 18)
  assert.equal(models["deepseek-v4.1-flash"].free, true)
  assert.deepEqual(models["deepseek-v4.1-flash"].limit, { context: 200000, output: 8192 })
})

test("provider.models 有登录时使用 /client-version 的动态目录", async () => {
  const mock = fetchMock({
    "https://api.freepi.ai/client-version": () => json({
      min: "0.6.21",
      latest: "0.6.22",
      models: [
        { id: "deepseek-v4.1-flash", display_name: "DeepSeek V4.1 Flash", free: true },
        { id: "kimi-k3.1-pro", display_name: "Kimi K3.1 Pro", free: false, usage_x: "22", note: "premium credits" },
        { id: "gemini-4-argon", display_name: "Gemini 4 Argon", unavailable: true },
      ],
    }),
  })
  const plugin = await mod.FreePiPlugin({}, { fetch: mock.impl })
  const models = await plugin.provider.models(undefined, { auth: { access: TOKEN, uid: "uuid-mount" } })

  assert.deepEqual(Object.keys(models).sort(), ["deepseek-v4.1-flash", "kimi-k3.1-pro"])
  assert.equal(models["deepseek-v4.1-flash"].free, true)
  assert.equal(models["kimi-k3.1-pro"].rate, "x22")
  assert.match(models["kimi-k3.1-pro"].name, /premium credits/u)
})
