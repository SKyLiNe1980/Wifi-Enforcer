import { NativeModules, Platform } from "react-native";

/**
 * Thin wrapper that uses the native RootShell module (real `su -c` execution)
 * when present in the build, and gracefully falls back to the mocked HTTP
 * backend in Expo Go / web preview.
 *
 * To enable REAL mode you must run a custom build:
 *   npx expo prebuild --platform android
 *   eas build -p android --profile preview
 * Then sideload the APK on a rooted device & grant root in Magisk.
 */

type RNModule = {
  isRoot(): Promise<boolean>;
  exec(cmd: string): Promise<{
    command: string; stdout: string; stderr: string;
    exit_code: number; duration_ms: number;
  }>;
  execBatch(cmds: string[]): Promise<{
    logs: { command: string; stdout: string; stderr: string; exit_code: number }[];
    duration_ms: number;
  }>;
};

export const RootShell: RNModule | null =
  Platform.OS === "android" ? (NativeModules as any).RootShell || null : null;

export const HAS_NATIVE_ROOT = !!RootShell;

export async function checkRoot(): Promise<boolean> {
  if (!RootShell) return false;
  try { return await RootShell.isRoot(); } catch { return false; }
}

export async function execReal(cmd: string) {
  if (!RootShell) throw new Error("native root module not available");
  const r = await RootShell.exec(cmd);
  return {
    command: r.command,
    output: r.stdout || r.stderr || "",
    exit_code: r.exit_code,
    duration_ms: r.duration_ms,
    mocked: false,
  };
}
