"""Internal tool handlers for the Enforcer MCP server.

Tools whose `command_template` is prefixed with `__internal:` dispatch here
instead of shelling out via subprocess. This keeps audit-read, profile-list,
and session-management operations in-process for speed + safety.

Phase 1C adds a real PTY-backed `SessionManager` (see sessions.py) that
backs the start/write/read/stop/list/resize session tools.
"""
from .internal import INTERNAL_HANDLERS
from .sessions import (
    SessionManager,
    init_session_manager,
    get_session_manager,
)

__all__ = [
    "INTERNAL_HANDLERS",
    "SessionManager",
    "init_session_manager",
    "get_session_manager",
]
