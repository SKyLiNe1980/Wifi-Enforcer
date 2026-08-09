/* eslint-disable react/jsx-no-comment-textnodes */
/**
 * ToolbarConfigModal — the "Config Bottom Sheet" slot editor for the
 * global floating command toolbar.
 *
 * Rugged SDR/military-radio aesthetic (see /app/design_guidelines.json):
 * opaque gunmetal panel, monospace engraved labels, LED colour swatches.
 * Lets the operator toggle the whole toolbar on/off and add / edit /
 * reorder / delete tactical button slots. Persists via toolbarStore.
 */
import React, { useEffect, useState, useCallback } from "react";
import {
  Modal, View, Text, StyleSheet, ScrollView, Pressable, TextInput,
  Platform, Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import {
  saveToolbarConfig, LED_COLORS,
  type ToolbarConfig, type ToolbarSlot, type SlotKind, type AppAction,
} from "../lib/toolbarStore";
import { nodesLocal } from "../lib/localDb";

const C = {
  surface: "#04070a", panel: "#0a1116", panel2: "#0e1820", border: "#163041",
  green: "#00ff66", amber: "#ffd400", cyan: "#3ad7ff", red: "#ff3860",
  accent: "#7df9ff", dim: "#6c8a82", text: "#cfeadb",
};
const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

const LED_SWATCHES = [
  { hex: LED_COLORS.green, name: "grn" },
  { hex: LED_COLORS.amber, name: "amb" },
  { hex: LED_COLORS.cyan, name: "cyn" },
  { hex: LED_COLORS.red, name: "red" },
];

const KINDS: { key: SlotKind; label: string }[] = [
  { key: "mcp_tool", label: "MCP" },
  { key: "app", label: "APP" },
  { key: "navigate", label: "NAV" },
];

const APP_ACTIONS: AppAction[] = ["snapshot", "restore", "revive"];

type NodeLite = { id: string; name: string; host: string };

function tap() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid).catch(() => {});
}

function uid() {
  return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** args <-> "key=value" newline text */
function argsToText(args?: Record<string, string>): string {
  if (!args) return "";
  return Object.entries(args).map(([k, v]) => `${k}=${v}`).join("\n");
}
function textToArgs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  text.split("\n").forEach((line) => {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  return out;
}

export default function ToolbarConfigModal({
  visible, config, onClose,
}: {
  visible: boolean;
  config: ToolbarConfig | null;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<ToolbarConfig | null>(null);
  const [nodes, setNodes] = useState<NodeLite[]>([]);
  const [saving, setSaving] = useState(false);

  // Snapshot config into a local editable draft whenever the sheet opens.
  useEffect(() => {
    if (visible && config) {
      setDraft(JSON.parse(JSON.stringify(config)));
      nodesLocal.list()
        .then((rows) => setNodes(rows.map((n) => ({ id: n.id, name: n.name, host: n.host }))))
        .catch(() => setNodes([]));
    }
  }, [visible, config]);

  const patchSlot = useCallback((id: string, patch: Partial<ToolbarSlot>) => {
    setDraft((d) => d && ({ ...d, slots: d.slots.map((s) => s.id === id ? { ...s, ...patch } : s) }));
  }, []);

  const addSlot = useCallback(() => {
    tap();
    setDraft((d) => d && ({
      ...d,
      slots: [...d.slots, {
        id: uid(), label: "NEW", icon: "flash", led: LED_COLORS.green, kind: "app", appAction: "snapshot",
      }],
    }));
  }, []);

  const removeSlot = useCallback((id: string) => {
    tap();
    setDraft((d) => d && ({ ...d, slots: d.slots.filter((s) => s.id !== id) }));
  }, []);

  const move = useCallback((id: string, dir: -1 | 1) => {
    tap();
    setDraft((d) => {
      if (!d) return d;
      const idx = d.slots.findIndex((s) => s.id === id);
      const to = idx + dir;
      if (idx < 0 || to < 0 || to >= d.slots.length) return d;
      const slots = [...d.slots];
      [slots[idx], slots[to]] = [slots[to], slots[idx]];
      return { ...d, slots };
    });
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await saveToolbarConfig(draft);
      tap();
      onClose();
    } catch (e: any) {
      Alert.alert("Save failed", e?.message || "unknown error");
    } finally {
      setSaving(false);
    }
  }, [draft, onClose]);

  if (!draft) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTap} onPress={onClose} />
        <LinearGradient
          colors={["#1c2833", "#0e1820", "#060a0f"]}
          style={[styles.sheet, { paddingBottom: insets.bottom + 12, maxHeight: "88%" }]}
        >
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.title}>// COMMAND TOOLBAR</Text>
            <Pressable onPress={onClose} hitSlop={10} testID="toolbar-config-close">
              <MaterialCommunityIcons name="close" size={20} color={C.dim} />
            </Pressable>
          </View>

          {/* master enable toggle */}
          <Pressable
            testID="toolbar-enabled-toggle"
            style={styles.enableRow}
            onPress={() => { tap(); setDraft((d) => d && ({ ...d, enabled: !d.enabled })); }}
          >
            <MaterialCommunityIcons
              name={draft.enabled ? "toggle-switch" : "toggle-switch-off-outline"}
              size={30}
              color={draft.enabled ? C.green : C.dim}
            />
            <Text style={[styles.enableTxt, { color: draft.enabled ? C.green : C.dim }]}>
              OVERLAY {draft.enabled ? "ARMED" : "OFF"}
            </Text>
          </Pressable>

          <ScrollView style={{ marginTop: 8 }} contentContainerStyle={{ paddingBottom: 8 }}>
            {draft.slots.length === 0 && (
              <Text style={styles.empty}>// NO ACTIONS ASSIGNED</Text>
            )}

            {draft.slots.map((slot, i) => (
              <View key={slot.id} style={styles.slot} testID={`slot-${i}`}>
                {/* row 1: label + icon + reorder/delete */}
                <View style={styles.slotHead}>
                  <View style={styles.field}>
                    <Text style={styles.lbl}>LABEL</Text>
                    <TextInput
                      value={slot.label}
                      onChangeText={(t) => patchSlot(slot.id, { label: t.slice(0, 8) })}
                      style={styles.input}
                      autoCapitalize="characters"
                      placeholder="TAG" placeholderTextColor={C.dim}
                    />
                  </View>
                  <View style={[styles.field, { marginLeft: 8 }]}>
                    <Text style={styles.lbl}>ICON</Text>
                    <View style={styles.iconPreviewRow}>
                      <MaterialCommunityIcons name={slot.icon as any} size={18} color={C.text} />
                      <TextInput
                        value={slot.icon}
                        onChangeText={(t) => patchSlot(slot.id, { icon: t })}
                        style={[styles.input, { flex: 1, marginLeft: 6 }]}
                        autoCapitalize="none" autoCorrect={false}
                        placeholder="wifi" placeholderTextColor={C.dim}
                      />
                    </View>
                  </View>
                  <View style={styles.slotBtns}>
                    <Pressable onPress={() => move(slot.id, -1)} hitSlop={6} style={styles.miniBtn} testID={`slot-up-${i}`}>
                      <MaterialCommunityIcons name="chevron-up" size={16} color={C.cyan} />
                    </Pressable>
                    <Pressable onPress={() => move(slot.id, 1)} hitSlop={6} style={styles.miniBtn} testID={`slot-down-${i}`}>
                      <MaterialCommunityIcons name="chevron-down" size={16} color={C.cyan} />
                    </Pressable>
                    <Pressable onPress={() => removeSlot(slot.id)} hitSlop={6} style={[styles.miniBtn, { borderColor: C.red }]} testID={`slot-del-${i}`}>
                      <MaterialCommunityIcons name="trash-can-outline" size={16} color={C.red} />
                    </Pressable>
                  </View>
                </View>

                {/* row 2: LED swatches */}
                <Text style={[styles.lbl, { marginTop: 8 }]}>LED</Text>
                <View style={styles.swatchRow}>
                  {LED_SWATCHES.map((sw) => (
                    <Pressable
                      key={sw.hex}
                      onPress={() => { tap(); patchSlot(slot.id, { led: sw.hex }); }}
                      style={[styles.swatch, { backgroundColor: sw.hex, opacity: slot.led === sw.hex ? 1 : 0.35, borderColor: slot.led === sw.hex ? C.text : "transparent" }]}
                    />
                  ))}
                </View>

                {/* row 3: action type */}
                <Text style={[styles.lbl, { marginTop: 8 }]}>ACTION</Text>
                <View style={styles.segRow}>
                  {KINDS.map((k) => {
                    const active = slot.kind === k.key;
                    return (
                      <Pressable
                        key={k.key}
                        onPress={() => { tap(); patchSlot(slot.id, { kind: k.key }); }}
                        style={[styles.seg, active && styles.segActive]}
                      >
                        <Text style={[styles.segTxt, active && styles.segTxtActive]}>{k.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>

                {/* kind-specific fields */}
                {slot.kind === "mcp_tool" && (
                  <View style={{ marginTop: 8 }}>
                    <NodePicker nodes={nodes} value={slot.nodeId} onPick={(id) => patchSlot(slot.id, { nodeId: id })} />
                    <Text style={[styles.lbl, { marginTop: 8 }]}>TOOL</Text>
                    <TextInput
                      value={slot.tool || ""}
                      onChangeText={(t) => patchSlot(slot.id, { tool: t })}
                      style={styles.input}
                      autoCapitalize="none" autoCorrect={false}
                      placeholder="exec_command" placeholderTextColor={C.dim}
                    />
                    <Text style={[styles.lbl, { marginTop: 8 }]}>ARGS (key=value / line)</Text>
                    <TextInput
                      value={argsToText(slot.args)}
                      onChangeText={(t) => patchSlot(slot.id, { args: textToArgs(t) })}
                      style={[styles.input, styles.multiline]}
                      multiline
                      autoCapitalize="none" autoCorrect={false}
                      placeholder={"cmd=wifite --pmkid --kill"} placeholderTextColor={C.dim}
                    />
                  </View>
                )}

                {slot.kind === "app" && (
                  <View style={{ marginTop: 8 }}>
                    <Text style={styles.lbl}>APP ACTION</Text>
                    <View style={styles.segRow}>
                      {APP_ACTIONS.map((a) => {
                        const active = slot.appAction === a;
                        return (
                          <Pressable
                            key={a}
                            onPress={() => { tap(); patchSlot(slot.id, { appAction: a }); }}
                            style={[styles.seg, active && styles.segActive]}
                          >
                            <Text style={[styles.segTxt, active && styles.segTxtActive]}>{a.toUpperCase()}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                    {slot.appAction === "revive" && (
                      <View style={{ marginTop: 8 }}>
                        <NodePicker nodes={nodes} value={slot.nodeId} onPick={(id) => patchSlot(slot.id, { nodeId: id })} />
                      </View>
                    )}
                  </View>
                )}

                {slot.kind === "navigate" && (
                  <View style={{ marginTop: 8 }}>
                    <Text style={styles.lbl}>ROUTE</Text>
                    <TextInput
                      value={slot.route || ""}
                      onChangeText={(t) => patchSlot(slot.id, { route: t })}
                      style={styles.input}
                      autoCapitalize="none" autoCorrect={false}
                      placeholder="/" placeholderTextColor={C.dim}
                    />
                  </View>
                )}
              </View>
            ))}

            <Pressable onPress={addSlot} style={styles.addBtn} testID="toolbar-add-slot">
              <MaterialCommunityIcons name="plus" size={18} color={C.green} />
              <Text style={styles.addTxt}>ADD SLOT</Text>
            </Pressable>
          </ScrollView>

          <Pressable onPress={save} disabled={saving} style={[styles.saveBtn, saving && { opacity: 0.5 }]} testID="toolbar-save">
            <MaterialCommunityIcons name="content-save" size={16} color={C.surface} />
            <Text style={styles.saveTxt}>{saving ? "SAVING…" : "COMMIT CONFIG"}</Text>
          </Pressable>
        </LinearGradient>
      </View>
    </Modal>
  );
}

function NodePicker({
  nodes, value, onPick,
}: {
  nodes: NodeLite[]; value?: string; onPick: (id: string) => void;
}) {
  return (
    <View>
      <Text style={styles.lbl}>TARGET NODE</Text>
      {nodes.length === 0 ? (
        <Text style={styles.hint}>// no nodes registered</Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 4 }}>
          {nodes.map((n) => {
            const active = value === n.id;
            return (
              <Pressable
                key={n.id}
                onPress={() => { tap(); onPick(n.id); }}
                style={[styles.nodeChip, active && styles.nodeChipActive]}
              >
                <MaterialCommunityIcons name="server" size={12} color={active ? C.amber : C.dim} />
                <Text style={[styles.nodeChipTxt, active && { color: C.amber }]} numberOfLines={1}>{n.name}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.85)", justifyContent: "flex-end" },
  backdropTap: { flex: 1 },
  sheet: {
    borderTopLeftRadius: 12, borderTopRightRadius: 12, paddingHorizontal: 14, paddingTop: 8,
    borderWidth: 1.5, borderTopColor: "#2b4052", borderLeftColor: C.border, borderRightColor: C.border, borderBottomColor: "transparent",
  },
  handle: { alignSelf: "center", width: 44, height: 4, borderRadius: 2, backgroundColor: C.border, marginBottom: 10 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  title: { color: C.green, fontFamily: MONO, fontSize: 14, fontWeight: "700", letterSpacing: 1 },
  enableRow: {
    flexDirection: "row", alignItems: "center", backgroundColor: C.panel,
    borderWidth: 1, borderColor: C.border, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 12,
  },
  enableTxt: { fontFamily: MONO, fontSize: 12, fontWeight: "800", letterSpacing: 1, marginLeft: 10 },
  empty: { color: C.dim, fontFamily: MONO, fontSize: 12, textAlign: "center", paddingVertical: 20, letterSpacing: 1 },
  slot: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.border, borderRadius: 6, padding: 10, marginBottom: 10 },
  slotHead: { flexDirection: "row", alignItems: "flex-end" },
  field: { flex: 1 },
  lbl: { color: C.dim, fontFamily: MONO, fontSize: 9, letterSpacing: 1, marginBottom: 3 },
  input: {
    backgroundColor: "#02050a", borderWidth: 1, borderColor: C.border, borderRadius: 4,
    color: C.text, fontFamily: MONO, fontSize: 12, paddingHorizontal: 8, paddingVertical: 6,
  },
  multiline: { minHeight: 54, textAlignVertical: "top" },
  iconPreviewRow: { flexDirection: "row", alignItems: "center" },
  slotBtns: { flexDirection: "row", marginLeft: 8, alignItems: "center" },
  miniBtn: {
    width: 28, height: 28, borderRadius: 4, borderWidth: 1, borderColor: C.border,
    backgroundColor: C.panel2, alignItems: "center", justifyContent: "center", marginLeft: 4,
  },
  swatchRow: { flexDirection: "row", marginTop: 4 },
  swatch: { width: 34, height: 16, borderRadius: 3, marginRight: 8, borderWidth: 1.5 },
  segRow: { flexDirection: "row", marginTop: 4 },
  seg: {
    flex: 1, alignItems: "center", paddingVertical: 7, marginRight: 6, borderRadius: 4,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.panel2,
  },
  segActive: { borderColor: C.amber, backgroundColor: "#1a2530" },
  segTxt: { color: C.dim, fontFamily: MONO, fontSize: 10, fontWeight: "700", letterSpacing: 1 },
  segTxtActive: { color: C.amber },
  nodeChip: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 4, borderWidth: 1, borderColor: C.border, backgroundColor: C.panel2, marginRight: 6, maxWidth: 140,
  },
  nodeChipActive: { borderColor: C.amber, backgroundColor: "#1a2530" },
  nodeChipTxt: { color: C.dim, fontFamily: MONO, fontSize: 11, marginLeft: 5 },
  hint: { color: C.dim, fontFamily: MONO, fontSize: 11, marginTop: 4 },
  addBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", paddingVertical: 12,
    borderRadius: 6, borderWidth: 1, borderColor: C.green, borderStyle: "dashed", marginTop: 4,
  },
  addTxt: { color: C.green, fontFamily: MONO, fontSize: 12, fontWeight: "800", letterSpacing: 1, marginLeft: 6 },
  saveBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    backgroundColor: C.green, paddingVertical: 13, borderRadius: 6, marginTop: 10,
  },
  saveTxt: { color: C.surface, fontFamily: MONO, fontSize: 13, fontWeight: "800", letterSpacing: 2, marginLeft: 8 },
});
