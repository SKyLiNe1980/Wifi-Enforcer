#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================

user_problem_statement: |
  Mobile pentesting cockpit (rooted Galaxy S10+ / LineageOS 23.2 / Kali NetHunter)
  managing 3x AWUS036NH wireless adapters, orchestrating Kali chroot tools, and
  exposing an MCP server so a local LLM agent swarm can execute offensive wireless
  attacks. Current phase: STREAMING OUTPUT INFRASTRUCTURE for long-running tools
  (airodump-ng, wifite, tcpdump, hcxdumptool, dmesg -w).

backend:
  - task: "Live session ring buffer API"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: |
          Added 7 endpoints under /api/sessions/* with in-memory deque(maxlen=2000)
          ring buffer per session + Mongo `session_summaries` collection for
          ended-session audit (last 500 lines). Endpoints:
            POST /sessions/start
            POST /sessions/{id}/append   (batched line POST)
            GET  /sessions/{id}/tail?since=N  (cursor-based)
            POST /sessions/{id}/end
            DELETE /sessions/{id}
            GET  /sessions?include_ended=bool
            GET  /sessions/history?limit=N
          End-to-end smoke-tested via curl-style script: start→append→tail→list→end
          →history→delete all returned 200 with correct payloads.

frontend:
  - task: "Live tab + multi-session UI"
    implemented: true
    working: true
    file: "frontend/src/components/LiveTab.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: |
          New 📡 Live tab with:
            - Horizontal session chips (multi-session support for 3x AWUS adapters)
            - 8 streaming presets: airodump-ng, airodump→CSV, wifite PMKID,
              wifite WPA, hcxdumptool, tcpdump, iw event, dmesg -w
            - Custom command input
            - Per-session header: PID, status, line count, exit_code
            - Stop (SIGINT graceful) + Force Kill (SIGKILL, confirmation alert) buttons
            - Auto-scroll toggle (pauses on manual scroll)
            - In MOCK preview: synthesizes fake lines + warning banner
          Screenshot verified: presets drawer renders, tapping airodump-ng starts
          session, lines stream into ScrollView, status transitions
          starting→running→ended, exit_code visible.

  - task: "Native streaming Kotlin module (event emitter)"
    implemented: true
    working: "NA"
    file: "frontend/plugins/android/RootShellModule.kt"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Added executeStream(sessionId, cmd) / killSession(id, graceful) /
          listSessions(). Shell pattern:
              echo __WE_PID__$$
              exec <user-command>
          PID is extracted from stdout and used for SIGINT/SIGKILL. Graceful kill:
          SIGINT, wait 2s, escalate to SIGKILL if process still alive — gives
          airodump-ng/tcpdump time to flush CSV/pcap. Events emitted via
          DeviceEventManagerModule.RCTDeviceEventEmitter:
              RootShell.line  {sessionId, stream, line, lineNo}
              RootShell.exit  {sessionId, exit_code, duration_ms, line_count}
              RootShell.error {sessionId, message}
              RootShell.pid   {sessionId, pid}
          Two background reader threads (stdout/stderr) + 1 waiter thread per
          session. addListener/removeListeners no-ops added for RN's
          NativeEventEmitter compliance.
          CANNOT BE TESTED IN PREVIEW — requires `eas build -p android --profile
          preview` and on-device root + iface execution.

  - task: "JS streaming wrapper + session manager"
    implemented: true
    working: true
    file: "frontend/src/lib/sessionManager.ts, frontend/src/lib/rootShell.ts"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: |
          sessionManager: in-memory store (Map<id, SessionState>) with pubsub for
          UI re-render. Buffers lines locally (RING_MAX=1500) AND pushes batches
          to backend every 1.5s (FLUSH_BATCH_MAX=200) so MCP can poll. On native
          exit/error/kill, posts /sessions/{id}/end with status & exit_code.
          rootShell.ts: startStream() returns unsubscribe fn, killStream(graceful),
          listStreams(). HAS_NATIVE_STREAMING probe falls back to MOCK simulator
          in preview.

  - task: "MCP streaming tools for LLM agent swarm"
    implemented: true
    working: true
    file: "mcp/wifi_enforcer_mcp.py"
    stuck_count: 0
    priority: "medium"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: |
          6 new @mcp.tool() endpoints for the local LLM swarm (Hexstrike/CAI/
          Hermes/Claude) to drive streaming tools:
            wifi_stream_start(command, iface, label)
            wifi_stream_list(include_ended)
            wifi_stream_tail(session_id, since, max_lines)
            wifi_stream_grep(session_id, pattern, since, max_lines)
            wifi_stream_stop(session_id, graceful)
            wifi_stream_history(limit)
          Note: stream_start registers a session record but actual exec requires
          the app's Live tab running (it consumes /sessions and runs killSession
          locally when an end-request lands).

metadata:
  created_by: "main_agent"
  version: "0.2"
  test_sequence: 2
  run_ui: false
  last_phase: "Streaming Output Infrastructure"

test_plan:
  current_focus:
    - "Native streaming Kotlin module (event emitter)"
  stuck_tasks: []
  test_all: false
  test_priority: "high_first"

agent_communication:
  - agent: "main"
    message: |
      Streaming Output Infrastructure shipped end-to-end:
      • Native module supports executeStream/killSession with PID-based SIGINT→
        SIGKILL escalation (2s grace window — perfect for airodump/tcpdump CSV flush).
      • Backend has in-memory ring buffer + Mongo summary on session end.
      • Frontend Live tab supports concurrent sessions across all 3 AWUS adapters.
      • MCP exposes 6 streaming tools so the LLM swarm can poll airodump output
        in real-time, grep for handshakes/PMKID, and SIGINT cleanly.
      
      User must build the APK to test native streaming on device:
        cd /app/frontend && eas build -p android --profile preview
      Preview mode synthesizes 3 mock lines + warning banner so UI is visible.

  - agent: "main"
    message: |
      Bug-fix round on streaming method registration:
      • SYMPTOM: On user's release APK, `bridge root=✓ stream=✗ keys=1
        exec=undefined kill=undefined`. Older methods (isRoot/exec/execBatch)
        worked fine in KALI mode — confirmed by user running `id` successfully.
      • DIAGNOSIS: `removeListeners(count: Int)` had primitive-int signature.
        RN's bridge introspection expects boxed `Integer count` for this
        RN-reserved method name. Signature mismatch caused the registrar
        to abort scanning the rest of the class, silently dropping every
        @ReactMethod declared AFTER the stub (executeStream/killSession/
        listSessions all came after).
      • FIX:
        1. Changed `count: Int` → `count: Int?` so Kotlin generates
           java.lang.Integer (boxed)
        2. Moved both NativeEventEmitter stubs (addListener/removeListeners)
           to the END of the class — belt-and-suspenders: even if RN still
           hiccups, every real method registers first
      • ALSO: Added persistent bridge diagnostic bar at top of Live tab
        (was previously hidden in preset drawer)
      • ALSO: Added "default startup mode" setting + removed the race-prone
        useEffect that was force-reverting users' KALI/REAL preference back
        to MOCK on every cold start due to module-import-time race with the
        native bridge
      • User rebuilding now — waiting for diagnostic readout to confirm.

  - agent: "main"
    message: |
      FUTURE PHASE — DISTRIBUTED "ENFORCER SWARM" ARCHITECTURE (parked for later):
      
      User raised a high-value architectural vision: turn Enforcer from a
      single-device app into a distributed mesh of heterogeneous worker nodes
      (rooted phones as radio/capture nodes, desktop as GPU/compute, RPi as
      sensor) coordinated via WireGuard mesh and an LLM-driven orchestrator.
      
      Concept validated as excellent, feasible, and a natural evolution of
      current architecture:
      • Backend already has session state — needs `node_id` + routing only
      • MCP already abstracts tools — adding a `node` dimension is 1 param
      • Live tab already supports multi-session — needs node-filter chip
      • Transport problem solved externally via Tailscale/Headscale/raw WG
      
      Real-world precedents combining pieces of this: Cobalt Strike Team Server,
      Sliver/Mythic/Havoc C2s, hashcat brain mode, Kismet remote capture,
      BloodHound collector/analyzer split, WiFiPineapple Constellation.
      Nobody has unified all this into a root-Android-first LLM-driven cockpit.
      
      Proposed phased rollout (when user is ready to start):
        Phase 1: Node registration + heartbeat + Cluster tab (small effort)
        Phase 2: Remote session execution forwarding (medium)
        Phase 3: Tailscale auto-mesh bootstrap (small — Tailscale does heavy lifting)
        Phase 4: MCP cluster-aware tools (small)
        Phase 5: Pipeline DSL + smart dispatch — declarative cross-node jobs (large)
        Phase 6: Cross-node PCAP merge + GPU offload for crack-on-capture (medium)
      
      Game-changing capabilities unlocked:
      • Real-time capture→crack pipeline (phone captures handshake → desktop
        GPU picks it up mid-capture → cracked PW back in seconds)
      • Coordinated multi-radio captures across 2.4/5/6GHz simultaneously
      • RSSI triangulation via geographically-distributed nodes
      • LLM inference offload — Hermes on desktop GPU instead of phone
      • 24/7 capture nodes that auto-rejoin tailnet as user commutes
      • Distributed deauth/PMKID at scale without saturating one radio
      
      Hard parts to design around when we start:
      • Phone battery economics — need power-aware scheduling
      • Node availability flapping — orchestrator must replan when nodes drop
      • Canonical state ownership — recommendation: orchestrator owns sessions,
        workers stream into it, buffer-and-replay if orchestrator dies
      • Auth & blast radius — per-node API tokens + audit log mandatory
      • Discovery bootstrap UX — must be one QR scan, not a README
      • Time sync — NTP/chrony before any cross-node PCAP merge
      
      Open questions to lock down before starting:
        1. Tailscale (hosted) vs Headscale (self-hosted) vs raw WireGuard?
        2. Is the desktop always-on? (determines if orchestrator is fixed or floats)
        3. Air-gap mode required (LAN-only mesh, no control plane reachability)?
        4. Personal fleet only, or eventually public open-source bootstrap UX?
        5. MCP exposure: all nodes, or just orchestrator?
      
      Status: BACKLOG — not blocking current work. Resume after streaming +
      PCAP-over-IP + airodump CSV parser + boot-time auto-apply phases.


========================================================================
2026-06-06 — AI TAB TUI VIA xterm.js (Phase 2 of AI Tab Finalization)
========================================================================

Implemented true terminal emulation for the AI tab, replacing the
ANSI-stripping workaround with a real xterm.js terminal inside a
react-native-webview. Hermes / CAI-Framework / pentestagent / etc. emit
Rich + Textual + prompt-toolkit escape sequences (cursor positioning,
hyperlinks, 256-color, alternate screen) — flat <Text> scrollback can't
render any of that. xterm.js handles all of it natively.

backend:
  - task: "AIProfile.view_mode field + validation"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
        - working: true
          agent: "main"
          comment: |
            Added view_mode str field to AIProfile / AIProfileCreate /
            AIProfileUpdate Pydantic models. Validates against VIEW_MODES =
            {"xterm", "scrollback"}; defaults to "xterm" for new profiles
            AND for existing Mongo docs that predate the field (Pydantic
            applies default on read). Verified end-to-end with curl:
              - GET /api/ai-profiles → returns view_mode=xterm for seeded profiles
              - PUT /api/ai-profiles/{id} with {"view_mode":"scrollback"} → 200, persists
              - PUT with {"view_mode":"bogus"} → 400 with correct error message

frontend:
  - task: "XTermView WebView component"
    implemented: true
    working: "needs-eas-build"
    file: "frontend/src/components/XTermView.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
        - working: "needs-eas-build"
          agent: "main"
          comment: |
            Created XTermView component: react-native-webview hosting
            xterm.js@5.5.0 + addon-fit@0.10.0 from jsDelivr. Theme matches
            Enforcer's Kali green-on-black palette. Bidirectional bridge:
              - RN→Web: injectJavaScript('window.termWrite(<json>)') with
                fresh line batches from sessionManager subscription, joined
                with \r\n. Replays existing ring buffer on mount.
              - Web→RN: term.onData → postMessage → writeStdin(sessionId,
                data, appendNewline=false) — xterm encodes Enter as \r,
                we don't want to double-newline.
            Pending writes are queued until the WebView signals 'ready'.
            CDN failure surfaces a 'load_error' message; we log to console
            (future: surface in RN UI). Works only in a real APK — RN
            WebView is unsupported on web preview, which is fine since
            the native RootShell module is also unavailable there.
  - task: "AITab xterm/scrollback toggle + integration"
    implemented: true
    working: "needs-eas-build"
    file: "frontend/src/components/AITab.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
        - working: "needs-eas-build"
          agent: "main"
          comment: |
            • Added 'tui'/'scrl' toggle button in the control bar (purple
              when xterm). Toggling PUTs view_mode to backend + updates
              local profiles list optimistically.
            • Description row now displays 'view=xterm|scrollback'.
            • Transcript pane branches: xterm renders <XTermView>, scrollback
              renders the existing FlatList. XTermView is keyed by
              `${sessionId}-${viewMode}` so flipping the toggle mid-session
              cleanly remounts the WebView and replays the ring buffer.
            • Scrollback path now actually applies cleanAnsi() (was dead
              code before — explains the earlier garbled output in scrl mode).
            • sessionManager.sendInput() gained an `echo` param. AITab passes
              echo=false in xterm mode (the shell's line discipline echoes
              naturally; the "▸ " local echo would cause duplicates).
            • XTerm keystrokes route to writeStdin directly with
              appendNewline=false; xterm sends "\r" on Enter already.

  - task: "AITab scrollback ANSI rendering (existing bug fix)"
    implemented: true
    working: true
    file: "frontend/src/components/AITab.tsx"
    stuck_count: 0
    priority: "low"
    needs_retesting: false
    status_history:
        - working: true
          agent: "main"
          comment: |
            renderItem now calls cleanAnsi() before rendering — previously
            defined but never invoked. Scrollback mode is now usable as a
            fallback for non-TUI agents.

test_plan:
  current_focus:
    - "User EAS-builds the APK and validates xterm.js renders Hermes/CAI TUIs correctly"
    - "User confirms toggle round-trip (xterm → scrollback → xterm) keeps profile state"
  stuck_tasks: []
  test_all: false
  test_priority: "user_device_validation"

agent_communication:
    - agent: "main"
      message: |
        AI Tab xterm.js TUI implementation complete. Architecture summary
        for the next agent / fork:

        DATA FLOW (xterm mode):
          native RootShell stdout/stderr stream
            → SessionManager (ring buffer + backend flush)
            → AITab subscribes via sessionManager.subscribe
            → XTermView subscribes too, diffs by lastLineNoRef
            → injectJavaScript('window.termWrite(<lines joined with \r\n>)')
            → xterm.js renders ANSI escapes, cursor moves, colors, etc.

        DATA FLOW (xterm keystrokes):
          xterm.onData('q' / '\x1b[A' / '\r' / 'Ctrl-C \x03')
            → postMessage → AITab.handleXTermInput
            → writeStdin(sessionId, data, appendNewline=false)
            → native fwrite() → agent's stdin

        TOGGLE PERSISTENCE: view_mode is stored per-AIProfile in Mongo.
        Switching at runtime PUTs to /api/ai-profiles/{id}; on next app
        launch the preference comes back via GET /api/ai-profiles.

        TESTING: Cannot validate xterm rendering in Expo Go or web preview
        (react-native-webview is android/ios-only AND the native RootShell
        module isn't available off-device). User must EAS-build a preview
        APK and run on the Galaxy S10+. Verified via curl that backend
        view_mode persists + validates correctly; verified via screenshot
        that the toggle UI flips between modes and the description badge
        updates.

        WHAT'S NEXT (per user's session plan):
          - Persistent shell for Terminal Tab (reuse xterm + writeStdin)
          - Chroot wrap echo spam suppression
          - Settings sub-tabs restructure
          - Wifite2 PMKID one-tap profile

========================================================================
2026-06-06 — SETTINGS SUB-TABS + AI PROFILE CRUD + PERSISTENT SHELL
========================================================================

Two-part session focused on UX polish + a long-overdue Terminal upgrade.

frontend:
  - task: "Settings sub-tabs (general / profiles / agents)"
    implemented: true
    working: true
    file: "frontend/app/index.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
        - working: true
          agent: "main"
          comment: |
            Bottom tab bar shrunk from 6 → 5 (quick/term/live/ai/set). Profiles
            and AI Agents now nest as sub-tabs inside Settings with their own
            segmented control. Backwards-compat: any old persisted
            tab="profiles" state silently redirects to Settings > Profiles.
            Verified via screenshot on web preview — general/profiles/agents
            all render correctly, badges show counts.

  - task: "AI Agents CRUD (Settings > AI Agents)"
    implemented: true
    working: true
    file: "frontend/app/index.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
        - working: true
          agent: "main"
          comment: |
            Full list view + inline edit sheet. Fields covered:
              - name (required), command (required), description
              - pre_command (chained with && before command)
              - icon (emoji, max 4 chars)
              - wrap_mode segmented (none/pty/unbuffered)
              - view_mode segmented (TUI xterm.js / scrollback)
              - send_newline toggle row
            Skipped for v1: send_initial (rarely used).
            Optimistic UI + error reconcile on failure. Backend already
            had POST/PUT/DELETE for /api/ai-profiles, all reused.
            Verified via screenshot: editor opens, fields populate, segmented
            controls work; deletion confirmation dialog appears.

  - task: "Persistent shell mode for Terminal tab"
    implemented: true
    working: "needs-eas-build"
    file: "frontend/src/components/TerminalShell.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
        - working: "needs-eas-build"
          agent: "main"
          comment: |
            New TerminalShell component reuses the XTermView + sessionManager
            architecture from the AI tab. Terminal tab now has a sub-tab
            toggle: classic (existing su -c per-command card view) and
            shell (new persistent zsh -l session in PTY).

            Shell invocation:
              SHELL=/bin/zsh HOME=/root TERM=xterm-256color
              script -qc 'zsh -l 2>/dev/null || bash -l' /dev/null

            Why this exact incantation:
              - `script` allocates a PTY (without it: no colors, no readline,
                no zsh prompt redraw)
              - SHELL=/bin/zsh forces `script` to pick zsh inside the chroot
                (otherwise it'd inherit Android's /system/bin/sh)
              - HOME=/root so zsh finds its rc-files
              - TERM=xterm-256color tells the shell + apps what we can render
              - `|| bash -l` fallback for users without zsh in their chroot

            Session id persisted in module-level state so tab switches don't
            kill the shell. Clear button sends Ctrl-L (form-feed) rather than
            wiping the buffer — preserves shell-side state. EOF/SIGKILL
            options when closing.

            Defaults to "classic" mode so existing quick-command workflow
            isn't disrupted. User explicitly opts into persistent shell.

            Mock mode shows a warning that REAL/KALI exec mode is required.
            Verified via screenshot: toggle works, idle state renders
            cleanly, control bar appears. Real shell session requires EAS
            build (native streaming + writeStdin needed).

test_plan:
  current_focus:
    - "User EAS-builds the APK and validates persistent shell with `cd` / env vars persisting"
    - "User validates Settings > AI Agents create/edit/delete flow"
    - "User validates Profiles tab moved cleanly into Settings sub-tab"
  stuck_tasks: []
  test_all: false
  test_priority: "user_device_validation"

agent_communication:
    - agent: "main"
      message: |
        Three features ready for device validation:

        1. SETTINGS SUB-TABS — pure UI restructure, no native deps. Should
           work in any build/Expo Go. The settingsSubTab state lives in
           App-level useState — does NOT persist across cold boot (a
           deliberate choice for "always land on general" predictability).

        2. AI PROFILE EDITOR — pure backend CRUD that already existed; new
           UI is the inline sheet. Verified locally via curl + screenshot.

        3. PERSISTENT SHELL — requires EAS build. Architecture reuses
           AITab's XTermView + sessionManager pattern so anything that
           works for Hermes will work here. Test plan:
             • Open Terminal tab in shell mode
             • Tap OPEN SHELL (must have REAL or KALI exec mode)
             • Verify zsh prompt appears
             • `cd /root` then `pwd` → should show /root (state persists!)
             • Run htop / vim / nano → should render correctly
             • Switch to Quick tab and back → shell should still be alive
             • Tap CLOSE → graceful EOF or SIGKILL choice

        NEXT (per backlog):
          - Chroot wrap echo spam suppression
          - Wifite2 PMKID one-tap profile
          - Nodes Tab / swarm clustering


========================================================================
2026-06-15 — LIVE TAB WRAP-UP (ATTACK PROFILES + PCAP-OVER-IP)
========================================================================

Migrated the hardcoded Live-tab PRESETS array to MongoDB `attack_profiles`
collection, added PCAP-over-IP endpoint CRUD + endpoint-picker modal,
introduced per-profile view_mode (xterm.js for TUI tools, FlatList for
plain). Bottom-tab bar untouched, all the change lives in the Live tab +
Settings → General.

backend:
  - task: "AttackProfile + PcapEndpoint models, CRUD, seeding"
    implemented: true
    working: true
    file: "backend/server.py"
    status_history:
        - working: true
          agent: "main"
          comment: |
            New collections: `attack_profiles` (9 seeded built-ins) and
            `pcap_endpoints` (user-defined). Both with full CRUD endpoints
            under /api/attack-profiles/* and /api/pcap-endpoints/*.

            AttackProfile.command_template uses placeholders {iface},
            {host}, {port}, {file} that the frontend substitutes at launch.
            Categories: recon / attack / trace / pcap — used as the FE
            filter chips. `needs_endpoint=true` profiles force an endpoint
            pick before launching (only "PCAP → remote" right now).

            Seeded profiles cover: airodump-ng (xterm), airodump→CSV,
            wifite PMKID (xterm), wifite WPA (xterm), hcxdumptool,
            tcpdump→file, PCAP→remote (the new pcap-over-IP one), iw event,
            dmesg -w. The xterm-flagged ones get TUI rendering via the
            xterm.js component we built for AI tab — wifite/airodump emit
            curses/Rich output that needed the proper terminal emulator.

            PcapEndpoint validates port range 1..65535 + transport ∈ {tcp,
            udp}. Verified end-to-end via curl: POST/GET/PUT/DELETE all
            return 200 with proper validation 400s on bad input.

frontend:
  - task: "LiveTab refactor — dynamic attack profiles + xterm rendering + endpoint picker"
    implemented: true
    working: "needs-eas-build"
    file: "frontend/src/components/LiveTab.tsx"
    status_history:
        - working: "needs-eas-build"
          agent: "main"
          comment: |
            Major rewrite: fetches attack_profiles + pcap_endpoints on
            mount. Category filter chips (all/recon/attack/trace/pcap)
            with counts. Profile cards have a colored left-border tied to
            category, a `[tui]` mini-badge for xterm profiles, and a
            `↪ pick endpoint` hint for needs_endpoint ones.

            New `sessionViewModeRef: Map<sessionId, view_mode>` tracks
            which sessions render via XTermView vs FlatList. Selected
            session's view mode determines the bottom-pane component.
            xterm sessions get a re-keyed XTermView (no auto-scroll
            button — xterm handles its own scrolling).

            Endpoint picker is a centered Modal with a list of saved
            PcapEndpoints; tapping one substitutes {host}/{port} into the
            command_template and starts the session. Empty state shows
            an Alert pointing users to Settings → General to add one.

            Verified via web screenshot: drawer renders all 9 profiles
            with correct categories, tui badges where expected, pcap
            filter shows only the PCAP→remote profile, color accents on
            cards. Native exec validation requires EAS build.

  - task: "Settings → General PCAP endpoint CRUD section"
    implemented: true
    working: true
    file: "frontend/app/index.tsx"
    status_history:
        - working: true
          agent: "main"
          comment: |
            Added between execution-mode and data sections. Inline list of
            endpoints + "+ add endpoint" button. Editor sheet has fields:
            name, host (URL keyboard), port (numeric 1..65535), TCP/UDP
            segmented control, multi-line notes.

            Helper text includes the listener-side recipe:
            `nc -l -p 19000 | wireshark -k -i -`
            so users know how to set up the remote side.

            Verified via screenshot: section renders, editor opens cleanly,
            CRUD round-trips work via API.

test_plan:
  current_focus:
    - "User EAS-builds the APK and validates xterm.js rendering of wifite/airodump TUIs in Live tab"
    - "User validates PCAP→remote streaming to a listener (e.g., wireshark on lab PC)"
    - "User validates category filtering + endpoint picker workflow"
  stuck_tasks: []
  test_priority: "user_device_validation"

agent_communication:
    - agent: "main"
      message: |
        Live tab is now the proper capture/attack cockpit. Key data flow:

          User taps "PCAP → remote" profile
            → needs_endpoint=true → modal opens with saved PcapEndpoints
            → user picks "Wireshark LAN" (192.168.1.50:19000)
            → resolveTemplate substitutes {host}/{port}/{iface} in:
                "tcpdump -i {iface} -U -w - | nc -w 3 {host} {port}"
            → resolved: "tcpdump -i wlan2 -U -w - | nc -w 3 192.168.1.50 19000"
            → sessionManager.start(wrap(resolved))
            → live FlatList of packet-count lines + remote Wireshark sees
              the stream

        Listener-side recipe (user runs on the receiving box):
          nc -l -p 19000 | wireshark -k -i -
        Or with proper PCAP-over-IP convention:
          mkfifo /tmp/pcap.fifo
          nc -l -p 19000 > /tmp/pcap.fifo &
          wireshark -k -i /tmp/pcap.fifo

        NEXT (per backlog):
          - Chroot wrap echo spam suppression (small, cosmetic)
          - Airodump-ng live table parser (parse CSV → RN table)
          - Attack-profile editor UI in Settings (user-defined attacks)
          - MCP bridge polish (existing scaffolding at github.com/.../mcp)
          - Nodes tab + Tailscale swarm
          - Voice command stack (when Rayneo arrives)


========================================================================
2026-06-24 — MOCK-STICKINESS ROOT CAUSE FIX + DATA OBSERVABILITY
========================================================================

Eliminated the "exec_mode stuck on mock" / "AI tab empty" / "PCAP 404"
silent-fetch-failure pattern by adding retry, gating writes on success,
and surfacing per-resource load status in the UI.

frontend:
  - task: "fetchWithRetry helper + exponential backoff"
    implemented: true
    working: true
    file: "frontend/app/index.tsx"
    status_history:
        - working: true
          agent: "main"
          comment: |
            Wraps fetch with exponential backoff (300/600/1200/2400ms,
            capped 5s, ~4.5s total). Retries on network errors + 5xx +
            429/408. Does NOT retry on other 4xx (real client bugs).
            Applied to all critical fetches: settings, profiles, logs,
            ai-profiles, pcap-endpoints. Throws on final failure so
            callers surface visible error state.

  - task: "Settings GET — gate writes on success"
    implemented: true
    working: true
    file: "frontend/app/index.tsx"
    status_history:
        - working: true
          agent: "main"
          comment: |
            ROOT CAUSE NAILED: `settingsLoaded.current = true` was in
            `.finally()`, so it flipped true even on fetch FAILURE. That
            unlocked the PUT useEffect, which then race-clobbered the
            backend with the in-memory defaults ("mock") on any user
            interaction. Fix: settingsLoaded only flips true in `.then()`
            (success path). Extracted into reloadSettings() callback so
            the manual reload button can re-run it.

  - task: "Data load status block in // system"
    implemented: true
    working: true
    file: "frontend/app/index.tsx"
    status_history:
        - working: true
          agent: "main"
          comment: |
            New `// data status` section in Settings → General shows each
            critical resource's hydration state: loading / OK · N items /
            ERR · message. "reload" button at top-right of the section
            re-runs all GETs on demand. Warning banner appears when
            settings failed to load with explicit note "writes BLOCKED
            to prevent clobbering backend". User can now SEE exactly
            what's broken instead of guessing.

  - task: "AppState foreground refresh"
    implemented: true
    working: true
    file: "frontend/app/index.tsx"
    status_history:
        - working: true
          agent: "main"
          comment: |
            AppState listener triggers reload of all data when the app
            comes back to "active" from background. Catches Wi-Fi changes,
            backend restarts that happened while backgrounded, and the
            long-suspended-app cold-boot equivalent.

test_plan:
  current_focus:
    - "User EAS-builds the APK and validates exec_mode persists across cold boots"
    - "User validates // data status block shows correct OK/ERR per resource"
    - "User validates 'reload' button recovers stuck state without app restart"
    - "User cold-boots in poor network conditions and observes retry behavior"
  stuck_tasks: []

agent_communication:
    - agent: "main"
      message: |
        The mock-stickiness bug was caused by THREE compounding issues:

        1. **Silent fetch failures** — `.catch(() => {})` swallowed errors,
           UI stayed on initial defaults with zero visibility.
        2. **`settingsLoaded` race** — `.finally()` flipped it true even
           on failure, unlocking the PUT useEffect which would then
           clobber backend with default values on any user toggle.
        3. **No retry on cold boot** — first network call often happens
           before Wi-Fi is fully associated; one TypeError = total loss.

        Fix is layered:
          - Retry with backoff masks transient flakes
          - Gate writes on actual success masks the data corruption path
          - Per-resource status surface tells the user what's actually
            happening, with manual reload as a safety valve
          - AppState foreground refresh catches the "phone slept, network
            changed" scenario

        WHAT TO TEST ON DEVICE:
          1. Cold boot in KALI mode → should land on KALI (not mock)
          2. Settings → General → // data status → all rows should say "OK"
          3. Toggle airplane mode ON, wait, OFF → reload button restores
          4. Background app for 30s, switch to mobile data, foreground →
             auto-refresh should happen, data status stays OK
          5. If anything ever shows "ERR", the warning banner appears
             and writes are blocked (no clobber)

        NEXT (per backlog):
          - Cross-tab UX (Quick command output invisible in shell mode)
          - Wifite PTY wrapping (ioctl errors)
          - Chroot wrap echo spam suppression

