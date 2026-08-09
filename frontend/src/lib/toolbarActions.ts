/**
 * toolbarActions — executes a floating-toolbar slot.
 *
 * Every slot resolves to one of: an MCP tool call on a chosen node, a built-in
 * app action (snapshot / restore / revive), or a route navigation. Returns a
 * uniform {ok, detail} so the toolbar can drive its LED feedback.
 */
import { router } from "expo-router";
import { nodesLocal, settingsLocal } from "./localDb";
import { callMcpTool } from "./mcpClient";
import { reviveNode } from "./nodeProvision";
import {
  loadUpstashUrl, loadUpstashToken, pushRoster, fetchRoster, fetchCurrentBearer,
  type RosterEntry,
} from "./tokenStash";
import { execReal } from "./rootShell";
import type { ToolbarSlot } from "./toolbarStore";

export type ActionResult = { ok: boolean; detail: string };

// Chroot-wrapped exec (for revive), mirroring the rest of the app.
async function execChroot(inner: string) {
  const s = await settingsLocal.get();
  const chrootPath = (s.chroot_path || "").trim();
  const escaped = inner.replace(/'/g, "'\\''");
  const cmd = chrootPath ? `${chrootPath} bash -c '${escaped}'` : inner;
  const r = await execReal(cmd);
  return { output: r.output, exit_code: r.exit_code };
}

export async function executeSlot(slot: ToolbarSlot): Promise<ActionResult> {
  try {
    switch (slot.kind) {
      case "navigate": {
        if (!slot.route) return { ok: false, detail: "no route set" };
        router.push(slot.route as any);
        return { ok: true, detail: `→ ${slot.route}` };
      }
      case "mcp_tool": {
        if (!slot.nodeId) return { ok: false, detail: "no node assigned" };
        if (!slot.tool) return { ok: false, detail: "no tool assigned" };
        const node = await nodesLocal.get(slot.nodeId);
        if (!node) return { ok: false, detail: "node not found" };
        const res = await callMcpTool({
          host: node.host, port: node.port, token: node.bearer_token,
          name: slot.tool, arguments: slot.args || {}, timeoutMs: 30000,
        });
        return { ok: res.ok, detail: res.ok ? `${slot.tool} ok` : (res.error || "tool failed") };
      }
      case "app":
        return runAppAction(slot);
      default:
        return { ok: false, detail: "unknown action" };
    }
  } catch (e: any) {
    return { ok: false, detail: e?.message || String(e) };
  }
}

async function runAppAction(slot: ToolbarSlot): Promise<ActionResult> {
  const [url, tok] = await Promise.all([loadUpstashUrl(), loadUpstashToken()]);

  switch (slot.appAction) {
    case "snapshot": {
      if (!url || !tok) return { ok: false, detail: "cloud sync not configured" };
      const rows = await nodesLocal.list();
      const roster: RosterEntry[] = rows.map((n) => ({
        name: n.name, host: n.host, port: n.port,
        transport: n.transport, is_primary: n.is_primary,
        tags: n.tags, description: n.description,
      }));
      if (roster.length === 0) return { ok: false, detail: "local roster empty — nothing to snapshot" };
      await pushRoster(url, tok, roster);
      return { ok: true, detail: `snapshot pushed (${roster.length})` };
    }
    case "restore": {
      if (!url || !tok) return { ok: false, detail: "cloud sync not configured" };
      const [roster, rec] = await Promise.all([fetchRoster(url, tok), fetchCurrentBearer(url, tok)]);
      if (roster.length === 0) return { ok: false, detail: "cloud roster empty" };
      let added = 0;
      for (const r of roster) {
        try {
          await nodesLocal.upsert({
            name: r.name, host: r.host, port: r.port,
            bearer_token: rec?.token || "",
            transport: r.transport || "http_sse", enabled: true,
            is_primary: !!r.is_primary, tags: r.tags || [],
            description: r.description || "restored via toolbar",
          } as any);
          added++;
        } catch { /* skip */ }
      }
      return { ok: added > 0, detail: `restored ${added} node(s)` };
    }
    case "revive": {
      if (!slot.nodeId) return { ok: false, detail: "no node assigned to revive" };
      const node = await nodesLocal.get(slot.nodeId);
      if (!node) return { ok: false, detail: "node not found" };
      const r = await reviveNode(node.host, execChroot, node.ssh_port ?? 22, node.ssh_user || "root");
      return { ok: r.ok, detail: r.detail };
    }
    default:
      return { ok: false, detail: "unknown app action" };
  }
}
