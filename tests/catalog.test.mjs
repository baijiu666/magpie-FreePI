import test from "node:test"
import assert from "node:assert/strict"

import {
  CLI_CONTEXT_WINDOW,
  CLI_MAX_OUTPUT,
  MODEL_DEFS,
  MODEL_INPUTS,
  modelsForConfig,
  modelsForProvider,
  stripModelPrefix,
} from "../src/provider.mjs"
import { catalogName, createCatalogReader, entryFromCatalog, modelsFromCatalog } from "../src/catalog.mjs"

const FREE_IDS = ["deepseek-v4.1-flash", "deepseek-v4-flash", "glm-5.3-flash", "particle"]

test("静态兜底表与 /client-version 的可用模型一致（18 条）", () => {
  const config = modelsForConfig()
  const provider = modelsForProvider()
  assert.equal(Object.keys(config).length, 18)
  assert.equal(Object.keys(config).length, MODEL_DEFS.length)
  assert.deepEqual(Object.keys(provider).sort(), Object.keys(config).sort())
  assert.equal(new Set(MODEL_DEFS.map((d) => d.id)).size, MODEL_DEFS.length, "id 不能重复")
})

test("free 只给官方 Free Unlimited 的 4 个，其余带 usage_x 倍率", () => {
  const models = modelsForProvider()
  for (const id of FREE_IDS) {
    assert.equal(models[id].free, true, `${id} 应免费`)
    assert.equal(models[id].rate, undefined, `${id} 不该有倍率`)
  }
  for (const [id, model] of Object.entries(models)) {
    if (FREE_IDS.includes(id)) continue
    assert.equal(model.free, false, `${id} 不该标免费`)
    assert.match(String(model.rate), /^x\d+(\.\d+)?$/u, `${id} 应有 usage_x 倍率`)
  }
})

test("上下文/输出/reasoning/工具按 CLI；输入模态按 MODEL_INPUTS", () => {
  for (const [id, model] of Object.entries(modelsForProvider())) {
    const inputs = MODEL_INPUTS[id] ?? ["text"]
    const attachment = inputs.some((x) => x !== "text")
    assert.equal(model.id, id)
    assert.deepEqual(model.limit, { context: CLI_CONTEXT_WINDOW, output: CLI_MAX_OUTPUT }, id)
    assert.deepEqual(model.modalities.input, inputs, id)
    assert.equal(model.capabilities.input.image, inputs.includes("image"), id)
    assert.equal(model.capabilities.attachment, attachment, id)
    assert.equal(model.capabilities.reasoning, true, id)
    assert.equal(model.capabilities.toolcall, true, id)
    assert.equal(model.tool_call, true, id)
    assert.equal(model.toolcall, true, id)
    assert.deepEqual(model.cost, { input: 0, output: 0, cache: { read: 0, write: 0 } }, id)
  }
})

test("多模态只给实测/站点确认的 4 个模型", () => {
  const m = modelsForProvider()
  assert.deepEqual(m["deepseek-v4.1-flash"].modalities.input, ["text", "image"])
  assert.deepEqual(m["glm-5.3-flash"].modalities.input, ["text", "image", "video"])
  assert.deepEqual(m["kimi-k3.1-pro"].modalities.input, ["text", "image", "video"])
  assert.deepEqual(m["mimo-v2.6-flash"].modalities.input, ["text", "image", "audio", "video"])
  for (const id of ["deepseek-v4-flash", "particle", "deepseek-v4-pro", "solar-pro-4", "uncensored-1.2"]) {
    assert.deepEqual(m[id].modalities.input, ["text"], id)
    assert.equal(m[id].capabilities.input.image, false, id)
  }
})

test("默认模型与倍率抽查", () => {
  const m = modelsForProvider()
  // CLI 的默认是 models[0]（catalog 第一条 main = particle）
  assert.equal(m["particle"].default, true)
  assert.equal(m["deepseek-v4.1-flash"].default, undefined)
  assert.equal(m["hy4-flash"].rate, "x0.2")
  assert.equal(m["solar-pro-4"].rate, "x1.2")
  assert.equal(m["mimo-v2.6-flash"].rate, "x0.8")
  assert.equal(m["qwen3.5-35b-darkbloom"].rate, "x2.1")
  assert.equal(m["deepseek-v4-pro"].rate, "x5.9")
  assert.equal(m["kimi-k3.1-pro"].rate, "x22")
  assert.match(m["kimi-k3.1-pro"].name, /premium credits/u)
  assert.match(m["abliterated-large-v2"].name, /Defense/u)
  assert.equal(m["abliterated-large-v2"].rate, "x60")
  assert.equal(m["deepseek-v4.1-flash-1017-ultrafast"].rate, "x1.6")
})

test("目录条目：free/usage_x/section/note/unavailable 的映射", () => {
  const catalog = {
    models: [
      { id: "particle", name: "Particle · 🔥 Free Unlimited: limited time", display_name: "Particle", free: true, usage_x: null },
      { id: "deepseek-v4.1-flash-1017-ultrafast", display_name: "DeepSeek V4.1 Flash 600tps", free: false, usage_x: "1.6" },
      { id: "uncensored-1.2", display_name: "Uncensored 1.2", free: false, usage_x: "20", section: "defense", note: null },
      { id: "kimi-k3.1-pro", display_name: "Kimi K3.1 Pro", free: false, usage_x: "22", note: "premium credits" },
      { id: "gemini-4-argon", display_name: "Gemini 4 Argon", free: false, usage_x: null, unavailable: true },
    ],
  }
  const models = modelsFromCatalog(catalog, { defaultId: "particle" })
  assert.equal(Object.keys(models).length, 4, "unavailable 的不列")
  assert.equal(models.particle.free, true)
  assert.equal(models.particle.default, true)
  assert.equal(models["deepseek-v4.1-flash-1017-ultrafast"].name, "DeepSeek V4.1 Flash 600tps")
  assert.equal(models["deepseek-v4.1-flash-1017-ultrafast"].rate, "x1.6")
  assert.equal(models["uncensored-1.2"].name, "Uncensored 1.2 · Defense")
  assert.equal(models["kimi-k3.1-pro"].name, "Kimi K3.1 Pro · premium credits")
  assert.equal(models["kimi-k3.1-pro"].rate, "x22")
  assert.equal(entryFromCatalog(null), null)

  // 不传 defaultId 时按 CLI 的 models[0] 自动选第一条 main（particle）
  const auto = modelsFromCatalog(catalog)
  assert.equal(auto.particle.default, true)
  assert.equal(auto["uncensored-1.2"].default, undefined)
})

test("catalogName 清理官方 name 里的用量后缀", () => {
  assert.equal(
    catalogName({ display_name: "DeepSeek V4 Flash", name: "DeepSeek V4 Flash · 🔥 Free Unlimited: limited time", free: true }),
    "DeepSeek V4 Flash",
  )
  assert.equal(
    catalogName({ name: "Solar Pro 4 · ~0.6x usage" }),
    "Solar Pro 4",
  )
  assert.equal(
    catalogName({ display_name: "Kimi K3.1 Pro", note: "premium credits" }),
    "Kimi K3.1 Pro · premium credits",
  )
})

test("createCatalogReader：缓存、失败回退、并发合并", async () => {
  let calls = 0
  let fail = false
  const client = {
    async clientVersion() {
      calls += 1
      if (fail) throw new Error("network down")
      return {
        status: 200,
        data: { models: [{ id: "particle", display_name: "Particle", free: true }] },
      }
    },
  }
  let clock = 0
  const reader = createCatalogReader({ client, ttlMs: 1000, now: () => clock })
  const auth = { access: "tok" }

  const [a, b] = await Promise.all([reader.read(auth), reader.read(auth)])
  assert.equal(Object.keys(a).length, 1)
  assert.equal(Object.keys(b).length, 1)
  assert.equal(calls, 1, "并发只打一次上游")

  clock = 500
  await reader.read(auth)
  assert.equal(calls, 1, "TTL 内走缓存")

  clock = 2000
  fail = true
  const fallback = await reader.read(auth)
  assert.equal(Object.keys(fallback).length, 1, "失败回上次成功的表")

  clock = 5000
  fail = true
  reader.clear("tok")
  assert.equal(await reader.read(auth), null, "没有缓存时返回 null 让调用方用静态兜底")
})

test("stripModelPrefix 去掉 magpie 的 provider 前缀", () => {
  assert.equal(stripModelPrefix("freepi/deepseek-v4.1-flash"), "deepseek-v4.1-flash")
  assert.equal(stripModelPrefix("deepseek-v4.1-flash"), "deepseek-v4.1-flash")
  assert.equal(stripModelPrefix("  freepi/particle  "), "particle")
  assert.equal(stripModelPrefix(""), "")
})
