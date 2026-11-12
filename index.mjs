// magpie-FreePI —— free-pi（freepi.ai）免费模型池的 magpie 插件。
//
// 上游是 OpenAI 兼容的反代，但免费额度靠两类额外动作维持：
//   ① 每 150 秒看两条广告并上报曝光（src/ads.mjs）
//   ② 同一账号同时只允许一个请求，卡住时 /session/reset（src/relay.mjs）
// 本插件把这两件事都放在进程内完成，不再需要 freepi-proxy 的 Python 进程。
//
// index.mjs 只做钩子的装配，协议实现全在 src/。

import {
  BASE,
  CONSENT_VERSION,
  ICON,
  PROVIDER,
  PROVIDER_NAME,
  SDK,
  modelsForConfig,
  modelsForProvider,
} from "./src/provider.mjs"
import { completeLogin, startDeviceFlow, tokenOf } from "./src/auth.mjs"
import { createClient } from "./src/client.mjs"
import { createAdKeeper } from "./src/ads.mjs"
import { createUsageReader } from "./src/usage.mjs"
import { createCatalogReader } from "./src/catalog.mjs"
import { createRelay } from "./src/relay.mjs"

const VERSION = "0.1.7"

function errorText(error) {
  return String(error?.message ?? error ?? "登录失败")
}

export const FreePiPlugin = async (_ctx = {}, options = {}) => {
  const fetchImpl = typeof options?.fetch === "function" ? options.fetch : globalThis.fetch
  const client = createClient({ fetchImpl })
  // 日志是可选的：magpie 没给就静默，测试时可以注入。
  const adKeeper = createAdKeeper({ client, fetchImpl, logger: options?.logger })
  const usageReader = createUsageReader({ client, adKeeper })
  const catalogReader = createCatalogReader({ client })
  const complete = (token) => completeLogin(token, { client, adKeeper })

  return {
    // ═══ ① provider 与静态模型表 ═══════════════════════════════════════
    config: async (cfg) => {
      cfg.provider ??= {}
      // 用户已经在 plugins.json 里配了 provider 段落就完全不动它。
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: SDK,
        api: BASE,
        // 未登录也必须有内容，否则界面显示 0 models。
        models: modelsForConfig(),
        // 上游没有 web_search 通道，别让 magpie 以为它会搜。
        searches: false,
      }
    },

    auth: {
      provider: PROVIDER,
      icon: ICON,
      // 服务端硬限制：同一账号同时只跑 1 个请求；多账号由 magpie 并发调度。
      maxConcurrency: 1,

      // ═══ ② 登录 ═══════════════════════════════════════════════════════
      methods: [
        {
          type: "oauth",
          label: "GitHub 设备码登录（推荐）",
          /**
           * 发起设备码只打一次 POST，不等待用户 —— 真正的等待在 callback 的轮询里。
           * Magpie 打开 verification_uri_complete，GitHub 会预填 user_code。
           * 条款不在这里弹（见 README「登录与条款」），但仍按 CLI 自动提交 consent。
           */
          async authorize() {
            const flow = await startDeviceFlow({ client })
            // CLI 的顺序：设备码会话建立后立刻提交 consent，再轮询 token。
            const consent = await client.consent(flow.sessionId, CONSENT_VERSION)
            if (consent.status !== 200) {
              throw new Error(`提交 free-pi 条款同意失败：HTTP ${consent.status}`)
            }
            return {
              url: flow.verificationUriComplete || flow.verificationUri,
              opened: false,
              method: "auto",
              instructions: flow.userCode
                ? `已打开 GitHub 授权页：输入代码 ${flow.userCode} 并确认。授权后会自动完成登录，不需要回来粘贴任何东西。`
                : "请在打开的 GitHub 页面完成授权；完成后会自动登录。",
              async callback(_value, { signal } = {}) {
                try {
                  const token = await flow.waitForToken({ signal })
                  return await complete(token)
                } catch (error) {
                  return { type: "failed", error: errorText(error) }
                }
              },
            }
          },
        },

        {
          type: "oauth",
          label: "粘贴 Bearer token",
          // 手里已经有 token（例如从 freepi-proxy/accounts.json 拷出来的）时用这条。
          get prompts() {
            return [{
              type: "text",
              key: "token",
              message: "粘贴 free-pi 的 Bearer token（accounts.json 里的 token 字段）",
              placeholder: "eyJhbGciOiJIUzI1NiJ9...",
              validate: (value) => (String(value ?? "").trim().length >= 20 ? undefined : "token 太短"),
            }]
          },
          async authorize(inputs) {
            const token = String(inputs?.token ?? "").trim()
            if (!token) throw new Error("token 为空")
            return {
              // 空 url + opened: true：不要让 magpie 去开 about:blank。
              url: "",
              opened: true,
              method: "auto",
              instructions: "正在向 free-pi 验证 token…",
              async callback() {
                try {
                  return await complete(token)
                } catch (error) {
                  return { type: "failed", error: errorText(error) }
                }
              },
            }
          },
        },
      ],

      // ═══ ③ 续期 ═══════════════════════════════════════════════════════
      // token 是 90 天 JWT，上游没有 refresh_token / 续期端点。
      // 不实现 refresh：到期后 /me 或对话返回 401，magpie 会标记账号并提示重新登录。

      // ═══ ④ 请求接管 ═══════════════════════════════════════════════════
      async loader(getAuth) {
        const auth = await getAuth()
        if (!tokenOf(auth)) return {}
        // CLI 的 session_start：首次加载就取一条 launch banner。
        adKeeper.kick(auth)

        return {
          baseURL: BASE,
          // 鉴权头由 fetch 自己加（oauth 读 access，api 读 key）。
          apiKey: "",
          headers: { "user-agent": `magpie-freepi/${VERSION}` },
          fetch: createRelay({ getAuth, client, adKeeper }),
        }
      },

      // ═══ ⑤ 额度 ═══════════════════════════════════════════════════════
      async usage(getAuth) {
        let auth
        try {
          auth = await getAuth()
        } catch {
          return { error: "读取登录态失败", windows: [] }
        }
        if (!tokenOf(auth)) return { error: "未登录", windows: [] }
        return usageReader.read(auth)
      },
    },

    // ═══ ⑦ 每账号模型目录 ═════════════════════════════════════════════
    provider: {
      id: PROVIDER,
      async models(_fallback, { auth } = {}) {
        if (auth && tokenOf(auth)) {
          try {
            adKeeper.kick(auth)
          } catch {
            // 登记失败不影响目录
          }
          // 官方 CLI 的目录：GET /client-version。失败才回静态兜底。
          const models = await catalogReader.read(auth)
          if (models && Object.keys(models).length > 0) return models
        }
        return modelsForProvider()
      },
    },
  }
}
