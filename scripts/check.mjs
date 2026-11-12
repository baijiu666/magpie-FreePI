#!/usr/bin/env node
// scripts/check.mjs —— 交付前的形状检查（不是语义测试）。
//
//   node scripts/check.mjs         检查当前仓库
//   node scripts/check.mjs ../x    检查别的插件目录
//
// 查的是「少写一项会静默失效」的东西：模型表非空、能力布尔值、入口唯一函数、
// 图标两处都有、包名是 slug、源码里没有本机路径 / 真 token。

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const ROOT = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".."))
const problems = []

function fail(message) {
  problems.push(message)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"))
  } catch (error) {
    fail(`${file} 读不了：${error.message}`)
    return null
  }
}

const pkg = readJson("package.json")
if (pkg) {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(pkg.name ?? "")) fail(`package.json name 不是 slug：${pkg.name}`)
  if (!pkg.version) fail("package.json 缺 version")
  if (pkg.type !== "module") fail('package.json type 必须是 "module"')
  if (!pkg.main) fail("package.json 缺 main")
  if (!pkg.exports) fail("package.json 缺 exports")
  if (!pkg.license) fail("package.json 缺 license")
  if (!pkg.engines?.node) fail("package.json 缺 engines.node")
  if (typeof pkg.magpie?.icon !== "string" || !pkg.magpie.icon.startsWith("data:image/")) {
    fail("package.json 缺 magpie.icon（插件卡片会变灰方块）")
  }
  if (!Number.isInteger(pkg.magpie?.maxConcurrency) || pkg.magpie.maxConcurrency <= 0) {
    fail("package.json 缺 magpie.maxConcurrency")
  }
}

const registry = readJson("registry-entry.json")
if (registry) {
  if (registry.package !== pkg?.name) fail("registry-entry.json 的 package 与 package.json 不一致")
  if (!Array.isArray(registry.providers) || registry.providers.length === 0) fail("registry-entry.json 缺 providers")
  if (!registry.summary?.zh || !registry.summary?.en) fail("registry-entry.json 缺 summary.zh / summary.en")
}

for (const file of ["README.md", "ERROR-CODES.md", "CHANGELOG.md", "LICENSE"]) {
  if (!fs.existsSync(path.join(ROOT, file))) fail(`缺 ${file}`)
}

// ---- 源码：本机路径 / 真 token / 入口唯一函数 ----
const sourceFiles = []
for (const dir of [".", "src"]) {
  const base = path.join(ROOT, dir)
  if (!fs.existsSync(base)) continue
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue
    sourceFiles.push(path.join(base, entry.name))
  }
}

const SECRET_PATTERNS = [
  [/(?:[A-Za-z]:)(?:\\|\/)(?:Users|AI|渗透)(?:\\|\/)/u, "源码里出现本机绝对路径"],
  [/eyJhbGciOiJIUzI1NiJ9\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/u, "源码里出现疑似真 JWT"],
]

for (const file of sourceFiles) {
  const text = fs.readFileSync(file, "utf8")
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(text)) fail(`${path.relative(ROOT, file)}：${label}`)
  }
}

const mod = await import(pathToFileURL(path.join(ROOT, "index.mjs")).href)
const exportedFunctions = Object.entries(mod).filter(([, value]) => typeof value === "function")
if (exportedFunctions.length !== 1) {
  fail(`入口必须只导出一个函数，现在有 ${exportedFunctions.length} 个：${exportedFunctions.map(([n]) => n).join(", ")}`)
}

const plugin = await exportedFunctions[0]?.[1]?.(
  {},
  { fetch: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }) },
)
if (!plugin) {
  fail("插件入口没有返回钩子对象")
} else {
  for (const hook of ["config"]) if (typeof plugin[hook] !== "function") fail(`缺钩子 ${hook}`)
  if (!plugin.auth) fail("缺 auth 钩子")
  if (plugin.auth?.provider !== "freepi") fail(`auth.provider 应为 freepi，实际 ${plugin.auth?.provider}`)
  if (!Array.isArray(plugin.auth?.methods) || plugin.auth.methods.length === 0) fail("缺登录方式")
  if (typeof plugin.auth?.loader !== "function") fail("缺 auth.loader")
  if (typeof plugin.auth?.usage !== "function") fail("缺 auth.usage")
  if (plugin.provider?.id !== "freepi") fail(`provider.id 应为 freepi，实际 ${plugin.provider?.id}`)
  if (typeof plugin.provider?.models !== "function") fail("缺 provider.models")

  const cfg = {}
  await plugin.config(cfg)
  const models = cfg.provider?.freepi?.models ?? {}
  if (Object.keys(models).length === 0) fail("config.models 为空（界面会显示 0 models）")
  for (const [id, model] of Object.entries(models)) {
    if (model.id !== id) fail(`模型 ${id} 的 id 不一致`)
    if (!model.name) fail(`模型 ${id} 缺 name`)
    if (typeof model.free !== "boolean") fail(`模型 ${id} 的 free 必须是布尔值`)
    if (typeof model.capabilities?.input?.image !== "boolean") {
      fail(`模型 ${id} 的 capabilities.input.image 必须是布尔值`)
    }
    if (!Array.isArray(model.modalities?.input) || !Array.isArray(model.modalities?.output)) {
      fail(`模型 ${id} 的 modalities 不全`)
    }
  }
}

if (problems.length) {
  console.error(`✗ ${problems.length} 项不合规：`)
  for (const problem of problems) console.error(`  · ${problem}`)
  process.exit(1)
}
console.log("✓ 形状检查通过")
