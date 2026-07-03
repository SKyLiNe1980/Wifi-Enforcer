#!/usr/bin/env python3
"""
GTFOBins MCP — Living-off-the-land binary exploit lookup.
No deps. Caches the 478-binary GTFOBins database locally.

MCP tools:
  gtfobins_functions()          → list all 12 function types
  gtfobins_lookup(binary)       → all functions for a specific binary
  gtfobins_triage(bins, goal)   → best matches for available bins + goal
  gtfobins_search(query)        → fuzzy search binary names
"""

import json
import os
import sys
import urllib.request
import ssl
from pathlib import Path

CACHE = Path(__file__).parent / "gtfobins_cache.json"
API_URL = "https://gtfobins.org/api.json"

# ── Cache management ──────────────────────────────────────────

def _load():
    """Load GTFOBins database from cache or fetch from API."""
    if CACHE.exists():
        with open(CACHE) as f:
            return json.load(f)
    
    ctx = ssl.create_default_context()
    req = urllib.request.Request(API_URL)
    resp = urllib.request.urlopen(req, context=ctx, timeout=30)
    data = json.loads(resp.read().decode())
    
    with open(CACHE, "w") as f:
        json.dump(data, f)
    return data

def _refresh():
    """Force refresh cache from API."""
    if CACHE.exists():
        CACHE.unlink()
    return _load()

# ── Query functions ───────────────────────────────────────────

def functions():
    """Return all 12 function types with descriptions."""
    db = _load()
    funcs = db.get("functions", {})
    return [
        {"name": name, "label": f["label"], "description": f["description"]}
        for name, f in sorted(funcs.items())
    ]

def lookup(binary):
    """Return all exploit functions for a specific binary."""
    db = _load()
    exes = db.get("executables", {})
    if binary not in exes:
        return {"error": f"'{binary}' not found in GTFOBins"}
    
    result = {"binary": binary, "functions": {}}
    for func_name, entries in exes[binary].get("functions", {}).items():
        result["functions"][func_name] = []
        for e in entries:
            result["functions"][func_name].append({
                "code": e.get("code", ""),
                "contexts": e.get("contexts", {}),
            })
    return result

def triage(available_bins, goal=None):
    """
    Given a list of available binaries, find the best post-exploitation path.
    
    Args:
        available_bins: list of binary names found on target (e.g. ['bash','perl','python'])
        goal: desired function — 'download', 'reverse-shell', 'shell', 'file-write', etc.
              If None, returns ALL functions achievable with available bins.
    
    Returns:
        List of matches sorted by complexity (shortest code first).
    """
    db = _load()
    exes = db.get("executables", {})
    available = set(available_bins)
    matches = []
    
    # If no specific goal, report what we CAN do
    goals = [goal] if goal else list(db.get("functions", {}).keys())
    
    for g in goals:
        for bname in sorted(available & set(exes.keys())):
            entries = exes[bname].get("functions", {}).get(g, [])
            for e in entries:
                matches.append({
                    "goal": g,
                    "binary": bname,
                    "code": e["code"],
                    "code_length": len(e["code"]),
                    "contexts": e.get("contexts", {}),
                })
    
    # Sort: specific goals first, then by code simplicity
    if goal:
        matches.sort(key=lambda m: m["code_length"])
    else:
        matches.sort(key=lambda m: (m["goal"], m["code_length"]))
    
    return matches

def search(query):
    """Fuzzy search binary names containing query."""
    db = _load()
    exes = db.get("executables", {})
    query = query.lower()
    return [b for b in exes if query in b.lower()]

# ── MCP Server (stdio) ────────────────────────────────────────

MCP_TOOLS = [
    {
        "name": "gtfobins_functions",
        "description": "List all GTFOBins function types (shell, download, reverse-shell, etc.) with descriptions.",
        "params": {}
    },
    {
        "name": "gtfobins_lookup",
        "description": "Get all exploit functions for a specific binary (e.g., 'bash', 'perl', 'python').",
        "params": {
            "binary": {"type": "string", "description": "Binary name to look up"}
        }
    },
    {
        "name": "gtfobins_triage",
        "description": "Given a list of available binaries on a compromised host, find the best GTFOBins techniques for a goal (download, reverse-shell, shell, file-write, etc.).",
        "params": {
            "bins": {"type": "array", "items": "string", "description": "List of binary names available on target"},
            "goal": {"type": "string", "description": "Desired function: download, reverse-shell, shell, file-write, upload, command, file-read, bind-shell, privilege-escalation, library-load, inherit"}
        }
    },
    {
        "name": "gtfobins_search",
        "description": "Search GTFOBins binary names containing a query string.",
        "params": {
            "query": {"type": "string", "description": "Substring to search in binary names"}
        }
    },
]

def handle_request(msg):
    """Handle one JSON-RPC request."""
    rid = msg.get("id", 0)
    method = msg.get("method", "")
    
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": rid, "result": {"tools": MCP_TOOLS}}
    
    if method == "tools/call":
        params = msg.get("params", {})
        name = params.get("name", "")
        args = params.get("arguments", {})
        
        try:
            if name == "gtfobins_functions":
                result = functions()
            elif name == "gtfobins_lookup":
                result = lookup(args["binary"])
            elif name == "gtfobins_triage":
                result = triage(args["bins"], args.get("goal"))
            elif name == "gtfobins_search":
                result = search(args["query"])
            else:
                result = {"error": f"Unknown tool: {name}"}
        except Exception as e:
            result = {"error": str(e)}
        
        return {
            "jsonrpc": "2.0",
            "id": rid,
            "result": {"content": [{"type": "text", "text": json.dumps(result, indent=2)}]}
        }
    
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"Unknown method: {method}"}}

def main():
    # Two operating modes:
    #   • stdio (default)  — JSON-RPC MCP server, one line in, one line out
    #   • --cli <verb>     — one-shot CLI invocation, prints JSON to stdout.
    #     This is what the enforcer-mcp YAML tool wrappers use; simpler
    #     than proxying stdio through fastmcp.
    if len(sys.argv) > 1 and sys.argv[1] == "--cli":
        verb = sys.argv[2] if len(sys.argv) > 2 else ""
        # Remaining args parsed as `--key value` pairs, comma-separated
        # values become lists.
        kv = {}
        i = 3
        while i < len(sys.argv) - 1:
            if sys.argv[i].startswith("--"):
                kv[sys.argv[i][2:]] = sys.argv[i + 1]
                i += 2
            else:
                i += 1
        try:
            if verb == "functions":
                out = functions()
            elif verb == "lookup":
                out = lookup(kv["binary"])
            elif verb == "triage":
                bins = [b.strip() for b in kv["bins"].split(",")]
                out = triage(bins, kv.get("goal"))
            elif verb == "search":
                out = search(kv["query"])
            elif verb == "refresh":
                _refresh()
                out = {"ok": True, "cached": len(_load()["executables"])}
            else:
                out = {"error": f"unknown verb: {verb}. "
                                "use: functions | lookup | triage | search | refresh"}
        except Exception as e:
            out = {"error": str(e)}
        print(json.dumps(out, indent=2))
        return

    # stdio MCP server mode.
    print("GTFOBins MCP: loading database...", file=sys.stderr)
    _load()
    print(f"GTFOBins MCP: ready ({len(_load()['executables'])} binaries)", file=sys.stderr)

    for line in sys.stdin:
        try:
            msg = json.loads(line.strip())
            resp = handle_request(msg)
            print(json.dumps(resp), flush=True)
        except json.JSONDecodeError:
            pass

if __name__ == "__main__":
    main()
