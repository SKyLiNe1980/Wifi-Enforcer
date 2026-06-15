from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from collections import deque
import os
import logging
import re
import asyncio
import random
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Deque
import uuid
from datetime import datetime, timezone


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

app = FastAPI(title="WiFi Enforcer API")
api_router = APIRouter(prefix="/api")


# ---------- Models ----------
class CommandRequest(BaseModel):
    command: str
    profile_id: Optional[str] = None


class CommandLog(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    command: str
    output: str
    exit_code: int = 0
    duration_ms: int = 0
    mocked: bool = True
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class Profile(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    description: str = ""
    commands: List[str] = []
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class ProfileCreate(BaseModel):
    name: str
    description: str = ""
    commands: List[str] = []


class ProfileRunResult(BaseModel):
    profile_id: str
    profile_name: str
    logs: List[CommandLog]


# ---------- Mock su executor ----------
def _mock_output(cmd: str) -> tuple[str, int]:
    """Return realistic-looking simulated output for known android shell / root cmds."""
    c = cmd.strip()
    cl = c.lower()

    # whoami / id
    if cl == "whoami":
        return ("root", 0)
    if cl == "id":
        return ("uid=0(root) gid=0(root) groups=0(root) context=u:r:su:s0", 0)

    # svc wifi
    if cl.startswith("svc wifi disable"):
        return ("", 0)
    if cl.startswith("svc wifi enable"):
        return ("", 0)

    # ifconfig down/up
    m = re.match(r"ifconfig\s+(\S+)\s+(up|down)", cl)
    if m:
        return ("", 0)
    if cl == "ifconfig" or cl.startswith("ifconfig "):
        iface = "wlan0"
        m2 = re.match(r"ifconfig\s+(\S+)$", cl)
        if m2:
            iface = m2.group(1)
        return (
            f"{iface}     Link encap:UNSPEC  HWaddr 02-1A-11-FF-AA-{random.randint(10, 99)}\n"
            f"          inet addr:192.168.1.{random.randint(2, 254)}  Bcast:192.168.1.255  Mask:255.255.255.0\n"
            f"          UP BROADCAST RUNNING MULTICAST  MTU:1500  Metric:1\n"
            f"          RX packets:{random.randint(100, 9999)} errors:0 dropped:0\n"
            f"          TX packets:{random.randint(100, 9999)} errors:0 dropped:0",
            0,
        )

    # setprop / getprop
    m = re.match(r"setprop\s+(\S+)\s+(\S+)", cl)
    if m:
        return ("", 0)
    m = re.match(r"getprop\s+(\S+)", cl)
    if m:
        key = m.group(1)
        fake = {
            "wifi.interface": "wlan0",
            "wifi.country": "US",
            "ro.product.model": "SM-G975F",
            "ro.build.version.release": "14",
        }
        return (fake.get(key, ""), 0)

    # iw reg
    if cl.startswith("iw reg get"):
        return (
            "global\n"
            "country US: DFS-FCC\n"
            "    (2400 - 2472 @ 40), (N/A, 30), (N/A)\n"
            "    (5170 - 5250 @ 80), (N/A, 23), (N/A), AUTO-BW\n"
            "    (5250 - 5330 @ 80), (N/A, 23), (0 ms), DFS, AUTO-BW\n"
            "    (5490 - 5730 @ 160), (N/A, 23), (0 ms), DFS\n"
            "    (5735 - 5835 @ 80), (N/A, 30), (N/A)",
            0,
        )
    m = re.match(r"iw\s+reg\s+set\s+([A-Z]{2})", c)
    if m:
        return ("", 0)

    # cmd wifi force-country-code
    m = re.match(r"cmd\s+wifi\s+force-country-code\s+(enabled|disabled)\s*([A-Z]{2})?", c)
    if m:
        state = m.group(1)
        cc = m.group(2) or ""
        if state == "enabled":
            return (f"Force country code enabled, country code = {cc}", 0)
        return ("Force country code disabled", 0)

    if cl == "cmd wifi status":
        return (
            "Wi-Fi is enabled\n"
            "Verbose logging is off\n"
            "Stay-awake conditions: 3\n"
            "Mobile data always active: false\n"
            "Tethering interface: wlan0\n"
            "Wi-Fi AP state: disabled",
            0,
        )

    # iwconfig
    if cl.startswith("iwconfig"):
        return (
            "wlan0     IEEE 802.11  ESSID:\"Hackerspace\"\n"
            "          Mode:Managed  Frequency:5.18 GHz  Access Point: AC:DE:48:00:11:22\n"
            "          Bit Rate=433 Mb/s   Tx-Power=23 dBm\n"
            "          Retry short limit:7   RTS thr:off   Fragment thr:off\n"
            "          Power Management:on\n"
            "          Link Quality=70/70  Signal level=-38 dBm",
            0,
        )

    # Country code reset
    if "wifi.country" in cl and "reset" in cl:
        return ("", 0)

    # ip link / ip addr
    if cl.startswith("ip link") or cl.startswith("ip addr"):
        return (
            "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue\n"
            "    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n"
            "2: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq\n"
            "    link/ether 02:1a:11:ff:aa:bb brd ff:ff:ff:ff:ff:ff",
            0,
        )

    # settings put/get global
    m = re.match(r"settings\s+(put|get)\s+global\s+(\S+)(?:\s+(\S+))?", cl)
    if m:
        op = m.group(1)
        key = m.group(2)
        if op == "get":
            fake = {"wifi_on": "1", "wifi_scan_always_enabled": "1", "private_dns_mode": "off"}
            return (fake.get(key, "null"), 0)
        return ("", 0)

    # Empty / comments
    if not c or c.startswith("#"):
        return ("", 0)

    # echo
    m = re.match(r"echo\s+(.*)", c)
    if m:
        return (m.group(1).strip('"').strip("'"), 0)

    # Unknown -> generic mock note
    return (f"[mock] queued: would exec `{c}` via su (no real exec in preview)", 0)


LOG_MAX = 200  # cap historical log entries to avoid flooding the terminal scrollback on every launch


async def _prune_logs():
    """Trim db.command_logs to the most recent LOG_MAX entries.
    Idempotent — safe to call after every insert. Uses a single bulk delete keyed on
    a sentinel cutoff timestamp so it stays O(1) writes regardless of overflow size."""
    count = await db.command_logs.count_documents({})
    if count <= LOG_MAX:
        return
    # Find the timestamp of the LOG_MAX-th newest entry; delete anything older.
    cursor = db.command_logs.find({}, {"timestamp": 1, "_id": 0}).sort("timestamp", -1).skip(LOG_MAX).limit(1)
    cutoff_doc = await cursor.to_list(1)
    if cutoff_doc:
        cutoff = cutoff_doc[0]["timestamp"]
        await db.command_logs.delete_many({"timestamp": {"$lte": cutoff}})


async def execute_mock(command: str) -> CommandLog:
    started = datetime.now(timezone.utc)
    # simulate latency
    await asyncio.sleep(random.uniform(0.05, 0.25))
    out, code = _mock_output(command)
    dur = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
    log = CommandLog(command=command, output=out, exit_code=code, duration_ms=dur, mocked=True)
    await db.command_logs.insert_one(log.dict())
    await _prune_logs()
    return log


# ---------- Routes ----------
@api_router.get("/")
async def root():
    return {"message": "WiFi Enforcer API", "mocked": True}


@api_router.get("/health")
async def health():
    # mocked root status — for UI badge
    return {"status": "ok", "root_granted": True, "mocked": True, "android_version": "14 (LineageOS 23.2)", "device": "SM-G975F"}


@api_router.post("/execute", response_model=CommandLog)
async def execute(req: CommandRequest):
    if not req.command.strip():
        raise HTTPException(status_code=400, detail="empty command")
    return await execute_mock(req.command)


@api_router.get("/logs", response_model=List[CommandLog])
async def get_logs(limit: int = 200):
    docs = await db.command_logs.find({}, {"_id": 0}).sort("timestamp", -1).to_list(limit)
    return [CommandLog(**d) for d in docs]


@api_router.delete("/logs")
async def clear_logs():
    res = await db.command_logs.delete_many({})
    return {"deleted": res.deleted_count}


@api_router.get("/profiles", response_model=List[Profile])
async def list_profiles():
    docs = await db.profiles.find({}, {"_id": 0}).sort("created_at", 1).to_list(500)
    return [Profile(**d) for d in docs]


@api_router.post("/profiles", response_model=Profile)
async def create_profile(p: ProfileCreate):
    prof = Profile(**p.dict())
    await db.profiles.insert_one(prof.dict())
    return prof


@api_router.delete("/profiles/{profile_id}")
async def delete_profile(profile_id: str):
    res = await db.profiles.delete_one({"id": profile_id})
    if res.deleted_count == 0:
        raise HTTPException(404, "profile not found")
    return {"deleted": 1}


@api_router.post("/profiles/{profile_id}/run", response_model=ProfileRunResult)
async def run_profile(profile_id: str):
    prof_doc = await db.profiles.find_one({"id": profile_id}, {"_id": 0})
    if not prof_doc:
        raise HTTPException(404, "profile not found")
    prof = Profile(**prof_doc)
    logs: List[CommandLog] = []
    for cmd in prof.commands:
        logs.append(await execute_mock(cmd))
    return ProfileRunResult(profile_id=prof.id, profile_name=prof.name, logs=logs)


# ---------- Seed defaults ----------
DEFAULT_PROFILES = [
    {
        "name": "Country Lock: US",
        "description": "Force regulatory domain & wifi.country to US (user-supplied set).",
        "commands": [
            "svc wifi disable",
            "ifconfig wlan2 down",
            "setprop wifi.interface wlan2",
            "iw reg set US",
            "setprop wifi.country US",
            "cmd wifi force-country-code enabled US",
        ],
    },
    {
        "name": "Reset Regulatory",
        "description": "Disable forced country code and re-enable wifi.",
        "commands": [
            "cmd wifi force-country-code disabled",
            "iw reg set 00",
            "svc wifi enable",
        ],
    },
    {
        "name": "Diagnostics",
        "description": "Inspect current wifi state, regulatory domain & properties.",
        "commands": [
            "id",
            "getprop wifi.interface",
            "getprop wifi.country",
            "iw reg get",
            "iwconfig",
            "cmd wifi status",
        ],
    },
    {
        "name": "🩺 Wifi Diag",
        "description": "Full wireless stack snapshot — regdomain, phys, interfaces, dmesg tail.",
        "commands": [
            "id",
            "iw reg get",
            "iw dev",
            "iw phy",
            "ifconfig -a",
            "iwconfig",
            "getprop wifi.interface",
            "getprop wifi.country",
            "cmd wifi status",
            "dmesg | tail -30",
        ],
    },
    {
        "name": "🛑 PANIC",
        "description": "Emergency stop — kill kali, reset regulatory enforcement, bring down monitor ifaces, re-enable Android wifi.",
        "commands": [
            "killkali",
            "cmd wifi force-country-code disabled",
            "iw reg set 00",
            "ifconfig wlan2 down",
            "ifconfig wlan3 down",
            "ifconfig wlan4 down",
            "svc wifi enable",
        ],
    },
]


@app.on_event("startup")
async def seed():
    # Idempotent: only insert profiles whose names don't already exist
    existing_names = {d.get("name") async for d in db.profiles.find({}, {"name": 1, "_id": 0})}
    inserted = 0
    for p in DEFAULT_PROFILES:
        if p["name"] not in existing_names:
            await db.profiles.insert_one(Profile(**p).dict())
            inserted += 1
    if inserted:
        logger.info("Seeded %d new default profiles", inserted)
    # AI launcher profiles — Hermes + the rest of the agent zoo
    await _seed_ai_profiles_if_empty()
    # Attack profiles for the Live tab cockpit (replaces hardcoded JS PRESETS)
    await _seed_attack_profiles_if_empty()


# ---------- Settings (key/value app preferences) ----------
class Settings(BaseModel):
    exec_mode: str = "mock"                       # "mock" | "real" | "kali" — persisted across restarts
    iface_a: str = "wlan2"
    iface_b: str = ""
    iface_c: str = ""
    country: str = "US"
    active_iface: str = "A"          # "A" | "B" | "C" | "ALL"
    # Default works for OffSec NetHunter on Android 11+ where data isolation hides /data/data/com.offsec.nethunter
    # from foreign app contexts. We invoke busybox_nh + chroot directly via /data_mirror (the Magisk root-visible namespace).
    chroot_path: str = "/data_mirror/data_ce/null/0/com.offsec.nethunter/scripts/bin/busybox_nh chroot /data/local/nhsystem/kalifs /usr/bin/sudo -E PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


@api_router.get("/settings", response_model=Settings)
async def get_settings():
    doc = await db.settings.find_one({"_id": "app"}, {"_id": 0})
    return Settings(**(doc or {}))


@api_router.put("/settings", response_model=Settings)
async def put_settings(s: Settings):
    # Also $unset any legacy default_exec_mode key that may still be lingering
    # in the stored doc from a prior schema. Without this, a future migration
    # back to a stricter model would choke on it.
    await db.settings.update_one(
        {"_id": "app"},
        {"$set": s.dict(), "$unset": {"default_exec_mode": ""}},
        upsert=True,
    )
    return s


# ============================================================
# Live Sessions — streaming output ring buffer
# ============================================================
# In-memory store. The native streaming runs on-device; the app PUSHes line
# batches to /api/sessions/{id}/append every ~1-2s so the MCP server (and
# remote dashboards) can poll a tail. On session end, we persist a summary
# (last N lines + meta) to MongoDB for post-mortem audit.

RING_SIZE = 2000           # max lines kept per active session
SUMMARY_TAIL = 500         # how many trailing lines are persisted on end


class SessionLine(BaseModel):
    stream: str = "stdout"     # "stdout" | "stderr"
    line: str
    line_no: int = 0
    ts: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class LiveSession(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    command: str
    iface: str = ""
    label: str = ""             # human-friendly tag e.g. "airodump-wlan2"
    started_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    ended_at: Optional[str] = None
    pid: Optional[int] = None
    exit_code: Optional[int] = None
    duration_ms: Optional[int] = None
    line_count: int = 0
    status: str = "running"     # "running" | "ended" | "killed" | "error"
    mocked: bool = False


class SessionStartRequest(BaseModel):
    id: Optional[str] = None
    command: str
    iface: str = ""
    label: str = ""
    pid: Optional[int] = None
    mocked: bool = False


class SessionAppendRequest(BaseModel):
    lines: List[SessionLine]


class SessionEndRequest(BaseModel):
    exit_code: int = 0
    duration_ms: int = 0
    status: str = "ended"   # "ended" | "killed" | "error"


# Per-session in-memory state: {meta: LiveSession, buffer: deque[SessionLine], counter: int}
LIVE_SESSIONS: Dict[str, dict] = {}


def _get_session_or_404(sid: str) -> dict:
    s = LIVE_SESSIONS.get(sid)
    if not s:
        raise HTTPException(404, f"live session {sid} not found")
    return s


@api_router.post("/sessions/start", response_model=LiveSession)
async def session_start(req: SessionStartRequest):
    sess = LiveSession(
        id=req.id or str(uuid.uuid4()),
        command=req.command,
        iface=req.iface,
        label=req.label or req.command.split()[0] if req.command.strip() else "session",
        pid=req.pid,
        mocked=req.mocked,
    )
    LIVE_SESSIONS[sess.id] = {
        "meta": sess.dict(),
        "buffer": deque(maxlen=RING_SIZE),
        "counter": 0,
    }
    return sess


@api_router.post("/sessions/{sid}/append")
async def session_append(sid: str, req: SessionAppendRequest):
    s = _get_session_or_404(sid)
    buf: Deque = s["buffer"]
    added = 0
    for ln in req.lines:
        s["counter"] += 1
        rec = ln.dict()
        rec["line_no"] = ln.line_no or s["counter"]
        buf.append(rec)
        added += 1
    s["meta"]["line_count"] = s["counter"]
    return {"appended": added, "total": s["counter"]}


@api_router.get("/sessions/{sid}/tail")
async def session_tail(sid: str, since: int = 0, max_lines: int = 500):
    s = _get_session_or_404(sid)
    buf: Deque = s["buffer"]
    lines = [r for r in buf if r["line_no"] > since][-max_lines:]
    return {
        "id": sid,
        "status": s["meta"]["status"],
        "line_count": s["counter"],
        "cursor": lines[-1]["line_no"] if lines else since,
        "lines": lines,
    }


@api_router.post("/sessions/{sid}/end", response_model=LiveSession)
async def session_end(sid: str, req: SessionEndRequest):
    s = _get_session_or_404(sid)
    meta = s["meta"]
    meta["ended_at"] = datetime.now(timezone.utc).isoformat()
    meta["exit_code"] = req.exit_code
    meta["duration_ms"] = req.duration_ms
    meta["status"] = req.status
    # Persist summary to Mongo (truncated tail for audit)
    tail = list(s["buffer"])[-SUMMARY_TAIL:]
    summary = {**meta, "tail": tail}
    try:
        await db.session_summaries.insert_one(summary)
    except Exception as e:
        logger.warning("failed to persist session summary %s: %s", sid, e)
    return LiveSession(**meta)


@api_router.delete("/sessions/{sid}")
async def session_delete(sid: str):
    """Remove from in-memory store. The Mongo summary (if any) is preserved."""
    if sid in LIVE_SESSIONS:
        del LIVE_SESSIONS[sid]
        return {"deleted": 1}
    return {"deleted": 0}


@api_router.get("/sessions")
async def sessions_list(include_ended: bool = False):
    out = []
    for sid, s in LIVE_SESSIONS.items():
        if not include_ended and s["meta"]["status"] != "running":
            continue
        out.append(s["meta"])
    return out


@api_router.get("/sessions/history")
async def sessions_history(limit: int = 50):
    """Persisted summaries from MongoDB (ended sessions)."""
    docs = await db.session_summaries.find(
        {}, {"_id": 0}
    ).sort("ended_at", -1).to_list(min(max(limit, 1), 500))
    return docs


# ──────────────────────────────────────────────────────────────────────────────
#  AI tab — agent launcher profiles + conversation log
# ──────────────────────────────────────────────────────────────────────────────
# Separate from regular wifi command profiles because the semantics are
# different: AI profiles wrap interactive CLI agents (hermes, CAI-Framework,
# HEAVEN, Pentagi, …) with optional pty wrapping, optional system-prompt seed
# line, and a distinct conversation log so chat history doesn't pollute the
# wifi command terminal scrollback.

WRAP_MODES = {"none", "pty", "unbuffered"}
# How the AI tab should render the session's stdout:
#   - "xterm":      true TUI emulator (xterm.js in a WebView) — honors ANSI
#                   escape codes, cursor positioning, Rich/Textual widgets,
#                   readline editing, the works. Default for new profiles.
#   - "scrollback": flat line-by-line FlatList with ANSI codes stripped —
#                   simpler, lighter, good for non-TUI agents.
VIEW_MODES = {"xterm", "scrollback"}


class AIProfile(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    command: str                   # the launcher, e.g. "hermes"
    description: str = ""
    wrap_mode: str = "none"        # "none" | "pty" | "unbuffered"
    send_newline: bool = True      # append \n to each stdin send
    send_initial: Optional[str] = None  # optional first line auto-sent after launch
    # Optional shell snippet run BEFORE the main command (inside the same
    # login shell). Use to source env files, activate venvs, cd into a working
    # dir, etc. Joined to `command` via `&&` so a non-zero pre-exit aborts.
    # Example: "source /root/.hermes/.env && cd /root/.hermes"
    pre_command: Optional[str] = None
    icon: str = "🤖"
    # Rendering mode for the agent's stdout in the AI tab (see VIEW_MODES).
    # Defaults to "xterm" so Hermes/CAI/etc. TUIs render correctly out of
    # the box; users can switch a profile back to "scrollback" if they want
    # the older flat log view.
    view_mode: str = "xterm"
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class AIProfileCreate(BaseModel):
    name: str
    command: str
    description: str = ""
    wrap_mode: str = "none"
    send_newline: bool = True
    send_initial: Optional[str] = None
    pre_command: Optional[str] = None
    icon: str = "🤖"
    view_mode: str = "xterm"


class AIProfileUpdate(BaseModel):
    name: Optional[str] = None
    command: Optional[str] = None
    description: Optional[str] = None
    wrap_mode: Optional[str] = None
    send_newline: Optional[bool] = None
    send_initial: Optional[str] = None
    pre_command: Optional[str] = None
    icon: Optional[str] = None
    view_mode: Optional[str] = None


class AILogEntry(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    profile_id: Optional[str] = None
    profile_name: str = ""
    session_id: Optional[str] = None
    kind: str = "user"             # "user" | "system" | "agent"
    content: str = ""
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class AILogCreate(BaseModel):
    profile_id: Optional[str] = None
    profile_name: str = ""
    session_id: Optional[str] = None
    kind: str = "user"
    content: str = ""


AI_LOG_MAX = 500


async def _prune_ai_logs():
    count = await db.ai_logs.count_documents({})
    if count <= AI_LOG_MAX:
        return
    cursor = db.ai_logs.find({}, {"timestamp": 1, "_id": 0}).sort("timestamp", -1).skip(AI_LOG_MAX).limit(1)
    cutoff_doc = await cursor.to_list(1)
    if cutoff_doc:
        cutoff = cutoff_doc[0]["timestamp"]
        await db.ai_logs.delete_many({"timestamp": {"$lte": cutoff}})


@api_router.get("/ai-profiles", response_model=List[AIProfile])
async def get_ai_profiles():
    docs = await db.ai_profiles.find({}, {"_id": 0}).sort("created_at", 1).to_list(500)
    return [AIProfile(**d) for d in docs]


@api_router.post("/ai-profiles", response_model=AIProfile)
async def create_ai_profile(p: AIProfileCreate):
    if p.wrap_mode not in WRAP_MODES:
        raise HTTPException(status_code=400, detail=f"wrap_mode must be one of {sorted(WRAP_MODES)}")
    if p.view_mode not in VIEW_MODES:
        raise HTTPException(status_code=400, detail=f"view_mode must be one of {sorted(VIEW_MODES)}")
    if not p.name.strip() or not p.command.strip():
        raise HTTPException(status_code=400, detail="name and command are required")
    prof = AIProfile(**p.dict())
    await db.ai_profiles.insert_one(prof.dict())
    return prof


@api_router.put("/ai-profiles/{profile_id}", response_model=AIProfile)
async def update_ai_profile(profile_id: str, p: AIProfileUpdate):
    existing = await db.ai_profiles.find_one({"id": profile_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="profile not found")
    patch = {k: v for k, v in p.dict().items() if v is not None}
    if "wrap_mode" in patch and patch["wrap_mode"] not in WRAP_MODES:
        raise HTTPException(status_code=400, detail=f"wrap_mode must be one of {sorted(WRAP_MODES)}")
    if "view_mode" in patch and patch["view_mode"] not in VIEW_MODES:
        raise HTTPException(status_code=400, detail=f"view_mode must be one of {sorted(VIEW_MODES)}")
    if patch:
        await db.ai_profiles.update_one({"id": profile_id}, {"$set": patch})
    merged = {**existing, **patch}
    return AIProfile(**merged)


@api_router.delete("/ai-profiles/{profile_id}")
async def delete_ai_profile(profile_id: str):
    res = await db.ai_profiles.delete_one({"id": profile_id})
    return {"deleted": res.deleted_count == 1}


@api_router.get("/ai-logs", response_model=List[AILogEntry])
async def get_ai_logs(limit: int = 200, session_id: Optional[str] = None, profile_id: Optional[str] = None):
    q: dict = {}
    if session_id:
        q["session_id"] = session_id
    if profile_id:
        q["profile_id"] = profile_id
    docs = await db.ai_logs.find(q, {"_id": 0}).sort("timestamp", -1).to_list(min(max(limit, 1), 1000))
    docs.reverse()  # oldest-first for UI
    return [AILogEntry(**d) for d in docs]


@api_router.post("/ai-logs", response_model=AILogEntry)
async def create_ai_log(e: AILogCreate):
    entry = AILogEntry(**e.dict())
    await db.ai_logs.insert_one(entry.dict())
    await _prune_ai_logs()
    return entry


@api_router.delete("/ai-logs")
async def clear_ai_logs(session_id: Optional[str] = None, profile_id: Optional[str] = None):
    q: dict = {}
    if session_id:
        q["session_id"] = session_id
    if profile_id:
        q["profile_id"] = profile_id
    res = await db.ai_logs.delete_many(q)
    return {"deleted": res.deleted_count}


async def _seed_ai_profiles_if_empty():
    """One-shot seed of canonical AI profiles. Only runs if collection is empty
    so it never overwrites the user's tweaks."""
    count = await db.ai_profiles.count_documents({})
    if count > 0:
        return
    seeds = [
        AIProfile(
            name="Hermes",
            command="hermes",
            description="Nous Hermes agent (DeepSeek V4 Pro). Just type `hermes` in a Kali term.",
            wrap_mode="none",
            send_newline=True,
            send_initial=None,
            icon="🜲",
        ),
        AIProfile(
            name="CAI Framework",
            command="cai",
            description="CAI-Framework — Cybersecurity AI orchestrator.",
            wrap_mode="none",
            icon="🛡️",
        ),
        AIProfile(
            name="HEAVEN",
            command="heaven",
            description="HEAVEN Pentest Framework.",
            wrap_mode="none",
            icon="⛧",
        ),
        AIProfile(
            name="Pentagi",
            command="pentagi",
            description="Pentagi agent.",
            wrap_mode="none",
            icon="🜂",
        ),
        AIProfile(
            name="PentestAgent",
            command="pentestagent",
            description="PentestAgent.",
            wrap_mode="none",
            icon="🜃",
        ),
    ]
    for p in seeds:
        await db.ai_profiles.insert_one(p.dict())
    logger.info("seeded %d AI profiles", len(seeds))


# ============================================================================
# Attack Profiles + PCAP Endpoints (Live tab cockpit)
# ============================================================================
# Why a separate collection from `profiles` (the wifi enforcement ones)?
#   1. UX clarity — offensive ops shouldn't visually mix with "set country
#      to US" / "bring iface up" defensive setups.
#   2. Different lifecycle — attack profiles are launched as STREAMING
#      sessions (live tab), while wifi profiles run as one-shot batches.
#   3. Reserved space for future EUEF (Enforcer Unified Exploit Framework)
#      to share the same schema for its exploit launchers — `category` will
#      then expand to include "exploit-local" / "exploit-remote" / "post".
#
# `command_template` uses {iface}, {host}, {port}, {file} placeholders that
# the frontend substitutes at launch time based on the user's active iface
# + selected PCAP endpoint + auto-generated capture path.
# ============================================================================

# Categories surface in the UI as filter tabs. Order is important — the UI
# renders chips in this order so wifi recon sits before destructive attacks.
ATTACK_CATEGORIES = ["recon", "attack", "trace", "pcap"]
ATTACK_VIEW_MODES = {"xterm", "scrollback"}


class AttackProfile(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    description: str = ""
    icon: str = "rocket-launch"           # MaterialCommunityIcons name (NOT emoji)
    category: str = "recon"               # see ATTACK_CATEGORIES
    # Shell command with {iface}, {host}, {port}, {file} placeholders that
    # the FE substitutes at launch. Joined to the active wrap (chroot / pty)
    # by the existing sessionManager — we don't wrap here.
    command_template: str
    needs_iface: bool = True
    needs_endpoint: bool = False          # if True, FE forces an endpoint pick before launch
    needs_file: bool = False              # if True, FE generates a /sdcard/cap_<ts> path
    # Per-profile rendering — wifite/airodump need TUI, dmesg/iw don't.
    view_mode: str = "scrollback"
    # Built-in seed profiles are flagged so the UI hides the delete button.
    # User-created additions / clones default to false.
    builtin: bool = False
    sort_order: int = 0
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class AttackProfileCreate(BaseModel):
    name: str
    description: str = ""
    icon: str = "rocket-launch"
    category: str = "recon"
    command_template: str
    needs_iface: bool = True
    needs_endpoint: bool = False
    needs_file: bool = False
    view_mode: str = "scrollback"
    sort_order: int = 0


class AttackProfileUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    category: Optional[str] = None
    command_template: Optional[str] = None
    needs_iface: Optional[bool] = None
    needs_endpoint: Optional[bool] = None
    needs_file: Optional[bool] = None
    view_mode: Optional[str] = None
    sort_order: Optional[int] = None


class PcapEndpoint(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str                              # human label, e.g. "Wireshark LAN"
    host: str                              # IP or hostname
    port: int                              # default 19000 for PCAP-over-IP convention
    transport: str = "tcp"                 # "tcp" | "udp" — tcp for nc-based stream
    notes: str = ""
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class PcapEndpointCreate(BaseModel):
    name: str
    host: str
    port: int = 19000
    transport: str = "tcp"
    notes: str = ""


class PcapEndpointUpdate(BaseModel):
    name: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    transport: Optional[str] = None
    notes: Optional[str] = None


# ---------- Attack profile endpoints ----------
@api_router.get("/attack-profiles", response_model=List[AttackProfile])
async def list_attack_profiles():
    cur = db.attack_profiles.find({}, {"_id": 0}).sort([("sort_order", 1), ("name", 1)])
    return [AttackProfile(**doc) async for doc in cur]


@api_router.post("/attack-profiles", response_model=AttackProfile)
async def create_attack_profile(p: AttackProfileCreate):
    if p.category not in ATTACK_CATEGORIES:
        raise HTTPException(400, f"category must be one of {ATTACK_CATEGORIES}")
    if p.view_mode not in ATTACK_VIEW_MODES:
        raise HTTPException(400, f"view_mode must be one of {sorted(ATTACK_VIEW_MODES)}")
    if not p.name.strip() or not p.command_template.strip():
        raise HTTPException(400, "name and command_template are required")
    prof = AttackProfile(**p.dict(), builtin=False)
    await db.attack_profiles.insert_one(prof.dict())
    return prof


@api_router.put("/attack-profiles/{pid}", response_model=AttackProfile)
async def update_attack_profile(pid: str, p: AttackProfileUpdate):
    existing = await db.attack_profiles.find_one({"id": pid}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "profile not found")
    patch = {k: v for k, v in p.dict().items() if v is not None}
    if "category" in patch and patch["category"] not in ATTACK_CATEGORIES:
        raise HTTPException(400, f"category must be one of {ATTACK_CATEGORIES}")
    if "view_mode" in patch and patch["view_mode"] not in ATTACK_VIEW_MODES:
        raise HTTPException(400, f"view_mode must be one of {sorted(ATTACK_VIEW_MODES)}")
    if patch:
        await db.attack_profiles.update_one({"id": pid}, {"$set": patch})
    merged = {**existing, **patch}
    return AttackProfile(**merged)


@api_router.delete("/attack-profiles/{pid}")
async def delete_attack_profile(pid: str):
    # Built-in profiles can be deleted too — the user is operator-level and
    # should be trusted; the seed will re-add them on next empty boot if
    # they want them back via "reset attack profiles" (TODO).
    res = await db.attack_profiles.delete_one({"id": pid})
    return {"deleted": res.deleted_count}


# ---------- PCAP endpoint CRUD ----------
@api_router.get("/pcap-endpoints", response_model=List[PcapEndpoint])
async def list_pcap_endpoints():
    cur = db.pcap_endpoints.find({}, {"_id": 0}).sort("created_at", 1)
    return [PcapEndpoint(**doc) async for doc in cur]


@api_router.post("/pcap-endpoints", response_model=PcapEndpoint)
async def create_pcap_endpoint(e: PcapEndpointCreate):
    if not e.name.strip() or not e.host.strip():
        raise HTTPException(400, "name and host are required")
    if not (1 <= e.port <= 65535):
        raise HTTPException(400, "port must be 1..65535")
    if e.transport not in ("tcp", "udp"):
        raise HTTPException(400, "transport must be tcp or udp")
    ep = PcapEndpoint(**e.dict())
    await db.pcap_endpoints.insert_one(ep.dict())
    return ep


@api_router.put("/pcap-endpoints/{eid}", response_model=PcapEndpoint)
async def update_pcap_endpoint(eid: str, e: PcapEndpointUpdate):
    existing = await db.pcap_endpoints.find_one({"id": eid}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "endpoint not found")
    patch = {k: v for k, v in e.dict().items() if v is not None}
    if "port" in patch and not (1 <= patch["port"] <= 65535):
        raise HTTPException(400, "port must be 1..65535")
    if "transport" in patch and patch["transport"] not in ("tcp", "udp"):
        raise HTTPException(400, "transport must be tcp or udp")
    if patch:
        await db.pcap_endpoints.update_one({"id": eid}, {"$set": patch})
    merged = {**existing, **patch}
    return PcapEndpoint(**merged)


@api_router.delete("/pcap-endpoints/{eid}")
async def delete_pcap_endpoint(eid: str):
    res = await db.pcap_endpoints.delete_one({"id": eid})
    return {"deleted": res.deleted_count}


# ---------- Attack profile seeding ----------
async def _seed_attack_profiles_if_empty():
    """
    Re-seeds the canonical wifi recon + attack starter set into the
    attack_profiles collection if (and only if) it's empty. These mirror the
    presets that used to live in LiveTab.tsx as hardcoded JS — moving them to
    Mongo means the user (and Hermes via MCP later) can add/edit/clone them.

    Each command_template uses {iface} / {host} / {port} / {file} for
    runtime substitution. wifite/airodump get view_mode=xterm because they
    emit Rich/curses TUIs that need xterm.js to render correctly; tcpdump
    et al stay on scrollback since they're plain line-oriented output.
    """
    if await db.attack_profiles.count_documents({}) > 0:
        return
    seeds = [
        AttackProfile(
            name="airodump-ng",
            description="live AP/STA scan — TUI table with signal strength, BSSIDs, channels",
            icon="wifi-strength-4-alert",
            category="recon",
            command_template="airodump-ng {iface}",
            needs_iface=True,
            view_mode="xterm",
            builtin=True, sort_order=10,
        ),
        AttackProfile(
            name="airodump → CSV",
            description="capture to /sdcard/cap_<ts>.{csv,pcap} for offline analysis",
            icon="file-table",
            category="recon",
            command_template="airodump-ng -w {file} --output-format csv,pcap {iface}",
            needs_iface=True, needs_file=True,
            view_mode="scrollback",
            builtin=True, sort_order=11,
        ),
        AttackProfile(
            name="wifite PMKID",
            description="PMKID hash grab (no clients harmed) — kills NetworkManager first",
            icon="key-variant",
            category="attack",
            command_template="wifite --pmkid --no-deauths --kill -i {iface}",
            needs_iface=True,
            view_mode="xterm",
            builtin=True, sort_order=20,
        ),
        AttackProfile(
            name="wifite WPA",
            description="full WPA handshake capture + auto-crack flow",
            icon="shield-key",
            category="attack",
            command_template="wifite --wpa --kill -i {iface}",
            needs_iface=True,
            view_mode="xterm",
            builtin=True, sort_order=21,
        ),
        AttackProfile(
            name="hcxdumptool",
            description="PMKID + EAPOL capture (modern, faster than aircrack tools)",
            icon="database-export",
            category="attack",
            command_template="hcxdumptool -i {iface} -o {file}.pcapng --enable_status=1",
            needs_iface=True, needs_file=True,
            view_mode="scrollback",
            builtin=True, sort_order=22,
        ),
        AttackProfile(
            name="tcpdump → file",
            description="full packet capture to local /sdcard/tcpdump_<ts>.pcap",
            icon="content-save",
            category="trace",
            command_template="tcpdump -i {iface} -w {file}.pcap -U",
            needs_iface=True, needs_file=True,
            view_mode="scrollback",
            builtin=True, sort_order=30,
        ),
        AttackProfile(
            name="PCAP → remote",
            description="stream live packets to a remote Wireshark/NetworkMiner via nc",
            icon="cloud-upload",
            category="pcap",
            # `-U` flushes per packet (no buffering), -w - writes pcap to stdout.
            # `nc -w 3` keeps the netcat from hanging on close. The remote side
            # should be running e.g. `nc -l -p 19000 | wireshark -k -i -`
            # (or just point Wireshark's "Capture from pipe" at the same port
            # via socat/inetd).
            command_template="tcpdump -i {iface} -U -w - | nc -w 3 {host} {port}",
            needs_iface=True, needs_endpoint=True,
            view_mode="scrollback",
            builtin=True, sort_order=40,
        ),
        AttackProfile(
            name="iw event",
            description="kernel wireless events — assoc/disassoc/auth/scan",
            icon="console-network",
            category="trace",
            command_template="iw event -t",
            needs_iface=False,
            view_mode="scrollback",
            builtin=True, sort_order=50,
        ),
        AttackProfile(
            name="dmesg -w",
            description="follow kernel log — driver errors, firmware msgs",
            icon="console-line",
            category="trace",
            command_template="dmesg -w",
            needs_iface=False,
            view_mode="scrollback",
            builtin=True, sort_order=51,
        ),
    ]
    for p in seeds:
        await db.attack_profiles.insert_one(p.dict())
    logger.info("seeded %d attack profiles", len(seeds))


# Wire the new seeder into startup. We call it explicitly from the existing
# `seed()` startup handler — see the @app.on_event("startup") block above
# where we patched in `await _seed_attack_profiles_if_empty()`.


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
