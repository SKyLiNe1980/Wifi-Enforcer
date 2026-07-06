/**
 * Minimal MCP Streamable-HTTP client
 * ==================================
 * Enough of the MCP 2025 Streamable-HTTP transport to drive a single
 * `tools/call` against an enforcer-mcp node from the cockpit:
 *
 *   1. POST initialize            → capture `Mcp-Session-Id` header
 *   2. POST notifications/initialized (session header)
 *   3. POST tools/call            → parse JSON-RPC result
 *   4. DELETE (best-effort session teardown)
 *
 * FastMCP replies with either `application/json` (short calls) or
 * `text/event-stream` (SSE) — we handle both. These are short request/
 * response calls, not long-lived streams, so `res.text()` is sufficient.
 */

export type McpCallResult = {
  ok: boolean;
  result?: any;
  error?: string;
  raw?: string;
};

const PROTOCOL_VERSION = "2025-06-18";

/** Parse a FastMCP response body — plain JSON or SSE `data:` frames. */
function parseBody(text: string): any {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  if (trimmed[0] === "{" || trimmed[0] === "[") {
    try { return JSON.parse(trimmed); } catch { /* maybe SSE below */ }
  }
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  // Prefer the last frame carrying a JSON-RPC result/error.
  for (let i = dataLines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(dataLines[i]);
      if (j && (j.result !== undefined || j.error !== undefined)) return j;
    } catch { /* skip */ }
  }
  for (const d of dataLines) {
    try { return JSON.parse(d); } catch { /* skip */ }
  }
  return null;
}

async function post(
  url: string,
  body: any,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; sid?: string; body: any; text: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const sid =
      r.headers.get("mcp-session-id") || r.headers.get("Mcp-Session-Id") || undefined;
    const text = await r.text();
    return { status: r.status, sid, body: parseBody(text), text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call a single MCP tool on a node. Returns a structured result — never
 * throws (network/HTTP/JSON-RPC errors are coerced into `{ ok:false, error }`).
 */
export async function callMcpTool(opts: {
  host: string;
  port: number;
  token?: string;
  name: string;
  arguments?: Record<string, any>;
  timeoutMs?: number;
}): Promise<McpCallResult> {
  const url = `http://${opts.host}:${opts.port}/mcp`;
  const timeout = opts.timeoutMs ?? 8000;
  const auth: Record<string, string> = opts.token
    ? { Authorization: `Bearer ${opts.token}` }
    : {};
  try {
    // 1) initialize
    const init = await post(
      url,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "enforcer-cockpit", version: "1.0" },
        },
      },
      auth,
      timeout,
    );
    if (init.status >= 400) {
      return { ok: false, error: `initialize HTTP ${init.status}`, raw: init.text };
    }
    const session: Record<string, string> = {
      ...auth,
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      ...(init.sid ? { "Mcp-Session-Id": init.sid } : {}),
    };

    // 2) initialized notification (best-effort; FastMCP expects it)
    try {
      await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, session, timeout);
    } catch { /* non-fatal */ }

    // 3) tools/call
    const call = await post(
      url,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: opts.name, arguments: opts.arguments || {} },
      },
      session,
      timeout,
    );

    // 4) best-effort session teardown (don't await)
    if (init.sid) {
      fetch(url, { method: "DELETE", headers: session }).catch(() => {});
    }

    if (call.status >= 400) {
      return { ok: false, error: `tools/call HTTP ${call.status}`, raw: call.text };
    }
    const msg = call.body;
    if (!msg) return { ok: false, error: "empty MCP response", raw: call.text };
    if (msg.error) {
      return { ok: false, error: msg.error.message || JSON.stringify(msg.error) };
    }
    return { ok: true, result: msg.result };
  } catch (e: any) {
    const m = e?.name === "AbortError" ? "timeout" : e?.message || String(e);
    return { ok: false, error: m };
  }
}
