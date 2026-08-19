/**
 * NodesMap — radial swarm topology for the MCP // status pane.
 *
 * Center = this cockpit's local chroot MCP (the hub). Remote nodes are
 * ringed around it, edges colored by reachability. Data-driven from the
 * real `nodes[]` + `nodeHealth` map — this is a live cockpit surface, not
 * a static diagram. Tap any node to open its detail/action sheet.
 *
 * Pure RN (absolute-positioned Views + rotated edge lines) so it adds no
 * native dependency — safe for the existing EAS build with custom Kotlin.
 */
import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Platform } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { MCPNode } from "../lib/localDb";

const C = {
  bg: "#04070a", panel: "#0a1116", panel2: "#0e1820", border: "#163041",
  green: "#00ff66", greenDim: "#0a8a3a", cyan: "#3ad7ff", red: "#ff3860",
  yellow: "#ffd400", text: "#cfeadb", textDim: "#6c8a82", mcpAccent: "#7df9ff",
};
const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

const H = 300;          // canvas height
const NODE = 60;        // node touch box size
const GRID_THRESHOLD = 8; // above this many nodes, radial → grid

function healthColor(h: string): string {
  switch (h) {
    case "running": return C.green;
    case "probing": return C.yellow;
    case "unreachable": return C.textDim;
    case "unknown": return C.textDim;
    default: return C.red;   // error / anything else
  }
}

type Props = {
  localHealth: string;          // "running" | "unreachable" | "unknown" | ...
  localEnabled: boolean;
  localLabel: string;           // e.g. bind_host or "chroot mcp"
  nodes: MCPNode[];
  nodeHealth: Record<string, string>;
  onPressLocal: () => void;
  onPressNode: (n: MCPNode) => void;
};

function Edge({ x1, y1, x2, y2, color }: { x1: number; y1: number; x2: number; y2: number; color: string }) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: midX - len / 2,
        top: midY - 1,
        width: len,
        height: 2,
        backgroundColor: color,
        opacity: 0.5,
        transform: [{ rotate: `${angle}rad` }],
      }}
    />
  );
}

function NodeDot({ color }: { color: string }) {
  return (
    <View style={styles.dotWrap}>
      <View style={[styles.dotHalo, { backgroundColor: color }]} />
      <View style={[styles.dot, { backgroundColor: color }]} />
    </View>
  );
}

export default function NodesMap({
  localHealth, localEnabled, localLabel, nodes, nodeHealth, onPressLocal, onPressNode,
}: Props) {
  const [w, setW] = useState(0);
  const cx = w / 2;
  const cy = H / 2;
  const count = nodes.length;
  const R = Math.max(70, Math.min(w, H) / 2 - NODE / 2 - 20);

  const localColor = !localEnabled ? C.textDim : healthColor(localHealth);

  // Past ~8 nodes a single radial ring overlaps/labels-collide and can't
  // fit a phone's width — switch to a compact grid so the pane never
  // mangles regardless of fleet size. Map = glance (small fleets),
  // grid = scale.
  if (count > GRID_THRESHOLD) {
    return (
      <View style={styles.gridWrap}>
        <View style={styles.gridHeader}>
          <View style={[styles.gridHubDot, { backgroundColor: localColor }]} />
          <TouchableOpacity onPress={onPressLocal} activeOpacity={0.7}>
            <Text style={styles.gridHubText}>
              local mcp hub · <Text style={{ color: C.textDim }}>{count} remote nodes</Text>
            </Text>
          </TouchableOpacity>
        </View>
        <View style={styles.grid}>
          {nodes.map((n) => {
            const h = nodeHealth[n.id] || n.last_health_status || "unknown";
            const col = !n.enabled ? C.textDim : healthColor(h);
            return (
              <TouchableOpacity
                key={n.id}
                activeOpacity={0.7}
                onPress={() => onPressNode(n)}
                style={styles.gridCell}
              >
                <View style={[styles.gridDot, { backgroundColor: col }]} />
                <MaterialCommunityIcons
                  name={n.is_primary ? "star-circle-outline" : "server-network"}
                  size={16}
                  color={col}
                />
                <Text numberOfLines={1} style={[styles.gridLabel, { color: n.enabled ? C.text : C.textDim }]}>
                  {n.name || n.host}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    );
  }

  const positioned = nodes.map((n, i) => {
    const ang = -Math.PI / 2 + i * ((2 * Math.PI) / Math.max(1, count));
    return { n, x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) };
  });

  return (
    <View style={styles.wrap} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {w > 0 && (
        <>
          {/* edges under nodes */}
          {positioned.map(({ n, x, y }) => (
            <Edge
              key={`e-${n.id}`}
              x1={cx} y1={cy} x2={x} y2={y}
              color={healthColor(nodeHealth[n.id] || n.last_health_status || "unknown")}
            />
          ))}

          {/* center = local chroot MCP hub */}
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={onPressLocal}
            style={[styles.nodeBox, { left: cx - NODE / 2, top: cy - NODE / 2 }]}
          >
            <View style={[styles.nodeIcon, { borderColor: localColor, backgroundColor: C.panel2 }]}>
              <MaterialCommunityIcons name="shield-key-outline" size={26} color={localColor} />
              <NodeDot color={localColor} />
            </View>
            <Text numberOfLines={1} style={[styles.nodeLabel, { color: C.mcpAccent, maxWidth: NODE + 40 }]}>
              local mcp
            </Text>
          </TouchableOpacity>

          {/* remote nodes */}
          {positioned.map(({ n, x, y }) => {
            const h = nodeHealth[n.id] || n.last_health_status || "unknown";
            const col = !n.enabled ? C.textDim : healthColor(h);
            const hi = n.last_health_info as any;
            const gpu = Array.isArray(hi?.capabilities) && hi.capabilities.some((c: any) => /hashcat|cuda|gpu/i.test(String(c)));
            return (
              <TouchableOpacity
                key={n.id}
                activeOpacity={0.7}
                onPress={() => onPressNode(n)}
                style={[styles.nodeBox, { left: x - NODE / 2, top: y - NODE / 2 }]}
              >
                <View style={[styles.nodeIcon, { borderColor: col, backgroundColor: C.panel }]}>
                  <MaterialCommunityIcons
                    name={n.is_primary ? "star-circle-outline" : "server-network"}
                    size={24}
                    color={col}
                  />
                  <NodeDot color={col} />
                  {gpu ? (
                    <View style={styles.gpuBadge}>
                      <MaterialCommunityIcons name="expansion-card" size={9} color="#04070a" />
                    </View>
                  ) : null}
                </View>
                <Text numberOfLines={1} style={[styles.nodeLabel, { color: n.enabled ? C.text : C.textDim, maxWidth: NODE + 44 }]}>
                  {n.name || n.host}
                </Text>
              </TouchableOpacity>
            );
          })}

          {count === 0 && (
            <Text style={styles.emptyHint}>
              no remote nodes — tap the hub to manage the local server, or add a node in{" "}
              <Text style={{ color: C.mcpAccent }}>{"// nodes"}</Text>
            </Text>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    height: H,
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
    overflow: "hidden",
    position: "relative",
  },
  nodeBox: {
    position: "absolute",
    width: NODE,
    alignItems: "center",
    justifyContent: "center",
  },
  nodeIcon: {
    width: NODE,
    height: NODE,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  gpuBadge: {
    position: "absolute",
    bottom: -4,
    left: -4,
    width: 14,
    height: 14,
    borderRadius: 3,
    backgroundColor: C.yellow,
    alignItems: "center",
    justifyContent: "center",
  },
  dotWrap: {
    position: "absolute",
    top: -4,
    right: -4,
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  dotHalo: { position: "absolute", width: 14, height: 14, borderRadius: 7, opacity: 0.3 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  nodeLabel: {
    fontFamily: MONO,
    fontSize: 10,
    marginTop: 3,
    textAlign: "center",
  },
  emptyHint: {
    position: "absolute",
    bottom: 12,
    left: 14,
    right: 14,
    fontFamily: MONO,
    fontSize: 10,
    color: C.textDim,
    textAlign: "center",
    lineHeight: 15,
  },
  // ── grid fallback (>8 nodes) ──
  gridWrap: {
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
    padding: 10,
  },
  gridHeader: { flexDirection: "row", alignItems: "center", marginBottom: 10 },
  gridHubDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  gridHubText: { fontFamily: MONO, fontSize: 12, color: C.mcpAccent },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  gridCell: {
    flexBasis: "31%",
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 4,
    backgroundColor: C.panel2,
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  gridDot: { width: 8, height: 8, borderRadius: 4 },
  gridLabel: { fontFamily: MONO, fontSize: 10, flexShrink: 1 },
});
