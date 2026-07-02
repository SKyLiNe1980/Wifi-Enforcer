/**
 * deployServer.ts — Tier 1 in-app deployment helper for new swarm nodes.
 *
 * The cockpit ships the `enforcer-mcp_*.deb` as an Expo asset. When the
 * operator taps [DEPLOY NEW NODE] we:
 *
 *   1. expo-asset materialises the .deb inside the app's cache dir.
 *   2. Root-shell mirror it INTO the NetHunter chroot's filesystem at
 *      /data/local/nhsystem/kalifs/tmp/enforcer-deploy/  so that a
 *      chroot-side process can `cd` there and serve it.
 *   3. Detect the phone's tailnet IPv4 (any interface with an IP in
 *      100.64.0.0/10 — works on Android tun0, Linux tailscale0, iOS utun*).
 *   4. Launch `python3 -m http.server` INSIDE the chroot (via the
 *      settings.chroot_path wrapper — the same one autospawn uses),
 *      bound to <tailnet-ip>:<port>. We use python3 instead of busybox
 *      httpd because: (a) NetHunter's Android-side busybox has httpd
 *      compiled as a stub applet on some builds and exits silently,
 *      (b) python3 is verified present in the chroot (`python3 --version`
 *      → 3.13+), (c) `python3 -u -m http.server` gives clean, unbuffered
 *      "IP - - [ts] "GET /file HTTP/1.0" 200 -" access log lines.
 *   5. Hand the operator a copy-pasteable curl|dpkg one-liner.
 *
 * Stopping is explicit — user taps STOP or closes the modal (which
 * force-stops on the way out).
 *
 * Networking note: the chroot inherits the Android host's network
 * namespace, so binding to the tun0 IP from inside chroot works exactly
 * the same as it would from Android-host userland. No bind-mounts or
 * network trickery required — the chroot just needs the file staged in
 * a path it can `cd` to.
 */
import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import {
  execReal, startStream, killStream, HAS_NATIVE_ROOT,
} from "./rootShell";
import { settingsLocal } from "./localDb";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const DEB_MODULE: number = require("../../assets/enforcer-node/enforcer-mcp.deb");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SHA_MODULE: number = require("../../assets/enforcer-node/enforcer-mcp.deb.sha256");

// Host-side path (Android's view of the chroot's /tmp).
export const CHROOT_ROOT = "/data/local/nhsystem/kalifs";
export const STAGE_DIR_HOST = `${CHROOT_ROOT}/tmp/enforcer-deploy`;
// Chroot-inside path (what python3 -m http.server sees as its cwd).
export const STAGE_DIR_CHROOT = "/tmp/enforcer-deploy";
export const DEPLOY_DEB_NAME = "enforcer-mcp.deb";
export const DEPLOY_DEB_PATH_HOST = `${STAGE_DIR_HOST}/${DEPLOY_DEB_NAME}`;

export type DeployPayload = {
  /** Absolute path INSIDE the chroot where the .deb has been staged. */
  debPath: string;
  /** Bytes on disk after stage copy. */
  size: number;
  /** SHA256 of the staged file, as reported by sha256sum. */
  sha256: string;
  /** Same hash but read from the bundled sidecar — diff means corruption. */
  expectedSha256: string;
};

export type HttpdHandle = {
  sessionId: string;
  ip: string;
  port: number;
};

export type DiagnosticsReport = {
  chrootPath: string;
  chrootWrapperExists: boolean;
  stageDirExists: boolean;
  debStaged: boolean;
  debSize: number;
  python3?: string;
  ipBinary?: string;
  interfaces: string[];
  tailnetIp: string | null;
  /** PIDs of any lingering deploy-server processes from previous sessions. */
  staleServers: { pid: string; cmdline: string }[];
  /** Ports currently bound in the LISTEN state — helps spot conflicts. */
  boundPorts: string[];
  raw: string;
};

// Signature we use to identify OUR own http.server instances in ps.
// Any process whose cmdline contains this exact substring is a deploy
// server we spawned earlier — safe to reap. Deliberately narrow so we
// don't nuke unrelated python http servers the operator may be running.
const DEPLOY_SIGNATURE = `python3 -u -m http.server`;
// Additional guard: cmdline must also mention our stage dir path OR
// bind to a Tailscale CGNAT (100.64/10) address. Prevents false positives.
function isOurProcess(cmdline: string): boolean {
  if (!cmdline.includes(DEPLOY_SIGNATURE)) return false;
  // Bind arg is "--bind 100.x.y.z" — Tailscale CGNAT.
  const bindMatch = cmdline.match(/--bind\s+(\d+\.\d+\.\d+\.\d+)/);
  if (bindMatch) {
    const [, ip] = bindMatch;
    const [a, b] = ip.split(".").map((n) => parseInt(n, 10));
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return cmdline.includes(STAGE_DIR_CHROOT);
}

/**
 * Scan for orphaned deploy-server processes from previous sessions.
 * These occur when the operator force-quits the app or closes the modal
 * without pressing STOP — JS-side session handle vanishes but the OS
 * process keeps serving forever. Returns [] if all clean.
 */
export async function findStaleHttpServers(): Promise<{ pid: string; cmdline: string }[]> {
  if (!HAS_NATIVE_ROOT) return [];
  try {
    // Portable: `ps -eo pid,args` works on toybox (Android) and busybox alike.
    // Fallback: /proc scan.
    const res = await execReal(
      `ps -eo pid,args 2>/dev/null | grep -F '${DEPLOY_SIGNATURE}' | grep -v grep || ` +
      `for p in /proc/[0-9]*; do ` +
      `  c=$(tr '\\0' ' ' <"$p/cmdline" 2>/dev/null); ` +
      `  case "$c" in *"${DEPLOY_SIGNATURE}"*) echo "$(basename $p) $c";; esac; ` +
      `done`,
    );
    const out = res.output || "";
    const list: { pid: string; cmdline: string }[] = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const [, pid, cmdline] = m;
      if (isOurProcess(cmdline)) list.push({ pid, cmdline });
    }
    return list;
  } catch { return []; }
}

/**
 * SIGTERM (then SIGKILL after grace) all orphaned deploy servers. Returns
 * how many we reaped. Called defensively before each START SERVING so we
 * don't fight ourselves for the port.
 */
export async function reapStaleHttpServers(): Promise<number> {
  const stale = await findStaleHttpServers();
  if (stale.length === 0) return 0;
  const pids = stale.map((s) => s.pid).join(" ");
  // Try TERM first (lets Python's SIGTERM handler close listeners cleanly),
  // then KILL after 800ms for anything stubborn. `2>/dev/null` swallows the
  // "no such process" noise on the second pass.
  await execReal(`kill -TERM ${pids} 2>/dev/null; sleep 0.8; kill -KILL ${pids} 2>/dev/null; true`);
  return stale.length;
}

/**
 * Read the list of ports currently in LISTEN state — useful to warn the
 * operator that a port they want is already busy (by anything, not just us).
 */
export async function listBoundPorts(): Promise<string[]> {
  if (!HAS_NATIVE_ROOT) return [];
  try {
    const res = await execReal(
      // ss is the modern replacement for netstat; both usually present on
      // Android via toybox. Fall through if neither exists.
      `(ss -tln 2>/dev/null || netstat -tln 2>/dev/null || true) | awk 'NR>1 {print $4}'`,
    );
    const out = res.output || "";
    const ports = new Set<string>();
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/:(\d+)$/);
      if (m) ports.add(m[1]);
    }
    return Array.from(ports).sort();
  } catch { return []; }
}

/**
 * Hydrate the bundled .deb out of the JS bundle and mirror it into the
 * NetHunter chroot's /tmp/enforcer-deploy/ so python3 -m http.server can
 * serve it directly.
 */
export async function prepareDebPayload(): Promise<DeployPayload> {
  if (!HAS_NATIVE_ROOT) {
    throw new Error("Root shell unavailable — deploy needs root to stage .deb inside chroot.");
  }

  const [debAsset, shaAsset] = await Asset.loadAsync([DEB_MODULE, SHA_MODULE]);
  if (!debAsset?.localUri) throw new Error("expo-asset failed to materialise enforcer-mcp.deb");
  if (!shaAsset?.localUri) throw new Error("expo-asset failed to materialise enforcer-mcp.deb.sha256");

  const expectedSha256 = (await new File(shaAsset.localUri).text()).trim();
  const debSrcPath = debAsset.localUri.replace(/^file:\/\//, "");

  // Mkdir the chroot-side stage dir, cp the .deb in, chmod 0644 so python
  // http.server can read it regardless of umask, then print size + sha.
  const cmd = [
    `mkdir -p '${STAGE_DIR_HOST}'`,
    `cp -f '${debSrcPath}' '${DEPLOY_DEB_PATH_HOST}'`,
    `chmod 0644 '${DEPLOY_DEB_PATH_HOST}'`,
    `wc -c < '${DEPLOY_DEB_PATH_HOST}'`,
    `sha256sum '${DEPLOY_DEB_PATH_HOST}' | awk '{print $1}'`,
  ].join(" && ");

  const res = await execReal(cmd);
  if (res.exit_code !== 0) {
    throw new Error(`stage cp failed (exit ${res.exit_code}): ${res.output || "(no output)"}`);
  }
  const lines = (res.output || "").trim().split(/\r?\n/).filter(Boolean);
  const size = parseInt(lines[lines.length - 2] || "0", 10) || 0;
  const sha256 = (lines[lines.length - 1] || "").trim().toLowerCase();

  if (size <= 0) throw new Error("stage cp produced zero-byte file.");
  if (sha256 && expectedSha256 && sha256 !== expectedSha256) {
    throw new Error(`sha256 mismatch: got ${sha256}, expected ${expectedSha256}.`);
  }

  return {
    debPath: `${STAGE_DIR_CHROOT}/${DEPLOY_DEB_NAME}`,
    size, sha256, expectedSha256,
  };
}

/**
 * Detect the phone's tailnet IPv4 by scanning all interfaces for an IP
 * inside Tailscale's CGNAT block 100.64.0.0/10. Interface name is
 * irrelevant (Android: tun0, Linux: tailscale0, iOS/macOS: utun*).
 */
export async function detectTailscaleIp(): Promise<string | null> {
  if (!HAS_NATIVE_ROOT) return null;
  try {
    const res = await execReal(
      `for B in /system/bin/ip /sbin/ip ip; do ` +
      `if command -v "$B" >/dev/null 2>&1 || [ -x "$B" ]; then ` +
      `"$B" -4 -o addr show 2>/dev/null; exit 0; fi; done; exit 1`,
    );
    if (res.exit_code !== 0) return null;
    for (const line of (res.output || "").split(/\r?\n/)) {
      const m = line.match(/^\s*\d+:\s*(\S+)\s+inet\s+(\d+)\.(\d+)\.(\d+)\.(\d+)/);
      if (!m) continue;
      const oct1 = parseInt(m[2], 10);
      const oct2 = parseInt(m[3], 10);
      if (oct1 === 100 && oct2 >= 64 && oct2 <= 127) {
        return `${m[2]}.${m[3]}.${m[4]}.${m[5]}`;
      }
    }
    return null;
  } catch { return null; }
}

/**
 * Deep diagnostic probe. Run whenever the user hits DIAGNOSE, or on
 * failure. Captures everything needed to understand why a deploy went
 * sideways WITHOUT starting a listener.
 */
export async function diagnoseDeploy(): Promise<DiagnosticsReport> {
  const settings = await settingsLocal.get();
  const chrootPath = settings.chroot_path || "";

  // We split the wrapper into 'is the busybox_nh helper still there?' vs
  // 'does the chroot answer bash?'. Both need to be true for python to
  // launch reliably.
  const wrapperCheckCmd = chrootPath
    ? `${chrootPath.split(" ")[0]} --help 2>&1 | head -1 || echo WRAPPER_MISSING`
    : `echo NO_CHROOT_PATH_SET`;

  const raw = await execReal([
    `echo === wrapper ===`,
    wrapperCheckCmd,
    `echo === stage dir ===`,
    `ls -la '${STAGE_DIR_HOST}' 2>&1 || echo STAGE_DIR_MISSING`,
    `echo === python3 in chroot ===`,
    chrootPath
      ? `${chrootPath} python3 --version 2>&1 || echo PYTHON_MISSING_IN_CHROOT`
      : `echo SKIPPED_NO_CHROOT`,
    `echo === ip binary ===`,
    `for B in /system/bin/ip /sbin/ip ip; do command -v $B >/dev/null && echo FOUND=$B && break; done`,
    `echo === interfaces ===`,
    `(/system/bin/ip -4 -o addr show 2>/dev/null || ip -4 -o addr show 2>/dev/null || echo NO_IP_BINARY) | head -20`,
  ].join(" ; "));

  const out = raw.output || "";
  const python3Match = out.match(/Python 3\.[0-9.]+/);
  const ipBinaryMatch = out.match(/FOUND=(\S+)/);
  const wrapperExists = !!chrootPath && !out.includes("WRAPPER_MISSING") && !out.includes("NO_CHROOT_PATH_SET");
  const stageDirExists = !out.includes("STAGE_DIR_MISSING");
  const debStaged = out.includes(DEPLOY_DEB_NAME);

  // Very rough size parse: look for the deb line in `ls -la` output.
  let debSize = 0;
  const debLineMatch = out.split(/\r?\n/).find((l) => l.includes(DEPLOY_DEB_NAME));
  if (debLineMatch) {
    const parts = debLineMatch.trim().split(/\s+/);
    // ls -la: perms links owner group SIZE date time name
    const maybeSize = parseInt(parts[4], 10);
    if (Number.isInteger(maybeSize)) debSize = maybeSize;
  }

  const interfaces: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*\d+:\s*(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/);
    if (m) interfaces.push(`${m[1]} → ${m[2]}`);
  }
  const tailnetIp = await detectTailscaleIp();
  const staleServers = await findStaleHttpServers();
  const boundPorts = await listBoundPorts();

  return {
    chrootPath,
    chrootWrapperExists: wrapperExists,
    stageDirExists,
    debStaged,
    debSize,
    python3: python3Match ? python3Match[0] : undefined,
    ipBinary: ipBinaryMatch ? ipBinaryMatch[1] : undefined,
    interfaces,
    tailnetIp,
    staleServers,
    boundPorts,
    raw: out,
  };
}

/**
 * Spin up python3 -m http.server INSIDE the chroot, bound to the given
 * tailnet IP + port. `-u` makes stdout unbuffered so we see each GET
 * request as it lands (great for confirming the target VPS actually
 * pulled the .deb).
 *
 * Command shape:
 *   <chroot_wrapper> bash -c 'cd /tmp/enforcer-deploy &&
 *     exec python3 -u -m http.server --bind <ip> <port>'
 *
 * `exec` so the python process REPLACES bash's PID — makes killStream
 * actually kill http.server (rather than bash's parent, leaving python
 * orphaned).
 */
export async function startHttpServer(opts: {
  ip: string;
  port: number;
  onAccessLog?: (line: string) => void;
  onExit?: (code: number) => void;
  onError?: (msg: string) => void;
}): Promise<HttpdHandle> {
  const settings = await settingsLocal.get();
  const chrootPath = settings.chroot_path || "";
  if (!chrootPath) {
    throw new Error("settings.chroot_path is empty — cannot enter NetHunter chroot to run python3.");
  }

  // Defensive housekeeping: if a previous session left orphaned deploy
  // servers lying around (app was force-killed, modal closed without STOP,
  // etc.) they'd hold our port and make bind() fail. Reap them BEFORE we
  // check port availability so a legitimate previous instance doesn't
  // look like a stranger.
  const reaped = await reapStaleHttpServers();
  if (reaped > 0) {
    opts.onAccessLog?.(`[reaped ${reaped} orphaned deploy server(s) from previous session]`);
    // Give the kernel a beat to release the TCP socket after SIGKILL,
    // otherwise the fresh bind() races and we'd fail with EADDRINUSE.
    await new Promise((r) => setTimeout(r, 400));
  }

  // Port-conflict check: someone ELSE (not us) might be using our port.
  // If so, bail with a clear message instead of a silent bind failure.
  const bound = await listBoundPorts();
  if (bound.includes(String(opts.port))) {
    throw new Error(
      `Port ${opts.port} is already bound by something we don't recognise ` +
      `(not one of our orphans). Pick a different port or free it up. ` +
      `Currently bound ports: ${bound.slice(0, 20).join(", ")}${bound.length > 20 ? "…" : ""}`,
    );
  }

  const sessionId = `enforcer-httpd-${Date.now()}`;
  const inner = `cd '${STAGE_DIR_CHROOT}' && exec python3 -u -m http.server --bind '${opts.ip}' ${opts.port}`;
  const cmd = `${chrootPath} bash -c ${JSON.stringify(inner)}`;

  startStream(sessionId, cmd, {
    onLine: (e) => opts.onAccessLog?.(`[${e.stream}] ${e.line}`),
    onExit: (e) => opts.onExit?.(e.exit_code),
    onError: (e) => opts.onError?.(e.message),
  });
  return { sessionId, ip: opts.ip, port: opts.port };
}

export async function stopHttpServer(sessionId: string): Promise<void> {
  await killStream(sessionId, /* graceful */ false).catch(() => {});
}

/**
 * Build the one-liner the operator copy-pastes onto the target node.
 */
export function buildInstallOneLiner(
  ip: string,
  port: number,
  opts: { printToken?: boolean } = {},
): string {
  const url = `http://${ip}:${port}/${DEPLOY_DEB_NAME}`;
  const base =
    `curl -fsSL ${url} -o /tmp/en.deb && ` +
    `(sudo dpkg -i /tmp/en.deb || sudo apt-get install -fy)`;
  if (!opts.printToken) return base;
  return (
    base +
    ` && echo && echo '--- node bearer (paste into cockpit) ---' && ` +
    `sudo grep '^bearer_token_hex' /etc/enforcer-mcp/config.yaml`
  );
}
