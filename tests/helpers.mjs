// tests/helpers.mjs —— 只放测试用的小工具，不参与打包。

export function b64url(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let bin = ""
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "")
}

/** 造一个只有 payload 有意义的 JWT。 */
export function makeToken(payload = {}) {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.test-signature`
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  })
}

export function sse(body = "data: {}\n\n") {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  })
}
