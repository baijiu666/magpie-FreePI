// src/provider.mjs —— free-pi 的固定事实：地址、请求头、免费模型表、图标。
//
// 来源只有两处：
//   · 同工作区的 freepi-proxy/freepi_proxy.py（本插件取代的 Python 反代）
//   · 2026-11-12 对 api.freepi.ai 的真机实测
//
// 上游没有 /v1/models（实测 404），所以模型表必须静态写死；新增免费模型时改
// FREE_MODEL_DEFS 一处，config 与 provider.models 会同时生效。

export const PROVIDER = "freepi"
export const PROVIDER_NAME = "free-pi"

/** 协议根地址。chat 在 /v1/chat/completions，账号/广告/登录都在根下。 */
export const ORIGIN = "https://api.freepi.ai"
/** magpie 的 provider.api / loader.baseURL：OpenAI 兼容前缀。 */
export const BASE = `${ORIGIN}/v1`

export const SDK = "@ai-sdk/openai-compatible"

/**
 * 官方客户端版本。反代 0.6.19 实测可用；上游按它判断客户端能力，
 * 升级时先改这里再重新跑 scripts/probe-live.mjs。
 */
export const CLIENT_VERSION = "0.6.19"

/** /me 额度缓存：60 秒（反代同值）。 */
export const ME_TTL_MS = 60_000
/** 单轮对话墙钟：反代给 600 秒。 */
export const CHAT_TIMEOUT_MS = 600_000
/** 普通 JSON 请求超时。 */
export const REQUEST_TIMEOUT_MS = 30_000

/**
 * 插件图标：与反代面板同一个 π。
 * ⚠ 两处都要写：auth.icon 管供应商卡片，package.json 的 magpie.icon 管插件卡片。
 */
export const ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImciIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiM1YjhjZmYiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiM3YzVjZmYiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSJ1cmwoI2cpIi8+PHRleHQgeD0iNjQiIHk9Ijg5IiBmb250LWZhbWlseT0iR2VvcmdpYSwgJ1RpbWVzIE5ldyBSb21hbicsIHNlcmlmIiBmb250LXNpemU9IjcyIiBmb250LXdlaWdodD0iNzAwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjZmZmIj4mIzk2MDs8L3RleHQ+PC9zdmc+"

/**
 * 官方 free-pi-cli（0.6.19）的模型事实：
 *   · 目录来自 GET /client-version 的 `models`（动态，provider.models 会去拉）；
 *   · provider 配置固定 CONTEXT_WINDOW=200000、MAX_OUTPUT_TOKENS=8192；
 *   · reasoning=true，工具由 agent 统一提供，cost 全 0（真正的成本是 credits）。
 *   · input 模态**不照抄 CLI 的 ["text"]**：CLI 的 agent 走单独的 vision 工具，
 *     把模型请求固定成 text；Magpie 是直接透传图片的，所以按实测/站点详情页标：
 *     deepseek-v4.1-flash / glm-5.3-flash / kimi-k3.1-pro / mimo-v2.6-flash 支持图片。
 *
 * 这份 MODEL_DEFS 是 /client-version 不可达时的静态兜底，内容与该接口 2026-11-12
 * 的可用模型一致（18 个里去掉 2 个 unavailable 的 Gemini）。
 * free=true 只给官方标 Free Unlimited 的 4 个；rate 是官方 usage_x。
 */
export const CLI_CONTEXT_WINDOW = 200_000
export const CLI_MAX_OUTPUT = 8_192
export const CONSENT_VERSION = "4"

/** 实测/站点确认的多模态输入（没列出的模型一律 text-only）。 */
export const MODEL_INPUTS = Object.freeze({
  "deepseek-v4.1-flash": ["text", "image"],
  "glm-5.3-flash": ["text", "image", "video"],
  "kimi-k3.1-pro": ["text", "image", "video"],
  "mimo-v2.6-flash": ["text", "image", "audio", "video"],
})

export const MODEL_DEFS = Object.freeze([
  // ── 免费无限（Free first 会优先派发；CLI 的默认是 models[0] = particle） ──
  { id: "particle", name: "Particle", free: true, default: true },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", free: true },
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", free: true },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", free: true },

  // ── 按用量计费（消耗今日积分；rate 是官方 usage_x） ───────────────
  { id: "solar-pro-4", name: "Solar Pro 4", rate: "x0.6" },
  { id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash (Xiaomi)", rate: "x2.8" },
  { id: "qwen3.5-35b-darkbloom", name: "Qwen3.5 35B (Darkbloom)", rate: "x2.9" },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", rate: "x18" },
  { id: "abliterated-large-flash", name: "Abliterated Large Flash · Defense", rate: "x20" },
  { id: "deepseek-v4.1-flash-abliterated", name: "DeepSeek V4.1 Flash Abliterated · Defense", rate: "x20" },
  { id: "gemma-4-uncensored", name: "Gemma 4 Uncensored · Defense", rate: "x20" },
  { id: "glm-4.7-flash-heretic", name: "GLM 4.7 Flash Heretic · Defense", rate: "x20" },
  { id: "qwen3.6-plus-uncensored", name: "Qwen 3.6 Plus Uncensored · Defense", rate: "x20" },
  { id: "uncensored-1.2", name: "Uncensored 1.2 · Defense", rate: "x20" },
  { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro · daily limit", rate: "x41" },
  { id: "abliterated-large-v2", name: "Abliterated Large V2 · Defense", rate: "x60" },
  { id: "deepseek-v4.1-flash-1017-ultrafast", name: "DeepSeek V4.1 Flash Ultrafast", rate: "x295" },
])

/** 一条模型；上下文/输出/工具/推理按 CLI，输入模态按 MODEL_INPUTS。 */
export function modelEntry(def) {
  const inputs = Array.isArray(def.inputs) && def.inputs.length > 0
    ? def.inputs
    : (MODEL_INPUTS[def.id] ?? ["text"])
  const flags = {
    text: inputs.includes("text"),
    image: inputs.includes("image"),
    audio: inputs.includes("audio"),
    video: inputs.includes("video"),
    pdf: inputs.includes("pdf"),
  }
  const attachment = flags.image || flags.audio || flags.video || flags.pdf

  return {
    id: def.id,
    name: def.name || def.id,
    api: { id: def.id, url: BASE, npm: SDK },
    status: "active",
    free: def.free === true,
    ...(def.rate ? { rate: def.rate } : {}),
    ...(def.default ? { default: true } : {}),
    limit: { context: CLI_CONTEXT_WINDOW, output: CLI_MAX_OUTPUT },
    // config 钩子的静态模型读 tool_call；provider.models 读 toolcall。两个都写，互不为害。
    tool_call: true,
    toolcall: true,
    attachment,
    modalities: { input: [...inputs], output: ["text"] },
    capabilities: {
      temperature: true,
      reasoning: true,
      toolcall: true,
      attachment,
      input: { ...flags },
      output: { text: true },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  }
}

/** `{id: entry}` 表 —— config 钩子和 provider.models 都要这个形状。 */
function modelEntries() {
  const out = {}
  for (const def of MODEL_DEFS) out[def.id] = modelEntry(def)
  return out
}

/** 只给 config 钩子用；内容是静态兜底，未登录也有完整表，不会显示 0 models。 */
export function modelsForConfig() {
  return modelEntries()
}

/** provider.models 的静态兜底；正常情况下会被 /client-version 的动态目录替换。 */
export function modelsForProvider() {
  return modelEntries()
}

/** magpie 可能把 `freepi/deepseek-v4.1-flash` 整串递过来；上游只认裸 id。 */
export function stripModelPrefix(model) {
  const raw = String(model ?? "").trim()
  return raw.startsWith(`${PROVIDER}/`) ? raw.slice(PROVIDER.length + 1) : raw
}
