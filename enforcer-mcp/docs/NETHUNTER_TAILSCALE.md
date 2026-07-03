# NetHunter chroot ↔ Tailscale — a survival runbook

> **Battle-earned notes.** The Kali NetHunter chroot on LineageOS is a
> deeply weird environment: no `pid 1 = systemd`, dpkg-diverted
> `systemctl`/`dbus-daemon`/`polkitd`/`udev`, no native TUN routing,
> and — because Android holds the kernel network namespace — no way to
> just `tailscale up` and get on with it. This file documents the exact
> steps that worked for the enforcer swarm's cockpit node so future
> agents (human or otherwise) don't have to reinvent them.

## What DOESN'T work

- ❌ **Using Android's own `tun0`** — the chroot can see the interface
  (shared kernel) but cannot route through it. Tailscale's userspace
  stack has no path into it.
- ❌ **Creating a secondary `tun1` inside the chroot** — the kernel
  refuses to route packets between the two TUN devices even with
  matching route tables. The Android side "wins" the routing decision
  for anything not on the loopback.
- ❌ **`tailscaled` in the default kernel-networking mode** — needs
  systemd to install its network extension hooks. Silently gives up.
- ❌ **`apt full-upgrade`** in NetHunter — will nuke the delicate
  systemd / dbus / polkit hold pattern the Kali team has curated. Only
  hand-pick individual packages.

## What DOES work

The tl;dr is **tailscaled in userspace networking mode, talking to
tailscale via a non-default socket path**. Recipe:

### 1. DNS: point at Tailscale's magic resolver + strip everything else

Overwrite `/etc/resolv.conf` — do **not** append. The tail installer
would have done this if systemd worked; since it doesn't, you do it:

```conf
nameserver 100.100.100.100
options edns0 trust-ad
search tailf5f9bc.ts.net           # replace with your tailnet suffix
```

If any other nameservers are left in the file, glibc will
**round-robin** DNS queries across them. That means half your
`tailscale ip` and MagicDNS lookups will hit an upstream resolver that
knows nothing about `.ts.net` names and returns NXDOMAIN. Symptoms
look like flaky nodes and intermittent CI-style failures. Wipe the
file clean.

### 2. nsswitch: files first, then DNS

```bash
sed -i 's/^hosts:.*/hosts: files dns/' /etc/nsswitch.conf
```

Kills any `mdns4_minimal`, `[NOTFOUND=return]`, etc. entries that the
default Kali install adds and that would short-circuit the resolver
before Tailscale's DNS gets a chance.

### 3. Launch tailscaled in userspace networking mode

```bash
tailscaled \
    -tun=userspace-networking \
    -state=/var/lib/tailscale/tailscaled-chroot.state \
    -socket=/var/run/tailscale/tailscaled-chroot.sock \
    -port=41641 &
```

Key flags:

| flag                          | why                                                            |
| ----------------------------- | -------------------------------------------------------------- |
| `-tun=userspace-networking`   | Skip the kernel TUN entirely. All packets go through Tailscale's gVisor-based userspace stack. Slower, but works. |
| `-state=…-chroot.state`       | Isolated state so the chroot's `tailscaled` doesn't conflict with any Android-side Tailscale app. |
| `-socket=…-chroot.sock`       | Non-default socket path — otherwise the CLI would try to talk to Android's Tailscale daemon and get nowhere. |
| `-port=41641`                 | Standard Tailscale port; harmless but explicit is nicer.       |

### 4. Point the tailscale CLI at the right socket

```bash
alias tailscale='tailscale --socket=/var/run/tailscale/tailscaled-chroot.sock'
```

Add this to `~/.zshrc` (or `.bashrc`) so it survives new shells.
Without it, `tailscale status` / `tailscale up` will silently talk to
the wrong daemon and either sit there or say "not logged in".

### 5. Authenticate

```bash
tailscale up
```

Opens a browser URL. Copy it, paste into a browser (Android's is fine),
approve the node in the Tailscale admin panel. Then:

```bash
tailscale status
# should show your other nodes + their 100.x.y.z IPs
```

### 6. Sanity-check MagicDNS

```bash
getent hosts my-other-node
# should return 100.x.y.z my-other-node.tailf5f9bc.ts.net

curl -sS http://my-other-node:8765/health
# should hit the enforcer-mcp on that node
```

If `getent` fails but `dig @100.100.100.100 my-other-node.tailf5f9bc.ts.net`
succeeds, you missed step 2 (nsswitch).

## Enforcer-specific bits

Now that Tailscale works, the enforcer stack layers on top:

- The cockpit's Expo app probes `http://<tailnet-ip>:8765/health` on
  each node. Make sure each node's `enforcer-mcp` binds to `0.0.0.0`
  (see `enforcer-mcp-set-bind 0.0.0.0`) so it's reachable across the
  tailnet, not just loopback.
- Since there's no systemd, the cockpit's **Autospawn** feature (in
  `// mcp` tab) is what actually launches `server.py`. Postinst
  detects the diverted-systemctl case and skips its own `systemctl
  start`, printing a hint instead.
- `enforcer-cloud-*` scripts talk to Upstash REST — that path is
  unaffected by tailnet routing because it's plain HTTPS to a public
  endpoint. Your chroot needs internet, but nothing tailnet-specific.

## Held packages that keep the chroot from imploding

The Kali NetHunter team pins these with `apt-mark hold` so that a
naive `apt full-upgrade` won't pull in a working systemd (which would
then fail to start and cascade). Do **not** unhold these:

```
dhcpcd-base
dnsmasq-base
network-manager
plymouth
polkitd
speech-dispatcher
systemd
udev
wpasupplicant
xserver-xorg-core
```

If you accidentally run `apt full-upgrade` and the dpkg DB starts
screaming about broken packages, the minimum unstuck ritual is:

```bash
dpkg-divert --add --divert /usr/bin/systemd-sysusers.real \
    --rename /usr/bin/systemd-sysusers
dpkg-divert --add --divert /usr/bin/systemd-tmpfiles.real \
    --rename /usr/bin/systemd-tmpfiles
dpkg-divert --add --divert /usr/bin/systemctl.real \
    --rename /usr/bin/systemctl
dpkg --configure -a
```

The three diverts leave "shim" binaries in place of the real ones so
maintainer scripts calling them get a silent no-op (exit 0) instead of
crashing. Then `dpkg --configure -a` finishes the interrupted install
using those shims. This is exactly why enforcer-mcp's postinst probes
for `/usr/bin/systemctl.real` before touching systemctl — its presence
proves we're in a diverted environment where the real thing isn't
available.
