/**
 * swatOps — SHIPPED COPY of the `swat_ops` authorization list.
 *
 * SINGLE SOURCE OF TRUTH is the static `swat_ops` file in the swat-sidecar
 * repo (one nick per line). The conductor loads that file; this array is the
 * app's shipped mirror, updated alongside releases.
 *
 * DESIGN — "display live, authorize static":
 *   • Commander-ONLY actions (MISSION / ABORT / HALT / RESUME) are gated on
 *     THIS list, evaluated locally. We deliberately do NOT resolve commanders
 *     via a live query to the conductor — a live lookup is a fail-closed trap
 *     (conductor down → operator locked out of ABORT during the exact outage
 *     when they need it most).
 *   • DISPLAY stays live: the roster comes from IRC NAMES and commander chips
 *     are starred by cross-referencing this list. That's cosmetic only.
 *   • An optional `OPS` verb may ask the conductor to ECHO its copy of the
 *     file into the feed — that is an echo of static state for eyeballing
 *     drift, never an authorization input.
 *
 * KNOWN, ACCEPTED LIMITATION: nick auth is spoofable (anyone can `/nick
 * Maarten` while he's offline). Acceptable at this scale (private IRCd, ~5
 * nicks). Phase C hardening = Ergo accounts + SASL, commander = account.
 */
export const SWAT_OPS: string[] = [
  "Maarten",
  "Enforcer-Operator",
];

/** Static, local authorization check. Case-insensitive. Never blocks / never
 *  hits the network. */
export function isSwatOp(nick: string): boolean {
  const n = (nick || "").trim().toLowerCase();
  if (!n) return false;
  return SWAT_OPS.some((o) => o.toLowerCase() === n);
}
