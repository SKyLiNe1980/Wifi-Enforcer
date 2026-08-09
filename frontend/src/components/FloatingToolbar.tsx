/**
 * FloatingToolbar — global, draggable SDR-style command bar.
 *
 * Collapsed = a 56px bubble that snaps to a screen edge. Tap → expands into a
 * rugged gunmetal bar of tactical buttons; each fires a toolbar action with
 * LED feedback. A CONFIG gear opens the slot editor. Drag anywhere; position
 * persists. Left/right 60px bays are reserved for the Phase-2 knurled dials.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, Dimensions, Platform, ToastAndroid } from "react-native";
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming, runOnJS,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import {
  loadToolbarConfig, saveToolbarPosition, subscribeToolbar,
  type ToolbarConfig, type ToolbarSlot,
} from "../lib/toolbarStore";
import { executeSlot } from "../lib/toolbarActions";
import ToolbarConfigModal from "./ToolbarConfigModal";

const C = {
  surface: "#04070a", panel: "#0a1116", border: "#163041",
  green: "#00ff66", amber: "#ffd400", cyan: "#3ad7ff", red: "#ff3860",
  accent: "#7df9ff", dim: "#6c8a82", text: "#cfeadb",
};
const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });
const BUBBLE = 56;
const BAR_H = 90;
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

type Fb = "idle" | "firing" | "ok" | "err";

function tap(style: Haptics.ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle.Rigid) {
  Haptics.impactAsync(style).catch(() => {});
}

export default function FloatingToolbar() {
  const insets = useSafeAreaInsets();
  const [cfg, setCfg] = useState<ToolbarConfig | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [fb, setFb] = useState<Record<string, Fb>>({});

  const barW = SCREEN_W - 24;
  const dockedX = useRef(SCREEN_W - BUBBLE - 12);
  // Remembers where the collapsed bubble was, so collapsing restores it
  // instead of leaving the widget stuck at the docked-bar position.
  const bubblePos = useRef({ x: SCREEN_W - BUBBLE - 12, y: 0 });

  const tx = useSharedValue(SCREEN_W - BUBBLE - 12);
  const ty = useSharedValue(0);
  const w = useSharedValue(BUBBLE);
  const h = useSharedValue(BUBBLE);
  const r = useSharedValue(BUBBLE / 2);
  const start = useSharedValue({ x: 0, y: 0 });
  const expSV = useSharedValue(0);

  // Load persisted config + position.
  useEffect(() => {
    let alive = true;
    loadToolbarConfig().then((c) => {
      if (!alive) return;
      setCfg(c);
      const defY = Dimensions.get("window").height * 0.55;
      const x = c.x >= 0 ? c.x : SCREEN_W - BUBBLE - 12;
      const y = c.y >= 0 ? c.y : defY;
      dockedX.current = x;
      tx.value = x;
      ty.value = y;
      bubblePos.current = { x, y };
    });
    const unsub = subscribeToolbar((c) => alive && setCfg(c));
    return () => { alive = false; unsub(); };
  }, [tx, ty]);

  const persist = useCallback((x: number, y: number) => {
    saveToolbarPosition(x, y, !expanded).catch(() => {});
  }, [expanded]);

  const applyExpanded = useCallback((next: boolean) => {
    setExpanded(next);
    expSV.value = next ? 1 : 0;
    if (next) {
      tap();
      // Remember bubble spot, then dock the bar to a fully on-screen slot near
      // the bottom so it can never fall half off the edge.
      bubblePos.current = { x: dockedX.current, y: ty.value };
      const dockY = Math.max(insets.top + 8, SCREEN_H - BAR_H - insets.bottom - 16);
      w.value = withTiming(barW, { duration: 220 });
      h.value = withTiming(BAR_H, { duration: 220 });
      r.value = withTiming(6, { duration: 220 });
      tx.value = withSpring(12, { damping: 18, stiffness: 180 });
      ty.value = withSpring(dockY, { damping: 18, stiffness: 180 });
    } else {
      w.value = withTiming(BUBBLE, { duration: 200 });
      h.value = withTiming(BUBBLE, { duration: 200 });
      r.value = withTiming(BUBBLE / 2, { duration: 200 });
      tx.value = withSpring(bubblePos.current.x, { damping: 18, stiffness: 180 });
      ty.value = withSpring(bubblePos.current.y, { damping: 18, stiffness: 180 });
    }
  }, [barW, expSV, h, r, tx, ty, w, insets.top, insets.bottom]);

  const snapEdge = useCallback((endX: number) => {
    const goRight = endX + BUBBLE / 2 > SCREEN_W / 2;
    const target = goRight ? SCREEN_W - BUBBLE - 12 : 12 + insets.left;
    dockedX.current = target;
    tx.value = withSpring(target, { damping: 18, stiffness: 180 });
    persist(target, ty.value);
  }, [insets.left, persist, tx, ty]);

  const pan = Gesture.Pan()
    .enabled(!expanded)
    .minDistance(10)
    .onStart(() => { start.value = { x: tx.value, y: ty.value }; })
    .onUpdate((e) => {
      tx.value = start.value.x + e.translationX;
      ty.value = start.value.y + e.translationY;
    })
    .onEnd(() => {
      // clamp vertically within safe area. NOTE: use the captured SCREEN_H
      // primitive here — `Dimensions.get()` is NOT worklet-safe and calling
      // it on the UI thread throws "undefined is not a function", which was
      // force-closing the app on every drag-release.
      const maxY = SCREEN_H - h.value - insets.bottom - 8;
      const minY = insets.top + 8;
      if (ty.value < minY) ty.value = withSpring(minY);
      if (ty.value > maxY) ty.value = withSpring(maxY);
      if (expSV.value === 0) {
        runOnJS(snapEdge)(tx.value);
      } else {
        runOnJS(persist)(tx.value, ty.value);
      }
    });

  const containerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }],
    width: w.value,
    height: h.value,
    borderRadius: r.value,
  }));

  const fire = useCallback(async (slot: ToolbarSlot) => {
    tap();
    setFb((p) => ({ ...p, [slot.id]: "firing" }));
    const res = await executeSlot(slot);
    setFb((p) => ({ ...p, [slot.id]: res.ok ? "ok" : "err" }));
    if (Platform.OS === "android") {
      ToastAndroid.show(res.detail || (res.ok ? "ok" : "failed"), ToastAndroid.SHORT);
    }
    if (!res.ok) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    setTimeout(() => setFb((p) => ({ ...p, [slot.id]: "idle" })), 1300);
  }, []);

  if (!cfg || !cfg.enabled || cfg.systemOverlay) return null;

  const ledColor = (slot: ToolbarSlot): string => {
    const st = fb[slot.id] || "idle";
    if (st === "firing") return C.amber;
    if (st === "ok") return C.green;
    if (st === "err") return C.red;
    return slot.led || C.border;
  };

  return (
    <>
      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.container, containerStyle]} pointerEvents="box-none">
          {!expanded ? (
            // ── Collapsed bubble ──
            <Pressable style={styles.bubble} onPress={() => applyExpanded(true)}>
              <LinearGradient colors={["#1c2833", "#0e1820", "#060a0f"]} style={styles.bubbleGrad}>
                <MaterialCommunityIcons name="radar" size={26} color={C.green} />
              </LinearGradient>
            </Pressable>
          ) : (
            // ── Expanded bar ──
            <LinearGradient colors={["#1c2833", "#0e1820", "#060a0f"]} style={styles.bar}>
              {/* corner hex screws */}
              {[["tl", 4, 4], ["tr", undefined, 4], ["bl", 4, undefined], ["br", undefined, undefined]].map((c, i) => (
                <View key={i} style={[styles.screw,
                  { top: c[1] as number, left: c[0] === "tl" || c[0] === "bl" ? 4 : undefined,
                    right: c[0] === "tr" || c[0] === "br" ? 4 : undefined,
                    bottom: c[0] === "bl" || c[0] === "br" ? 4 : undefined }]} />
              ))}

              {/* MODE / SCAN / EXEC pills (visual; wired in Phase 2) */}
              <View style={styles.pills}>
                {["MODE", "SCAN", "EXEC"].map((p, i) => (
                  <View key={p} style={[styles.pill, i === 1 && styles.pillActive]}>
                    <Text style={[styles.pillTxt, i === 1 && styles.pillTxtActive]}>{p}</Text>
                  </View>
                ))}
              </View>

              <View style={styles.barRow}>
                {/* left bay — Phase 2 TX PWR dial */}
                <View style={styles.bay}>
                  <MaterialCommunityIcons name="knob" size={22} color={C.border} />
                  <Text style={styles.bayLbl}>TX</Text>
                </View>

                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.cells}
                >
                  {cfg.slots.map((slot) => (
                    <Pressable key={slot.id} style={styles.cell}
                      onPress={() => fire(slot)}
                      onLongPress={() => { tap(Haptics.ImpactFeedbackStyle.Medium); setConfigOpen(true); }}
                    >
                      <MaterialCommunityIcons name={slot.icon as any} size={22} color={C.text} />
                      <Text style={styles.cellLbl} numberOfLines={1}>{slot.label}</Text>
                      <View style={[styles.led, {
                        backgroundColor: ledColor(slot),
                        shadowColor: ledColor(slot),
                        shadowOpacity: (fb[slot.id] && fb[slot.id] !== "idle") ? 0.9 : 0,
                        shadowRadius: 6, elevation: (fb[slot.id] && fb[slot.id] !== "idle") ? 6 : 0,
                      }]} />
                    </Pressable>
                  ))}
                  {/* config gear cell */}
                  <Pressable style={styles.cell} onPress={() => { tap(); setConfigOpen(true); }}>
                    <MaterialCommunityIcons name="cog" size={22} color={C.accent} />
                    <Text style={[styles.cellLbl, { color: C.accent }]}>CONFIG</Text>
                    <View style={[styles.led, { backgroundColor: C.border }]} />
                  </Pressable>
                </ScrollView>

                {/* right bay — Phase 2 CH dial + collapse */}
                <View style={styles.bay}>
                  <Pressable onPress={() => applyExpanded(false)} hitSlop={8} style={styles.collapseBtn}>
                    <MaterialCommunityIcons name="chevron-down" size={22} color={C.green} />
                  </Pressable>
                  <Text style={styles.bayLbl}>CH</Text>
                </View>
              </View>
            </LinearGradient>
          )}
        </Animated.View>
      </GestureDetector>

      <ToolbarConfigModal
        visible={configOpen}
        config={cfg}
        onClose={() => setConfigOpen(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute", top: 0, left: 0, zIndex: 9999,
    // bevel edges
    borderWidth: 1.5, borderTopColor: "#2b4052", borderBottomColor: "#000000",
    borderLeftColor: "#163041", borderRightColor: "#163041",
    overflow: "hidden",
  },
  bubble: { flex: 1 },
  bubbleGrad: { flex: 1, alignItems: "center", justifyContent: "center" },
  bar: { flex: 1, paddingHorizontal: 6, paddingTop: 10, paddingBottom: 6 },
  screw: { position: "absolute", width: 5, height: 5, borderRadius: 3, backgroundColor: "#04070a", borderWidth: 0.5, borderColor: "#2b4052" },
  pills: { position: "absolute", top: -1, alignSelf: "center", flexDirection: "row", zIndex: 2 },
  pill: { paddingHorizontal: 8, paddingVertical: 1, marginHorizontal: 2, borderRadius: 999, backgroundColor: "#0a1116", borderWidth: 1, borderColor: "#163041" },
  pillActive: { backgroundColor: "#163041", borderColor: "#ffd400" },
  pillTxt: { color: "#6c8a82", fontFamily: MONO, fontSize: 8, fontWeight: "700", letterSpacing: 1 },
  pillTxtActive: { color: "#ffd400" },
  barRow: { flex: 1, flexDirection: "row", alignItems: "center" },
  bay: { width: 44, alignItems: "center", justifyContent: "center" },
  bayLbl: { color: "#6c8a82", fontFamily: MONO, fontSize: 8, marginTop: 2, letterSpacing: 1 },
  collapseBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: 6, borderWidth: 1, borderColor: "#163041", backgroundColor: "#0a1116" },
  cells: { alignItems: "center", paddingHorizontal: 2 },
  cell: {
    width: 58, height: 58, marginHorizontal: 3, borderRadius: 6, backgroundColor: "#0a1116",
    borderWidth: 1, borderColor: "#163041", alignItems: "center", justifyContent: "center",
  },
  cellLbl: { color: "#6c8a82", fontFamily: MONO, fontSize: 9, marginTop: 3, letterSpacing: 0.5 },
  led: { height: 4, width: "60%", borderRadius: 2, marginTop: 4, backgroundColor: "#163041" },
});
