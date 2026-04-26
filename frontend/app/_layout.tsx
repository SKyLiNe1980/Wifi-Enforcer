import React from "react";
import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform } from "react-native";

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

type EBState = { err: Error | null; info: string | null };

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, EBState> {
  state: EBState = { err: null, info: null };

  static getDerivedStateFromError(err: Error) {
    return { err, info: null };
  }

  componentDidCatch(err: Error, info: any) {
    this.setState({ err, info: info?.componentStack || null });
  }

  reset = () => this.setState({ err: null, info: null });

  render() {
    if (this.state.err) {
      return (
        <View style={s.wrap}>
          <Text style={s.title}>// runtime panic</Text>
          <Text style={s.msg}>{String(this.state.err?.message || this.state.err)}</Text>
          <ScrollView style={s.stackBox}>
            <Text style={s.stack}>{(this.state.err?.stack || "") + "\n" + (this.state.info || "")}</Text>
          </ScrollView>
          <TouchableOpacity onPress={this.reset} style={s.btn} testID="error-reset">
            <Text style={s.btnText}>RESTART</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#04070a" } }} />
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: "#04070a", padding: 20, paddingTop: 60 },
  title: { color: "#ff3860", fontFamily: MONO, fontSize: 16, fontWeight: "700", marginBottom: 12 },
  msg: { color: "#ffd400", fontFamily: MONO, fontSize: 13, marginBottom: 14 },
  stackBox: { flex: 1, backgroundColor: "#0a1116", borderColor: "#163041", borderWidth: 1, borderRadius: 4, padding: 10 },
  stack: { color: "#cfeadb", fontFamily: MONO, fontSize: 10 },
  btn: { backgroundColor: "#00ff66", padding: 12, borderRadius: 4, marginTop: 14, alignItems: "center" },
  btnText: { color: "#04070a", fontFamily: MONO, fontSize: 13, fontWeight: "800", letterSpacing: 2 },
});
