/**
 * nodeProvision.ts — cockpit-first node provisioning + remote self-heal.
 *
 * Turns the old "operator manually SSHes in, scp's the .deb, installs, edits
 * config.yaml by hand" ritual into a guided flow driven entirely from the
 * cockpit's Kali chroot shell:
 *
 *   Stage 1 (bootstrap)  — using the operator's root password ONCE (via
 *                          sshpass), drop the cockpit's ed25519 pubkey into
 *                          root@node:~/.ssh/authorized_keys. Nothing on the
 *                          node's login policy changes — we just add a key.
 *   Stage 2 (install)    — key-based SSH from here on. Detect systemd vs
 *                          SysV, pull the bundled .deb over the tailnet
 *                          (reusing the existing httpd deploy plumbing),
 *                          dpkg -i + apt -f.
 *   Stage 3 (finalize)   — sed the cockpit-chosen bearer_token_hex + bind
 *                          host into /etc/enforcer-mcp/config.yaml, write
 *                          /etc/enforcer-mcp/cloud.env, start the service
 *                          (systemd or init.d), health-check /health.
 *
 * Revive reuses the same key: `ssh root@node 'systemctl restart … ||
 * /etc/init.d/enforcer-mcp restart'`. No passwords stored, no enforcer
 * account changes, no key sprinkling beyond the one root authorized_keys.
 *
 * EVERYTHING runs inside the cockpit's Kali chroot (that's where ssh / scp /
 * sshpass / ssh-keygen live) via the injected `execChroot`, which wraps the
 * inner command with settings.chroot_path + bash -c (same path autospawn and
 * deploy already use). The chroot wrapper handles single-quote escaping, so
 * we're free to use single quotes here.
 */

// Fixed, deterministic key path inside the chroot (sudo -E runs as root).
export const COCKPIT_KEY = "/root/.ssh/enforcer_cockpit";

export type ExecResult = { output: string; exit_code: number };
export type ExecChroot = (inner: string) => Promise<ExecResult>;

export type ProvisionOpts = {
  host: string;              // node address the cockpit will talk to (tailnet IP or DNS)
  sshUser: string;           // bootstrap login user (root by default)
  sshPass: string;           // used ONCE for the pubkey bootstrap
  sshPort?: number;          // default 22
  bearerToken: string;       // written into config.yaml (must match cockpit roster)
  bindHost?: string;         // server.host to bind (default 0.0.0.0)
  mcpPort?: number;          // server port for the /health check (default 8765)
  cloudUrl?: string;         // ENFORCER_CLOUD_URL for cloud.env (optional)
  cloudToken?: string;       // ENFORCER_CLOUD_TOKEN for cloud.env (optional)
  installCron?: boolean;     // request the SysV cron watchdog (non-systemd only)
  debUrl: string;            // http://<cockpit-tailnet-ip>:<port>/enforcer-mcp.deb
};

export type ProvisionResult = {
  ok: boolean;
  stage: string;
  isSystemd: boolean | null;
  detail: string;
};

// ─── base64 (UTF-8 safe) ────────────────────────────────────────────────
// We ship every remote script as base64 and `base64 -d | sh` it on the far
// end. That completely sidesteps nested-quoting hell across the
// chroot→ssh→remote-shell boundary.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function toBase64(str: string): string {
  let bytes: number[];
  if (typeof TextEncoder !== "undefined") {
    bytes = Array.from(new TextEncoder().encode(str));
  } else {
    bytes = [];
    for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xff);
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : NaN;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : NaN;
    const t0 = b0 >> 2;
    const t1 = ((b0 & 3) << 4) | (isNaN(b1) ? 0 : b1 >> 4);
    const t2 = isNaN(b1) ? 64 : (((b1 & 15) << 2) | (isNaN(b2) ? 0 : b2 >> 6));
    const t3 = isNaN(b2) ? 64 : (b2 & 63);
    out += B64[t0] + B64[t1] + (t2 === 64 ? "=" : B64[t2]) + (t3 === 64 ? "=" : B64[t3]);
  }
  return out;
}

/** Single-quote a string for safe use inside our chroot-wrapped command. */
function sq(s: string): string {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

const SSH_OPTS =
  "-o StrictHostKeyChecking=accept-new -o BatchMode=yes " +
  "-o ConnectTimeout=12 -o ServerAliveInterval=5 -o ServerAliveCountMax=2";

/** Build a key-based ssh command that runs a base64'd remote script. */
function sshKeyExec(user: string, host: string, port: number, remoteScript: string): string {
  const b64 = toBase64(remoteScript);
  return (
    `ssh -i ${COCKPIT_KEY} ${SSH_OPTS} -p ${port} ${sq(user)}@${host} ` +
    `"echo ${b64} | base64 -d | sh"`
  );
}

/** Build a password (sshpass) ssh command that runs a base64'd remote script. */
function sshPassExec(
  user: string, pass: string, host: string, port: number, remoteScript: string,
): string {
  const b64 = toBase64(remoteScript);
  return (
    `sshpass -p ${sq(pass)} ssh -o StrictHostKeyChecking=accept-new ` +
    `-o ConnectTimeout=12 -p ${port} ${sq(user)}@${host} ` +
    `"echo ${b64} | base64 -d | sh"`
  );
}

// ─── Prerequisites (run inside the cockpit chroot) ──────────────────────

/** Ensure sshpass exists in the chroot; try to apt-install it if missing. */
export async function ensureSshpass(execChroot: ExecChroot): Promise<{ ok: boolean; detail: string }> {
  const check = await execChroot("command -v sshpass >/dev/null 2>&1 && echo HAVE || echo MISSING");
  if ((check.output || "").includes("HAVE")) return { ok: true, detail: "sshpass present" };
  const inst = await execChroot(
    "apt-get update >/dev/null 2>&1; apt-get install -y sshpass >/dev/null 2>&1; " +
    "command -v sshpass >/dev/null 2>&1 && echo INSTALLED || echo FAILED",
  );
  if ((inst.output || "").includes("INSTALLED")) return { ok: true, detail: "sshpass installed" };
  return { ok: false, detail: "sshpass missing and apt-get install failed (chroot offline?)" };
}

/** Generate the cockpit keypair if absent and return the public key line. */
export async function ensureCockpitKeypair(execChroot: ExecChroot): Promise<string> {
  const script =
    "mkdir -p /root/.ssh && chmod 700 /root/.ssh; " +
    `[ -f ${COCKPIT_KEY} ] || ssh-keygen -t ed25519 -N '' -f ${COCKPIT_KEY} -C enforcer-cockpit >/dev/null 2>&1; ` +
    `cat ${COCKPIT_KEY}.pub`;
  const res = await execChroot(script);
  const pub = (res.output || "").trim().split(/\r?\n/).find((l) => l.startsWith("ssh-")) || "";
  if (!pub) throw new Error(`keypair generation failed: ${(res.output || "").slice(0, 160)}`);
  return pub;
}

// ─── Provisioning stages ────────────────────────────────────────────────

/**
 * Full guided provision. `onLog` streams human-readable progress to the UI.
 * Returns a structured result; never throws (errors are captured in .detail).
 */
export async function provisionNode(
  opts: ProvisionOpts,
  execChroot: ExecChroot,
  onLog: (line: string) => void,
): Promise<ProvisionResult> {
  const port = opts.sshPort ?? 22;
  const user = (opts.sshUser || "root").trim();
  const mcpPort = opts.mcpPort ?? 8765;
  const bindHost = (opts.bindHost || "0.0.0.0").trim();
  let isSystemd: boolean | null = null;

  try {
    // ── Prereqs ──
    onLog("• checking sshpass in chroot…");
    const sp = await ensureSshpass(execChroot);
    onLog(`  ${sp.ok ? "✓" : "✗"} ${sp.detail}`);
    if (!sp.ok) return { ok: false, stage: "prereq", isSystemd, detail: sp.detail };

    onLog("• ensuring cockpit keypair…");
    const pub = await ensureCockpitKeypair(execChroot);
    onLog(`  ✓ ${pub.slice(0, 32)}…${pub.slice(-16)}`);

    // ── Stage 1: bootstrap key via password (used exactly once) ──
    onLog(`• stage 1 — installing cockpit key on ${opts.sshUser}@${opts.host} (password used once)…`);
    const bootstrap =
      "set -e\n" +
      "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys\n" +
      `grep -qxF ${sq(pub)} ~/.ssh/authorized_keys || echo ${sq(pub)} >> ~/.ssh/authorized_keys\n` +
      "chmod 600 ~/.ssh/authorized_keys\n" +
      "echo KEY_INSTALLED\n";
    const b = await execChroot(sshPassExec(opts.sshUser, opts.sshPass, opts.host, port, bootstrap));
    if (!(b.output || "").includes("KEY_INSTALLED")) {
      return { ok: false, stage: "bootstrap", isSystemd, detail: `key install failed: ${(b.output || "").slice(0, 200)}` };
    }
    onLog("  ✓ key installed — switching to key auth");

    // ── Detect init system (key auth) ──
    const det = await execChroot(sshKeyExec(user, opts.host, port,
      "[ -d /run/systemd/system ] && echo systemd || echo sysv\n"));
    isSystemd = (det.output || "").includes("systemd");
    onLog(`  ✓ init system: ${isSystemd ? "systemd" : "sysv/init.d"}`);

    // ── Stage 2: install the .deb (pulled over the tailnet) ──
    onLog(`• stage 2 — fetching .deb from ${opts.debUrl} and installing…`);
    const install =
      "set -e\n" +
      `curl -fsSL ${sq(opts.debUrl)} -o /tmp/enforcer-mcp.deb\n` +
      "dpkg -i /tmp/enforcer-mcp.deb || apt-get install -fy\n" +
      "echo INSTALL_DONE\n";
    const ins = await execChroot(sshKeyExec(user, opts.host, port, install));
    if (!(ins.output || "").includes("INSTALL_DONE")) {
      return { ok: false, stage: "install", isSystemd, detail: `dpkg install failed: ${(ins.output || "").slice(-300)}` };
    }
    onLog("  ✓ package installed");

    // ── Stage 3: finalize config + cloud.env + start + health ──
    onLog("• stage 3 — writing config.yaml + cloud.env, starting service…");
    const cloudEnv =
      opts.cloudUrl && opts.cloudToken
        ? `printf 'ENFORCER_CLOUD_URL=%s\\nENFORCER_CLOUD_TOKEN=%s\\n' ${sq(opts.cloudUrl)} ${sq(opts.cloudToken)} > /etc/enforcer-mcp/cloud.env && chmod 600 /etc/enforcer-mcp/cloud.env\n`
        : "true\n";
    const startCmd = isSystemd
      ? "systemctl restart enforcer-mcp"
      : "/etc/init.d/enforcer-mcp restart";
    const finalize =
      "set -e\n" +
      "CFG=/etc/enforcer-mcp/config.yaml\n" +
      // bearer_token_hex lives (indented) under the server: block.
      `sed -i 's|^\\([[:space:]]*bearer_token_hex:\\).*|\\1 "${opts.bearerToken}"|' "$CFG"\n` +
      // bind host — reuse the shipped helper if present, else sed in place.
      `if command -v enforcer-mcp-set-bind >/dev/null 2>&1; then enforcer-mcp-set-bind ${sq(bindHost)} >/dev/null 2>&1 || true; else sed -i 's|^\\([[:space:]]*host:\\).*|\\1 "${bindHost}"|' "$CFG"; fi\n` +
      cloudEnv +
      `${startCmd} || true\n` +
      "sleep 2\n" +
      `curl -fsS -m 6 http://127.0.0.1:${mcpPort}/health >/dev/null 2>&1 && echo HEALTH_OK || echo HEALTH_FAIL\n`;
    const fin = await execChroot(sshKeyExec(user, opts.host, port, finalize));
    const healthy = (fin.output || "").includes("HEALTH_OK");
    onLog(healthy ? "  ✓ service up and answering /health" : "  ⚠ started but /health did not answer yet");

    return {
      ok: true,
      stage: "done",
      isSystemd,
      detail: healthy
        ? "provisioned + healthy"
        : "provisioned; /health not confirmed yet (may still be booting)",
    };
  } catch (e: any) {
    return { ok: false, stage: "exception", isSystemd, detail: e?.message || String(e) };
  }
}

/**
 * Key-based one-shot revive. Tries systemd first, falls back to init.d.
 * Returns {ok, detail}. Requires the cockpit key to already be installed
 * (i.e. the node was provisioned through this cockpit).
 */
export async function reviveNode(
  host: string,
  execChroot: ExecChroot,
  sshPort: number = 22,
  sshUser: string = "root",
): Promise<{ ok: boolean; detail: string }> {
  const script =
    "(command -v systemctl >/dev/null 2>&1 && systemctl restart enforcer-mcp) " +
    "|| /etc/init.d/enforcer-mcp restart\n" +
    "echo REVIVE_SENT\n";
  try {
    const res = await execChroot(sshKeyExec(sshUser, host, sshPort, script));
    if ((res.output || "").includes("REVIVE_SENT")) {
      return { ok: true, detail: "restart command sent" };
    }
    return { ok: false, detail: (res.output || "no output").slice(-200) };
  } catch (e: any) {
    return { ok: false, detail: e?.message || String(e) };
  }
}
