from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import re
import asyncio
import random
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
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


async def execute_mock(command: str) -> CommandLog:
    started = datetime.now(timezone.utc)
    # simulate latency
    await asyncio.sleep(random.uniform(0.05, 0.25))
    out, code = _mock_output(command)
    dur = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
    log = CommandLog(command=command, output=out, exit_code=code, duration_ms=dur, mocked=True)
    await db.command_logs.insert_one(log.dict())
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
]


@app.on_event("startup")
async def seed():
    count = await db.profiles.count_documents({})
    if count == 0:
        for p in DEFAULT_PROFILES:
            await db.profiles.insert_one(Profile(**p).dict())
        logger.info("Seeded %d default profiles", len(DEFAULT_PROFILES))


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
