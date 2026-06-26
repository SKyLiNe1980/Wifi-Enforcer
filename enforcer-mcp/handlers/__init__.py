"""Internal tool handlers for the Enforcer MCP server.

Tools whose `command_template` is prefixed with `__internal:` dispatch here
instead of shelling out via subprocess. This keeps audit-read, profile-list,
and session-management operations in-process for speed + safety.
"""
from .internal import INTERNAL_HANDLERS

__all__ = ["INTERNAL_HANDLERS"]
