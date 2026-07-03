#!/usr/bin/env bash
# enforcer-cloud-common.sh — shared helpers for the enforcer-cloud-*
# subcommand scripts. Not directly executable; source'd via `.` from
# each script.
#
# Redis key layout (all under enforcer:mcp:deb:*):
#
#   enforcer:mcp:deb:signal                 → "<version>" — cheap poll target
#   enforcer:mcp:deb:latest                 → JSON meta {version, sha256, size, uploaded_at, changelog, filename}
#   enforcer:mcp:deb:previous               → JSON meta (same shape) for rollback
#   enforcer:mcp:deb:blob:<version>         → base64 of the .deb bytes
#
# Design notes:
#   • `signal` is separate from `latest` so nodes can poll a 5-byte string
#     instead of the ~200-byte meta blob. Free-tier bandwidth is 50GB/mo
#     but that's shared with the cockpit's own health probes.
#   • blob key is versioned (not just "blob") so rollback doesn't need
#     to re-upload — the previous version's bytes are still there.
#   • meta carries sha256 so pull-side can verify integrity without
#     trusting Upstash. This is not just paranoia: our tokens transit
#     the tailnet and can be sniffed on a compromised exit node.
#

set -euo pipefail

# ─── Auto-source credentials from the first file we can find ─────────
# Order matters: /etc first (deployed), then user, then repo-local dev.
# Later files override earlier ones so an operator can add ad-hoc
# overrides in ~/.enforcer-cloud.env without editing /etc.
for candidate in \
    "/etc/enforcer-mcp/cloud.env" \
    "$HOME/.enforcer-cloud.env" \
    "$(dirname "${BASH_SOURCE[0]}")/../.enforcer-cloud.env"
do
    if [[ -r "$candidate" ]]; then
        # shellcheck disable=SC1090
        . "$candidate"
    fi
done

# ─── Dependency check ───────────────────────────────────────────────
# We rely on curl + jq + base64 + sha256sum. All four are in `coreutils`
# / `curl` / `jq` on Kali, Debian, Ubuntu, and NetHunter. If jq is
# missing we bail loudly rather than fall through to fragile sed parsing.
for bin in curl jq base64 sha256sum; do
    if ! command -v "$bin" >/dev/null 2>&1; then
        echo "[cloud] missing required binary: $bin" >&2
        echo "        apt install -y jq curl coreutils" >&2
        exit 127
    fi
done

# ─── Load creds — CLI args override env override sourced files ──────
cloud_parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --url)        ENFORCER_CLOUD_URL="$2"; shift 2 ;;
            --token)      ENFORCER_CLOUD_TOKEN="$2"; shift 2 ;;
            --deb)        ENFORCER_CLOUD_DEB="$2"; shift 2 ;;
            --changelog)  ENFORCER_CLOUD_CHANGELOG="$2"; shift 2 ;;
            --force)      ENFORCER_CLOUD_FORCE=1; shift ;;
            --dry-run)    ENFORCER_CLOUD_DRY_RUN=1; shift ;;
            --quiet|-q)   ENFORCER_CLOUD_QUIET=1; shift ;;
            -h|--help)    ENFORCER_CLOUD_HELP=1; shift ;;
            *)            ENFORCER_CLOUD_POSITIONAL+=("$1"); shift ;;
        esac
    done
}
ENFORCER_CLOUD_POSITIONAL=()

# ─── Assert we have creds ───────────────────────────────────────────
cloud_require_creds() {
    if [[ -z "${ENFORCER_CLOUD_URL:-}" || -z "${ENFORCER_CLOUD_TOKEN:-}" ]]; then
        cat >&2 <<EOF
[cloud] missing Upstash creds.

Set them one of these ways (in override order):
  1. --url <URL> --token <TOKEN> on the command line
  2. Env vars ENFORCER_CLOUD_URL / ENFORCER_CLOUD_TOKEN
  3. Config file at one of:
        /etc/enforcer-mcp/cloud.env
        ~/.enforcer-cloud.env

Example template:
$(dirname "${BASH_SOURCE[0]}")/enforcer-cloud.env.example
EOF
        exit 2
    fi
    # Strip any trailing slash — Upstash rejects the double slash.
    ENFORCER_CLOUD_URL="${ENFORCER_CLOUD_URL%/}"
}

# ─── Low-level Upstash REST wrappers ────────────────────────────────
# Upstash's REST API accepts JSON-encoded Redis command arrays:
#
#   POST /            body: ["GET", "key"]              → {"result": "..."}
#   POST /pipeline    body: [["SET",...],["GET",...]]   → [{result},{result}]
#
# Both return application/json. Errors surface as {"error": "msg"} or
# per-item {"error": "msg"} inside pipeline responses.
#
# We use --fail-with-body to make curl exit non-zero on 4xx/5xx while
# still letting us read the JSON body (curl 7.76+).

# cloud_cmd <cmd> [<arg>...]  → prints raw JSON response
cloud_cmd() {
    local body
    body=$(jq -cn --args '$ARGS.positional' -- "$@")
    curl --fail-with-body -sS \
         -X POST "$ENFORCER_CLOUD_URL" \
         -H "Authorization: Bearer $ENFORCER_CLOUD_TOKEN" \
         -H "Content-Type: application/json" \
         -d "$body"
}

# cloud_pipeline <cmd1_json> <cmd2_json> ...  → each arg is a JSON array
# describing one Redis command. Emitted as `[[...],[...]]` to /pipeline.
cloud_pipeline() {
    local body
    body=$(printf '%s\n' "$@" | jq -cs .)
    curl --fail-with-body -sS \
         -X POST "$ENFORCER_CLOUD_URL/pipeline" \
         -H "Authorization: Bearer $ENFORCER_CLOUD_TOKEN" \
         -H "Content-Type: application/json" \
         -d "$body"
}

# cloud_get <key>  → prints value (or empty if nil). Bails on redis error.
cloud_get() {
    local resp
    resp=$(cloud_cmd GET "$1")
    if echo "$resp" | jq -e '.error' >/dev/null 2>&1; then
        echo "[cloud] GET $1 failed: $(echo "$resp" | jq -r .error)" >&2
        return 1
    fi
    echo "$resp" | jq -r '.result // empty'
}

# ─── Installed version helper (best-effort) ─────────────────────────
cloud_installed_version() {
    if command -v dpkg-query >/dev/null 2>&1; then
        dpkg-query -W -f='${Version}' enforcer-mcp 2>/dev/null || echo ""
    else
        echo ""
    fi
}

# ─── Semver-lite compare: 0.3.0 > 0.2.1 > 0.2.0 ─────────────────────
# Returns 0 if $1 > $2, 1 otherwise. dpkg --compare-versions is the
# gold standard when available (handles ~rc, +debN, etc.).
cloud_version_gt() {
    if command -v dpkg >/dev/null 2>&1; then
        dpkg --compare-versions "$1" gt "$2"
    else
        # Fallback: coreutils sort -V
        [[ "$1" != "$2" ]] && [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" == "$1" ]]
    fi
}

# ─── Pretty logging ─────────────────────────────────────────────────
cloud_log()  { [[ -z "${ENFORCER_CLOUD_QUIET:-}" ]] && printf '\e[36m[cloud]\e[0m %s\n' "$*" >&2 || true; }
cloud_ok()   { [[ -z "${ENFORCER_CLOUD_QUIET:-}" ]] && printf '\e[32m[cloud]\e[0m %s\n' "$*" >&2 || true; }
cloud_warn() {                                        printf '\e[33m[cloud]\e[0m %s\n' "$*" >&2; }
cloud_err()  {                                        printf '\e[31m[cloud]\e[0m %s\n' "$*" >&2; }
