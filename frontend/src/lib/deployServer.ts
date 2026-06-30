/**
 * deployServer.ts — Tier 1 in-app deployment helper for new swarm nodes.
 *
 * The cockpit ships the `enforcer-mcp_*.deb` as an Expo asset. When the
 * operator taps [DEPLOY NEW NODE] we:
 *
 *   1. expo-asset `downloadAsync()` so the file lives at a real path the
 *      shell can see (not just inside the JS bundle).
 *   2. Root-shell `cp` it into /data/local/tmp/enforcer-deploy/ so the
 *      tiny http server has a stable, readable working dir regardless of
 *      Android's per-app cache namespacing.
 *   3. Detect the phone's Tailscale IPv4 (interface `tailscale0`).
 *   4. Launch `busybox httpd` bound to <tailscale-ip>:<port> serving that
 *      directory. We bind ONLY to the tailnet IP so the .deb is reachable
 *      from the mesh but invisible to LAN / public attackers — the user
 *      relies on Tailscale ACLs as a second layer of authz.
 *   5. Hand the user a copy-pasteable one-liner that, when run on the
 *      target VPS, downloads the .deb, installs it, and prints the
 *      generated bearer token + the line of postinst output that contains
 *      it so the operator can paste it back into [+ ADD NODE].
 *
 * Stopping the server is explicit: tap STOP, or kill from // status.
 * busybox httpd has no built-in "exit after N downloads" mode so we let
 * the user decide when to tear it down (typically right after the curl
 * on the target node succeeds).
 *
 * All shell work goes through the existing RootShell streaming API — no
 * new native modules, no new perms.
 */
import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import { execReal, startStream, killStream, HAS_NATIVE_ROOT } from "./rootShell";

// Asset module IDs — Metro will hash + bundle these once `.deb` + `.sha256`
// are in `assetExts` (see metro.config.js).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const DEB_MODULE: number = require("../../assets/enforcer-node/enforcer-mcp.deb");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SHA_MODULE: number = require("../../assets/enforcer-node/enforcer-mcp.deb.sha256");

// Where on the rooted device we stage the .deb for httpd to serve. Inside
// /data/local/tmp because:
//   • survives app reinstall (the cockpit might be reinstalled mid-deploy)
//   • already in busybox httpd's default access path
//   • doesn't need world-readable Public storage perms
export const DEPLOY_STAGE_DIR = "/data/local/tmp/enforcer-deploy";
export const DEPLOY_DEB_NAME = "enforcer-mcp.deb";
// Filename for the .deb under the stage dir. Stable so the one-liner URL
// doesn't depend on the version string.
export const DEPLOY_DEB_PATH = `${DEPLOY_STAGE_DIR}/${DEPLOY_DEB_NAME}`;

export type DeployPayload = {
  /** Absolute on-device path where the .deb has been staged. */
  debPath: string;
  /** Bytes on disk after stage copy. */
  size: number;
  /** SHA256 of the staged file, as reported by /system/bin/sha256sum. */
  sha256: string;
  /** Same hash but read from the bundled sidecar — diff means corruption. */
  expectedSha256: string;
};

export type HttpdHandle = {
  sessionId: string;
  ip: string;
  port: number;
  /** Most recent line of httpd output (helpful for "what just downloaded"). */
  lastLine?: string;
};

/**
 * Hydrate the bundled .deb out of the JS bundle into the cache directory,
 * then mirror it to /data/local/tmp/enforcer-deploy/ as root.
 *
 * Returns the staged path + size + SHA, so the UI can verify integrity and
 * show the user something concrete BEFORE the http server goes live.
 */
export async function prepareDebPayload(): Promise<DeployPayload> {
  if (!HAS_NATIVE_ROOT) {
    throw new Error("Root shell unavailable — deploy server needs root to cp into /data/local/tmp.");
  }

  // 1. expo-asset → real on-disk path inside the app's cache dir.
  const [debAsset, shaAsset] = await Asset.loadAsync([DEB_MODULE, SHA_MODULE]);
  if (!debAsset?.localUri) throw new Error("expo-asset failed to materialise enforcer-mcp.deb");
  if (!shaAsset?.localUri) throw new Error("expo-asset failed to materialise enforcer-mcp.deb.sha256");

  // Read the sidecar (it's a tiny hex string + newline) for the expected hash.
  // expo-file-system v19 made `.text()` async — must await.
  const expectedSha256 = (await new File(shaAsset.localUri).text()).trim();

  // Convert file:// URIs to plain absolute paths for the shell.
  const debSrcPath = debAsset.localUri.replace(/^file:\/\//, "");

  // 2. Root-shell mkdir + cp + chmod. -p so re-runs don't fail; chmod 644
  // so busybox httpd (running as root, but defensive) can definitely read.
  // Note: `cp -f` so a stale older-version stage gets replaced.
  const cmd = [
    `mkdir -p '${DEPLOY_STAGE_DIR}'`,
    `cp -f '${debSrcPath}' '${DEPLOY_DEB_PATH}'`,
    `chmod 0644 '${DEPLOY_DEB_PATH}'`,
    // Print size + sha so we get one round-trip. busybox sha256sum exists on
    // LineageOS via toybox.
    `wc -c < '${DEPLOY_DEB_PATH}'`,
    `sha256sum '${DEPLOY_DEB_PATH}' | awk '{print $1}'`,
  ].join(" && ");

  const res = await execReal(cmd);
  if (res.exit_code !== 0) {
    throw new Error(`stage cp failed (exit ${res.exit_code}): ${res.output || "(no output)"}`);
  }
  // Last two lines of stdout are size + sha.
  const lines = (res.output || "").trim().split(/\r?\n/).filter(Boolean);
  const size = parseInt(lines[lines.length - 2] || "0", 10) || 0;
  const sha256 = (lines[lines.length - 1] || "").trim().toLowerCase();

  if (size <= 0) {
    throw new Error("stage cp produced zero-byte file — disk full or read failed?");
  }
  if (sha256 && expectedSha256 && sha256 !== expectedSha256) {
    throw new Error(
      `sha256 mismatch after stage: got ${sha256}, expected ${expectedSha256}. ` +
      `Rerun the build, the asset cache may be stale.`,
    );
  }

  return { debPath: DEPLOY_DEB_PATH, size, sha256, expectedSha256 };
}

/**
 * Read the phone's Tailscale IPv4. Returns null if tailscale0 isn't up.
 * Format we expect from `ip -4 -o addr show tailscale0`:
 *
 *   N: tailscale0    inet 100.x.y.z/32 scope global tailscale0\       valid_lft ...
 *
 * We grep for `inet ` + take the next token without the CIDR mask.
 */
export async function detectTailscaleIp(): Promise<string | null> {
  if (!HAS_NATIVE_ROOT) return null;
  try {
    // -o = one-line output so parsing is trivial. We try a couple of `ip`
    // locations because LineageOS sometimes mounts /system/bin first and
    // sometimes /sbin. busybox provides `ip` as a fallback inside chroot
    // but here we expect the Android-side ip binary.
    const res = await execReal(
      `for B in /system/bin/ip /sbin/ip ip; do ` +
      `if command -v "$B" >/dev/null 2>&1 || [ -x "$B" ]; then ` +
      `"$B" -4 -o addr show tailscale0 2>/dev/null; exit 0; fi; done; exit 1`,
    );
    if (res.exit_code !== 0) return null;
    const out = res.output || "";
    const m = out.match(/\binet\s+(\d+\.\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Spin up the temporary http server.
 *
 * Implementation detail: we use `busybox httpd` (always present in NetHunter
 * / rooted Android) and bind it to `<ip>:<port>` so the OS only accepts
 * connections on that interface. `-f` keeps it in the foreground which is
 * critical — our streaming bridge needs a running process to attach to,
 * and a backgrounded httpd would daemonise and slip out of our control.
 *
 * We log each access via httpd's stderr (it prints `connection from ...`)
 * so the UI can confirm "yep, the VPS just pulled the deb".
 */
export function startHttpServer(opts: {
  ip: string;
  port: number;
  onAccessLog?: (line: string) => void;
  onExit?: (code: number) => void;
  onError?: (msg: string) => void;
}): HttpdHandle {
  const sessionId = `enforcer-httpd-${Date.now()}`;
  // -f foreground · -v verbose · -p bind addr · -h docroot
  // toybox httpd accepts `-v` to log connections to stderr.
  const cmd =
    `cd '${DEPLOY_STAGE_DIR}' && ` +
    `busybox httpd -f -v -p '${opts.ip}:${opts.port}' -h '${DEPLOY_STAGE_DIR}'`;
  startStream(sessionId, cmd, {
    onLine: (e) => opts.onAccessLog?.(e.line),
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
 *
 * Shape:
 *   curl -fsSL http://<phone-tailnet-ip>:<port>/enforcer-mcp.deb -o /tmp/en.deb \
 *     && sudo dpkg -i /tmp/en.deb || sudo apt-get install -fy \
 *     && sudo grep '^bearer_token_hex' /etc/enforcer-mcp/config.yaml
 *
 * `apt-get install -fy` after `dpkg -i` resolves the Depends: (python3-venv
 * and friends) that dpkg can't fetch on its own. The trailing grep prints
 * the bearer token so the operator can paste it into [+ ADD NODE].
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
