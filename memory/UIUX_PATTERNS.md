# UI/UX pattern library for Enforcer Framework

**Purpose:** Design patterns and rationale for the cockpit's visual identity, so future agent sessions (and Mem0-backed agents) share the same taste and avoid re-inventing decisions.

**Attribution:** Ideas in the Chat UI section are credited to a brainstorm with Gemini (operator's prompt: "cool UI ideas that don't require heavy SDKs/libs"). Curation, adaptation, and phasing by the cockpit dev.

---

## Established (already in the app)

### Color language
- **Background:** `#04070a` (near-black, slight green tint)
- **Panels:** `#0a1116` / `#0e1820` (elevated surfaces)
- **Borders:** `#163041` (subtle, cyberpunk-cyan lean)
- **Primary accent:** `#00ff66` (bright terminal green) — used for section titles, active states, ON toggles
- **Secondary accent:** `#3ad7ff` (cyan) — used for values, links, informational text
- **Warning:** `#ffd400` (yellow) — probing states, transitional
- **Error:** `#ff3860` (red) — errors, dangerous actions
- **Magenta:** `#ff5cdb` — highlighted special modes (e.g. monitor mode)
- **Text primary:** `#cfeadb` (soft green-white)
- **Text dim:** `#6c8a82` (muted for helper text)

### Typography
- **Monospace** for terminal output, code, commands: platform-native (Menlo on iOS, monospace on Android)
- **Font sizes:** section titles 12px, body 13px, helper 11px, fine helper 10px
- **Letter spacing:** 1px on section titles for that terminal-header feel

### Section headers
- Formatted as `// section-name` in lowercase — mirrors code comment aesthetic
- Always green (`#00ff66`), monospace, letter-spacing 1

### Toggles (as established in WlanControl)
- Row layout: **glow dot** · **label + subtitle** · **track/knob**
- Glow dot has a translucent halo underneath for the "neon" pulse effect
- Dot color: green (on) / dim grey (off) / yellow (probing or unknown)
- Track: dark border-color base, transitions to `greenDim` when ON
- Knob: white when off, green when on, yellow when busy

### Cards & panels
- 1px border in `#163041`
- Border radius 3-4px (sharp, not pillowy)
- Panel background `#0a1116`
- No shadows — flat with borders only (respects the terminal aesthetic)

### Status pills / chips
- Rounded 3px, 1px border, mono text
- Active state: solid fill of the accent color, black text
- Inactive: transparent fill, accent-colored text + border

---

## Chat UI patterns (Gemini's suggestions, curated)

Source: Gemini brainstorm on non-heavy-SDK chat UI ideas that fit the SecOps cockpit vibe. All five deemed worth adopting, phased across roadmap 5.A → 5.D.

### 1. State-driven collapsible "thought process" blocks
**Pattern:** When the agent is reasoning, render a minimized status pill: `[Hermes] Parsing network vector... ▼`. Tap to expand → shows raw thought log. Auto-collapses when the agent commits to an action; final output prints cleanly below.

**Why:** Autonomous agents generate a lot of internal reasoning. Walls of text kill scannability. Collapsibility preserves full audit while keeping the chat clean.

**Implementation notes:**
- react-native-reanimated `LayoutAnimation` for smooth expand/collapse
- State machine per message: `thinking → committed → collapsed`
- Store raw thought log in SQLite for later replay/audit

**Precedent:** Anthropic Claude web UI, continue.dev VSCode agent panel.

---

### 2. Live node & target previews (rich media inline)
**Pattern:** During message render, tokenize the text via regex to find IPs, MAC addresses, hostnames. Replace those tokens with `<HostChip>` components — clickable pills with a mini colored dot indicating recon status (green = scanned, yellow = partial, grey = unknown).

Tapping a chip opens a bottom sheet directly over the chat showing: active ports (last nmap), OS fingerprint, exploit history from Mem0, MAC OUI vendor lookup.

**Why:** Text-only chats waste the interactivity that mobile UIs enable. Every mentioned host becomes a rally point for further ops.

**Implementation notes:**
- Regex tokenizer during message parse: `\b(?:\d{1,3}\.){3}\d{1,3}\b`, `\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b`, hostname pattern
- `<HostChip />` component with status dot + label + tap handler
- Bottom sheet reuses existing modal pattern (see MCPTab deploy modal)
- Inline code + syntax highlighting via `react-native-syntax-highlighter` for exploit scripts / JSON / raw payloads

---

### 3. Visual swarm status headers
**Pattern:** Sticky ribbon at the top of the chat view (dynamic app-bar toolbar):
- Compact horizontal cluster showing active agent slots
- Mini animated packet-ping indicator when Agent2Agent sync occurs
- Optional chroot CPU/RAM mini-graph

Above each message bubble in swarm ops: mini inline topology `Hermes ──► [Agent_B] ──► Target`.

**Why:** Once we're running Agent2Agent or Agent2Swarm operations, you can't tell who's talking to whom without cluttering the chat stream. This surfaces coordination at a glance.

**Implementation notes:**
- Sticky-header pattern via `stickyHeaderIndices` on FlashList
- Reanimated for the ping-pulse animation (400ms scale + opacity cycle)
- Mini topology renderer: simple SVG or Text-based tree
- Depends on Phase 4 (probe host) being live so we actually have multi-agent coordination to visualize

---

### 4. Interactive command interception — "slide to authorize" cards
**Pattern:** When an autonomous agent decides to run a potentially destructive command, instead of just executing (or asking via text), it drops a distinctive UI Card:
- Dark amber border (warning tone)
- Displays exact command + target(s) + reasoning
- Slider widget: "Slide to Authorize" (optional biometric via `expo-local-authentication`)
- On authorize: card morphs via layout transition → live terminal progress spinner
- On deny: flashes red, logs the user intervention

**Why:** Human-in-the-loop for autonomous SecOps agents. Non-negotiable safety layer.

**Implementation notes:**
- Policy engine sits in Aperture middleware (not on the phone) — decides which commands need slide-auth
- Policy learns preferences → Mem0 ("always auto-approve `iw dev` reads on trusted nodes")
- Card component: `react-native-reanimated` swipe gesture with progress threshold
- Interventions logged with reasoning to audit table for later review

---

### 5. Cyberpunk/SecOps aesthetic polish
**Pattern:**
- **Fonts:** JetBrains Mono / Fira Code / Share Tech Mono for agent output; clean sans-serif for platform chrome (fallback: platform monospace)
- **Chrono-stamps:** high-precision `T+HH:MM:SS.mmm` counting from op start (or UTC epoch) — tucked into corner of every agent transmission, replaces standard `14:23`
- **Subtle glows:** neon border glow on the chat container when active agent is streaming
- **Shimmer effect:** trailing shimmer on text being currently generated (Reanimated interpolated opacity gradient)

**Status:**
- ✅ Monospace agent output — already default
- ✅ Green/cyan/magenta palette — established
- 🟡 Custom font (JetBrains Mono, etc.) — need to load via `expo-font`
- 🔴 Chrono-stamps — not yet implemented
- 🔴 Shimmer / glow pulse — not yet implemented
- 🔴 Border glow on active-stream — not yet implemented

---

## General anti-patterns to avoid

- **Standard iMessage / WhatsApp chat bubble style** — clashes with the cockpit identity. We're a HUD, not a messenger.
- **Heavy chat SDKs** (CometChat, Stream, Sendbird) — they solve user-to-user messaging, not agent chat. Wrong problem space, wrong aesthetic, would fight our design system.
- **Rounded pillowy shapes** — the app is angular / borders-only / terminal-inspired. Bubbly rounded corners break immersion.
- **Emoji-heavy status** in chrome — save emoji for user-generated content or the occasional agent output. Terminal UIs prefer glyphs (`▶`, `→`, `▓`, `⬢`, `[■]`).
- **Non-mono fonts for anything the agent says** — the agent output is code-adjacent, keep it mono.

---

## Handy component references from current codebase

| Pattern | File | Notes |
|---|---|---|
| Toggle row with glow dot | `src/components/WlanControl.tsx` `ToggleRow` | Reuse for chat guardrail state indicators |
| Modal overlay pattern | `src/components/MCPTab.tsx` deploy modal | Reuse for host-chip bottom sheet |
| Live stats card w/ periodic refresh | `src/components/WlanControl.tsx` stats card | Reuse for swarm status ribbon |
| Chip row (chip picker) | `src/components/WlanControl.tsx` `ChannelChip` | Reuse for agent picker in chat header |
| ANSI cleanup for scrollback | `src/lib/ansiUtils.ts` | Reuse in chat's raw-mode fallback view |
| Streaming line consumer | `src/components/XTermView.tsx` | Study for SSE stream → chat message conversion |
