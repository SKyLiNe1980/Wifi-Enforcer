"""Phase 1C smoke test — exercises SessionManager end-to-end with real PTYs.

Runs the manager outside the FastAPI/MCP machinery to keep the failure
surface tiny. If this passes, the chroot deploy is overwhelmingly likely
to behave because the manager itself is platform-agnostic Linux.

Run: python3 /app/enforcer-mcp/tests/test_sessions.py
"""
from __future__ import annotations

import asyncio
import os
import sys

# Make `handlers` importable when running this file directly.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from handlers.sessions import init_session_manager  # noqa: E402


def _log(level, msg, **fields):
    print(f"[{level}] {msg} {fields}")


async def _wait_until(predicate, timeout=5.0, interval=0.05):
    """Tiny poll helper — PTY drain is async so we wait for the buffer."""
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(interval)
    return False


async def test_one_shot_echo() -> None:
    """`echo hello` should run, exit 0, and leave 'hello' in the ring."""
    mgr = init_session_manager(logger=_log)
    sess = await mgr.start("echo hello-pty-1c", label="echo-test")
    assert sess.running, "session should be running immediately after start"

    # Process should exit on its own; wait for buffer to have data + exit_code.
    ok = await _wait_until(
        lambda: sess.exit_code is not None and len(sess.ring) > 0,
        timeout=3.0,
    )
    assert ok, f"echo didn't finish in time. buf={bytes(sess.ring)!r} rc={sess.exit_code}"

    out = await mgr.read(sess.id, tail_bytes=4096)
    assert "hello-pty-1c" in out["bytes"], f"unexpected output: {out!r}"
    assert out["exit_code"] == 0, f"non-zero exit: {out!r}"
    assert not out["running"], "session should be marked exited"
    print("✓ test_one_shot_echo")


async def test_interactive_cat() -> None:
    """`cat` is the canonical PTY check — writes echo back as a tty."""
    mgr = init_session_manager(logger=_log)
    sess = await mgr.start("cat", label="cat-loop")

    await mgr.write(sess.id, "ping-1", newline=True)
    await _wait_until(lambda: b"ping-1" in sess.ring, timeout=2.0)

    await mgr.write(sess.id, "ping-2", newline=True)
    await _wait_until(lambda: b"ping-2" in sess.ring, timeout=2.0)

    out = await mgr.read(sess.id, tail_bytes=4096)
    assert "ping-1" in out["bytes"] and "ping-2" in out["bytes"], \
        f"PTY echo failed: {out!r}"
    assert out["running"], "cat should still be running"

    stop = await mgr.stop(sess.id, sig_name="SIGTERM")
    assert not stop["running"], f"cat didn't stop: {stop!r}"
    print("✓ test_interactive_cat")


async def test_list_and_resize() -> None:
    mgr = init_session_manager(logger=_log)
    s1 = await mgr.start("sleep 30", label="sleeper-a")
    s2 = await mgr.start("sleep 30", label="sleeper-b", cols=80, rows=24)

    listing = await mgr.list_all()
    ids = {s["session_id"] for s in listing}
    assert s1.id in ids and s2.id in ids, f"missing sessions: {ids}"
    labels = {s["label"] for s in listing}
    assert "sleeper-a" in labels and "sleeper-b" in labels

    # Resize should succeed without raising.
    resized = await mgr.resize(s2.id, cols=200, rows=50)
    assert resized["cols"] == 200 and resized["rows"] == 50

    await mgr.stop(s1.id)
    await mgr.stop(s2.id)
    print("✓ test_list_and_resize")


async def test_ring_overflow() -> None:
    """Ring buffer should cap at ring_cap, not grow unbounded."""
    mgr = init_session_manager(ring_cap=2048, logger=_log)  # tiny cap
    # `yes` floods stdout — we want to confirm we trim, not eat all of it.
    sess = await mgr.start("yes hello", label="flood")

    # Let the loop drain for a bit
    await asyncio.sleep(0.5)

    assert len(sess.ring) <= 2048, f"ring overflowed: {len(sess.ring)}"
    assert sess.bytes_total > 2048, \
        f"cumulative counter should exceed cap: {sess.bytes_total}"

    await mgr.stop(sess.id, sig_name="SIGKILL")
    print(f"✓ test_ring_overflow (ring={len(sess.ring)}, total={sess.bytes_total})")


async def test_unknown_session_id() -> None:
    mgr = init_session_manager(logger=_log)
    try:
        await mgr.read("definitely-not-a-real-id", tail_bytes=10)
    except KeyError as e:
        assert "unknown session_id" in str(e)
        print("✓ test_unknown_session_id")
        return
    raise AssertionError("expected KeyError for unknown session")


async def test_cursor_mode() -> None:
    """1D-B: incremental cursor read should return only new bytes per poll."""
    mgr = init_session_manager(logger=_log)
    sess = await mgr.start("cat", label="cursor-test")
    await asyncio.sleep(0.1)

    # First write — should appear in next_cursor delta
    await mgr.write(sess.id, "alpha", newline=True)
    await _wait_until(lambda: b"alpha" in sess.ring, timeout=2.0)

    r1 = await mgr.read(sess.id, since_byte=0)
    assert "alpha" in r1["bytes"], f"first read missed alpha: {r1!r}"
    assert r1["next_cursor"] == sess.bytes_total, f"cursor mismatch: {r1!r}"
    assert not r1["truncated"], f"shouldn't be truncated: {r1!r}"
    cursor = r1["next_cursor"]

    # Second write — cursor mode should return ONLY the new bytes
    await mgr.write(sess.id, "bravo", newline=True)
    await _wait_until(lambda: b"bravo" in sess.ring, timeout=2.0)

    r2 = await mgr.read(sess.id, since_byte=cursor)
    assert "bravo" in r2["bytes"], f"second read missed bravo: {r2!r}"
    assert "alpha" not in r2["bytes"], \
        f"cursor mode leaked old data: {r2!r}"
    assert r2["next_cursor"] > cursor

    # Third poll with same cursor — caught up, empty payload
    r3 = await mgr.read(sess.id, since_byte=r2["next_cursor"])
    assert r3["bytes"] == "", f"caught-up read should be empty: {r3!r}"
    assert r3["next_cursor"] == r2["next_cursor"]
    assert r3["len"] == 0

    await mgr.stop(sess.id)
    print("✓ test_cursor_mode")


async def test_cursor_truncation() -> None:
    """1D-B: caller falling behind the ring should get truncated=True."""
    # Tiny ring so we can overflow easily
    mgr = init_session_manager(ring_cap=512, logger=_log)
    sess = await mgr.start("yes overflow-test", label="trunc-test")

    # Wait long enough for `yes` to flood past the ring cap many times
    await asyncio.sleep(0.5)
    await mgr.stop(sess.id, sig_name="SIGKILL")

    # Pass since_byte=0 — bytes 0..(bytes_total-512) have all been GC'd,
    # so we should get the trailing 512 bytes back with truncated=True.
    r = await mgr.read(sess.id, since_byte=0)
    assert r["truncated"], f"expected truncated=True, got: {r!r}"
    assert r["len"] > 0 and r["len"] <= 512, \
        f"snapshot should fit ring cap: len={r['len']}"
    assert "overflow-test" in r["bytes"]
    print(f"✓ test_cursor_truncation (truncated={r['truncated']}, len={r['len']})")


async def main() -> None:
    await test_one_shot_echo()
    await test_interactive_cat()
    await test_list_and_resize()
    await test_ring_overflow()
    await test_unknown_session_id()
    await test_cursor_mode()
    await test_cursor_truncation()
    print("\nAll Phase 1C+1D-B session tests passed ✓")


if __name__ == "__main__":
    asyncio.run(main())
