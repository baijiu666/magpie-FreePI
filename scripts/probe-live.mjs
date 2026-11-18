#!/usr/bin/env node
// scripts/probe-live.mjs —— 真机自检（会花少量免费额度）。
//
//   FREEPI_TOKEN=eyJ... node scripts/probe-live.mjs
//   node scripts/probe-live.mjs --token eyJ...
//   node scripts/probe-live.mjs --accounts D:\AI\magpie\freepi-proxy\accounts.json
//
// 做三件事：/me 读账号、强制刷一轮广告、发一条 8 token 的对话。
// 全部 200 才算通过；任何一步失败退出码 1。

import fs from "node:fs"
import { normalizeToken } from "../src/auth.mjs"
import { createClient } from "../src/client.mjs"
import { createAdKeeper } from "../src/ads.mjs"
import { CLIENT_VERSION } from "../src/provider.mjs"

function argOf(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : ""
}

let token = normalizeToken(process.env.FREEPI_TOKEN || argOf("--token"))
const accountsPath = argOf("--accounts")
if (!token && accountsPath) {
  try {
    const list = JSON.parse(fs.readFileSync(accountsPath, "utf8"))
    token = normalizeToken(list?.[0]?.token)
    if (token) console.log(`从 ${accountsPath} 读到 ${list.length} 个账号，使用第 1 个`)
  } catch (error) {
    console.error(`读 ${accountsPath} 失败：${error.message}`)
    process.exit(2)
  }
}
if (!token) {
  console.error("缺 token：设 FREEPI_TOKEN，或传 --token / --accounts <accounts.json>")
  process.exit(2)
}
console.log(`token: ${token.slice(0, 12)}…（${token.length} 字符）`)

const client = createClient()

const me = await client.me(token)
if (me.status !== 200) {
  console.error(`/me 失败：HTTP ${me.status} ${me.text.slice(0, 200)}`)
  process.exit(1)
}
const profile = me.data ?? {}
console.log(`/me 200  handle=${profile.handle ?? "?"} tier=${profile.tier ?? "?"} `
  + `credits=${profile.remaining_credits_today ?? "?"}/${profile.allowance_credits ?? "?"}`)

const keeper = createAdKeeper({ client })
const ads = await keeper.force({ access: token, uid: profile.user_id })
console.log(`ads ${ads?.ok ? "ok" : "FAILED"}${ads?.error ? `：${ads.error}` : ""}`)

const res = await client.chat({
  token,
  stream: false,
  headers: { "x-client-version": CLIENT_VERSION, "x-ad-context": "none" },
  bodyText: JSON.stringify({
    model: "deepseek-v4.1-flash",
    messages: [{ role: "user", content: "Reply with the single word OK." }],
    max_tokens: 64,
    stream: false,
  }),
})
const text = await res.text()
let content = ""
let model = ""
try {
  const body = JSON.parse(text)
  content = body?.choices?.[0]?.message?.content ?? ""
  model = body?.model ?? ""
} catch {
  // 保留原文给下面打印
}
console.log(`chat ${res.status} model=${model || "?"} content=${JSON.stringify(content)}`)
if (res.status !== 200) console.log(text.slice(0, 400))

if (res.status !== 200 || !ads?.ok) process.exit(1)
console.log("✓ 真机自检通过")
