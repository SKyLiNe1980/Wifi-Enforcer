// tailnetDetect.ts
//
// One responsibility: figure out this device's own Tailscale IP so the
// cockpit's probe target field auto-populates on first launch instead of
// making the operator paste it manually.
//
// The tricky bit is that on our S10+ cockpit chroot, tailscaled runs in
// USERSPACE-NETWORKING mode (see docs/NETHUNTER_TAILSCALE.md). In that
// mode there's no `tailscale0` interface AND no local kernel-visible
// address in the 100.64.0.0/10 CGNAT range that Tailscale uses —
// gVisor handles routing entirely in userspace. So parsing `ip addr`
// or `ifconfig` returns nothing on that setup; the only source of
// truth is asking the tailscaled daemon over its unix socket.
//
// We probe in this order, falling through on empty output:
//
//   1. Chroot-mode `tailscale` CLI pointed at the non-default socket
//      (matches how the operator aliased it in the NetHunter runbook)
//   2. Standard `tailscale` CLI with the default socket (VPS/kernel-mode)
//   3. `ip -4 addr show` parsed for any `inet 100.x.y.z` — catches
//      exotic setups where the daemon is unreachable but the address
//      is on some interface (Alpine podroid VMs behave this way)
//   4. `ifconfig` parsed the same way — last-ditch fallback for hosts
//      that lack the `ip` binary (some minimal chroots)
//
// The command runs via RootShell.exec so it inherits the same chroot
// context the rest of the cockpit uses. Total wall time is bounded to
// ~1.5s because the shell has a 3s default and we bail on the first
// success.

import { execReal } from "./rootShell";

/** RFC 6598 (100.64.0.0/10) is the CGNAT range Tailscale carves out
 *  of. Anything in there is almost certainly a tailnet IP on this
 *  device. Anything else is definitely not. */
const TAILNET_IP_RE = /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+\b/;

/**
 * Best-effort detection of THIS device's tailnet IP. Returns null if
 * every strategy comes up empty (tailscaled not running, chroot has no
 * tailscale at all, offline, etc). Never throws — callers can safely
 * ignore the null and prompt the operator to paste manually.
 *
 * Safe to call on cockpit startup; total worst-case latency ~1.5s.
 */
export async function detectTailnetIp(): Promise<string | null> {
  // Each strategy is a one-liner shell command that prints ONLY the IP
  // on success (or nothing on failure). We eyeball each output through
  // the tailnet regex before trusting it, so a shell that accidentally
  // prints "usage: tailscale ..." won't slip through as an IP.
  const probes: Array<{ name: string; cmd: string }> = [
    {
      name: "chroot-socket",
      // The socket path the S10+ cockpit uses per NETHUNTER_TAILSCALE.md.
      // `ip -4` prints one IP per line; head -1 gives us the primary.
      cmd: "tailscale --socket=/var/run/tailscale/tailscaled-chroot.sock ip -4 2>/dev/null | head -1",
    },
    {
      name: "default-socket",
      // Standard kernel-mode / VPS install path.
      cmd: "tailscale ip -4 2>/dev/null | head -1",
    },
    {
      name: "ip-addr",
      // Scope STRICTLY to the tailscale interface(s). Carrier CGNAT on
      // rmnet0/wwan0 also lives in 100.64/10 (RFC 6598), so an unscoped
      // `ip addr | grep 100.64/10` can grab the mobile-data IP by
      // mistake (observed: probe host auto-set to rmnet0's 100.100.x).
      // Only tailscale0/tun0 count as tailnet ifaces in kernel mode.
      cmd: "for i in tailscale0 tun0; do ip -4 addr show $i 2>/dev/null; done | grep -oE 'inet 100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.[0-9]+\\.[0-9]+' | head -1 | awk '{print $2}'",
    },
    {
      name: "ifconfig",
      // Same idea, iface-scoped, via ifconfig (busybox / older Debian).
      cmd: "for i in tailscale0 tun0; do ifconfig $i 2>/dev/null; done | grep -oE 'inet (addr:)?100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.[0-9]+\\.[0-9]+' | head -1 | awk '{print $NF}' | tr -d 'addr:'",
    },
  ];

  for (const p of probes) {
    try {
      // execReal returns { output, exit_code, ... } — we don't care
      // about exit code here (a `grep | head` failing produces empty
      // output which is exactly what we want to fall through on).
      const r = await execReal(p.cmd);
      const candidate = (r.output || "").trim().split("\n")[0]?.trim();
      if (candidate && TAILNET_IP_RE.test(candidate)) {
        // Extra guard: the regex could match a substring inside a
        // longer accidentally-printed line. Enforce that the value we
        // return is EXACTLY the matched IP.
        const m = candidate.match(TAILNET_IP_RE);
        if (m) return m[0];
      }
    } catch {
      // execReal can fail for a dozen reasons (no root, chroot not
      // ready, native module unavailable in Expo Go). We swallow and
      // try the next strategy.
    }
  }
  return null;
}
