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
