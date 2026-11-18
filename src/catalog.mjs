// src/catalog.mjs —— 官方 CLI 的模型目录。
//
// GET /client-version 返回：
//   { min, latest, model, models: [{ id, name, display_name, free, usage_x,
//     section?, note?, unavailable?, stats_id? }], fusion, experiments }
//
// 这是 free-pi-cli 0.6.23 真正用的目录（不是 freepi.ai/models 的网页表）。
// 插件用它替换静态兜底；拉不到时才回退 MODEL_DEFS。

import { modelEntry } from "./provider.mjs"
import { tokenOf } from "./auth.mjs"

/** 目录一天变不了几次；10 分钟内不重复请求。 */
const CATALOG_TTL_MS = 10 * 60_000

/** display_name 里偶尔带 🔥；名称里不再重复用量后缀（rate 胶囊会显示）。 */
function cleanName(value) {
  return String(value ?? "")
    .replace(/\s*·\s*🔥?\s*Free Unlimited: limited time\s*$/iu, "")
    .replace(/\s*·\s*daily limit(?:\s*·\s*~\d+(?:\.\d+)?x usage)?\s*$/iu, "")
    .replace(/\s*·\s*~\d+(?:\.\d+)?x usage\s*$/iu, "")
    .replace(/\s*·\s*unavailable\s*$/iu, "")
    .replace(/\s*🔥+$/u, "")
    .trim()
}

/** 目录条目 → magpie 里的显示名：clean name + Defense + note。 */
export function catalogName(model) {
  const base = cleanName(model?.display_name || model?.name || model?.id)
  const parts = [base]
  if (model?.section === "defense") parts.push("Defense")
  if (model?.note) parts.push(String(model.note))
  return parts.filter(Boolean).join(" · ")
}

/**
 * 一条目录模型 → magpie 模型条目。返回 null 表示「不列」：
 * unavailable 的（当前是 Gemini 4 Argon 两个）不列，免得用户选中必报错。
 */
export function entryFromCatalog(model, { defaultId } = {}) {
  const id = String(model?.id ?? "").trim()
  if (!id || model?.unavailable === true) return null

  const free = model?.free === true
  const usage = model?.usage_x === null || model?.usage_x === undefined
    ? ""
    : String(model.usage_x).trim()

  return modelEntry({
    id,
    name: catalogName(model),
    free,
    rate: free || !usage ? undefined : `x${usage}`,
    default: id === defaultId,
  })
}

/** 整个 /client-version 响应 → `{id: entry}`。 */
export function modelsFromCatalog(catalog, { defaultId } = {}) {
  const out = {}
  const list = Array.isArray(catalog?.models) ? catalog.models : []
  // CLI 的默认是 models[0]（main 里第一条）；目录顺序变了也跟着变。
  const firstMain = list.find((m) => m?.section !== "defense" && m?.unavailable !== true)
  const chosenDefault = defaultId ?? (firstMain?.id ? String(firstMain.id) : "")
  for (const model of list) {
    const entry = entryFromCatalog(model, { defaultId: chosenDefault })
    if (entry) out[entry.id] = entry
  }
  return out
}

/**
 * 按账号缓存目录。失败时优先回上次成功的表，再不行返回 null 让调用方用静态兜底。
 */
export function createCatalogReader({ client, ttlMs = CATALOG_TTL_MS, now = () => Date.now() } = {}) {
  if (!client) throw new Error("createCatalogReader 需要 client")

  const cache = new Map()
  const inflight = new Map()

  async function fetchCatalog(token) {
    const running = inflight.get(token)
    if (running) return running
    const task = (async () => {
      const res = await client.clientVersion(token)
      if (res.status !== 200 || !res.data) {
        const message = res.data?.message || res.data?.error?.message || ""
        throw new Error(`/client-version HTTP ${res.status}${message ? ` · ${String(message).slice(0, 120)}` : ""}`)
      }
      return res.data
    })().finally(() => inflight.delete(token))
    inflight.set(token, task)
    return task
  }

  async function read(auth, { defaultId } = {}) {
    const token = tokenOf(auth)
    if (!token) return null
    const hit = cache.get(token)
    if (hit && now() - hit.at < ttlMs) return hit.models

    try {
      const catalog = await fetchCatalog(token)
      const models = modelsFromCatalog(catalog, { defaultId })
      if (Object.keys(models).length === 0) return hit?.models ?? null
      cache.set(token, { at: now(), models })
      return models
    } catch {
      return hit?.models ?? null
    }
  }

  function clear(token) {
    cache.delete(String(token ?? ""))
  }

  return { read, clear, fetchCatalog }
}
