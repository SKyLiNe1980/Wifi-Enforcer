# Communication manifest — enforcer cockpit

Read this at the start of every session. User has repeated these preferences many times.

## Default output shape
- Code diff / file update FIRST.
- Optional: 1–3 line status. That's it.
- Preferred status format:
  - Item1 done · Item2 in progress · Item3 needs clarification · Item4 needs feedback

## Do not produce (unless explicitly asked)
- Long summaries, changelogs, "what shipped" recaps
- Markdown test pipelines / step-by-step verification lists
- Root cause analysis write-ups
- Multi-section proposals with headings and bullets
- Emoji, decorative icons, "✅ ❌ 🟢 🟠" status paint
- "Here's what I did / Here's why" narration around a diff
- Restating the user's request back at them

## Do
- Ask when unclear. Short question > long proposal.
- If theorycrafting / trade-offs / design chat: user will explicitly invite it. Then go long.
- Keep normal replies to a few sentences per item, max.
- Trust the user reads code.

## Why this matters
- Context window burns on fluff → later drop-off hurts real work.
- Credits burn on tokens the user doesn't want.
- User enjoys the discussion part, not the reporting part.

## When in doubt
Silence beats padding. Ship the code, one line of status, stop.

## Hard architecture facts — do NOT forget

1. **The cockpit runs on Android (Magisk root shell) OUTSIDE kalifs.**
   The Android side has NO `tailscale`, `nmap`, `python3` etc. binaries.
   The Tailscale.apk is a UI-only app, no CLI on the host.
2. **Everything infrastructure-y lives inside the Kali NetHunter chroot.**
   The daemon, binaries, sockets — all inside `/data/local/nhsystem/kalifs`.
3. **To exec anything meaningful, wrap with `wrapChrootCmd()`.**
   Definition (MCPTab.tsx `wrapChrootCmd`): `${settings.chroot_path} bash -c '${inner}'`
   Default `chroot_path`:
   `/data_mirror/data_ce/null/0/com.offsec.nethunter/scripts/bin/busybox_nh chroot /data/local/nhsystem/kalifs /usr/bin/sudo -E PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
4. **`.zshrc` aliases are irrelevant to us** — the app doesn't source them.
   Aliases like `tailscale='tailscale --socket=...'` only help interactive kali term.
5. **Tailscale runs in userspace-networking mode.** Socket is
   `/var/run/tailscale/tailscaled-chroot.sock` (inside the chroot).
6. **`systemctl` doesn't work** inside the chroot — no systemd. Use the .deb's
   dispatch logic (postinst/postrm handle multi-init detection).
7. **Rule of thumb:** if a shell-out involves ANY unix tool, wrap it via
   `wrapChrootCmd`. If it's `settings`/`getprop`/Android-only, don't.
