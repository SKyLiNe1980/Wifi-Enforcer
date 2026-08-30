import * as SecureStore from "expo-secure-store";
import { kvGet, kvSet } from "./localDb";

/**
 * sshConfig — persistence for SSH backend mode. Non-secret config lives in the
 * kv store; the password and private key live ONLY in expo-secure-store
 * (AndroidKeyStore-backed).
 */

export type SshBackendConfig = {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  authMode: "password" | "key";
  fingerprint: string; // TOFU: stored on first connect, compared thereafter
};

const KEY = "ssh_backend";
const PW_KEY = "ssh_backend_password";
const KEYPEM_KEY = "ssh_backend_key";

export function defaultSshConfig(): SshBackendConfig {
  return { enabled: false, host: "", port: 9922, user: "kali", authMode: "password", fingerprint: "" };
}

export async function loadSshConfig(): Promise<SshBackendConfig> {
  const v = (await kvGet(KEY)) as Partial<SshBackendConfig> | null;
  return { ...defaultSshConfig(), ...(v || {}) };
}

export async function saveSshConfig(c: SshBackendConfig): Promise<void> {
  await kvSet(KEY, c);
}

export async function readSshSecrets(): Promise<{ password: string; privateKey: string }> {
  const get = async (k: string) => { try { return (await SecureStore.getItemAsync(k)) || ""; } catch { return ""; } };
  return { password: await get(PW_KEY), privateKey: await get(KEYPEM_KEY) };
}

export async function writeSshPassword(pw: string): Promise<void> {
  try {
    if (pw) await SecureStore.setItemAsync(PW_KEY, pw);
    else await SecureStore.deleteItemAsync(PW_KEY);
  } catch { /* noop */ }
}

export async function writeSshKey(pem: string): Promise<void> {
  try {
    if (pem) await SecureStore.setItemAsync(KEYPEM_KEY, pem);
    else await SecureStore.deleteItemAsync(KEYPEM_KEY);
  } catch { /* noop */ }
}
