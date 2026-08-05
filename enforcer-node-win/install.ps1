# install.ps1 — one-shot installer for the Enforcer Windows node.
# Run in an ELEVATED (Administrator) PowerShell on the target node:
#
#   .\install.ps1 -Bearer <64-hex> [-Name win-gpu-01] [-Port 8765] [-HashcatPath "C:\tools\hashcat\hashcat.exe"]
#
# It copies enforcer-node.exe + a generated config.yaml into
# C:\Program Files\enforcer-node and registers the auto-start service.
#
# Prereqs on the node: Tailscale installed + `tailscale up` (so the cockpit
# can reach it over the tailnet). hashcat optional (path configurable).

param(
    [Parameter(Mandatory = $true)][string]$Bearer,
    [string]$Name = $env:COMPUTERNAME,
    [int]$Port = 8765,
    [string]$HashcatPath = "hashcat",
    [string]$InstallDir = "$env:ProgramFiles\enforcer-node"
)

$ErrorActionPreference = "Stop"

# Must be admin to write Program Files + register a service.
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent() `
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Run this in an elevated (Administrator) PowerShell." }

$srcExe = Join-Path $PSScriptRoot "enforcer-node.exe"
if (-not (Test-Path $srcExe)) {
    $srcExe = Join-Path $PSScriptRoot "dist\enforcer-node.exe"
}
if (-not (Test-Path $srcExe)) { throw "enforcer-node.exe not found next to this script (or in .\dist)." }

Write-Host "-> creating $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $srcExe (Join-Path $InstallDir "enforcer-node.exe") -Force

# Escape backslashes for YAML double-quoted string.
$hashcatYaml = $HashcatPath -replace '\\', '\\'

$config = @"
server:
  host: "0.0.0.0"
  port: $Port
  bearer_token_hex: "$Bearer"
  require_token: true
  mcp_path: "/mcp"
node:
  name: "$Name"
  capabilities: ["hashcat", "cuda"]
tools:
  hashcat_path: "$hashcatYaml"
  exec_timeout_sec: 300
"@
$configPath = Join-Path $InstallDir "config.yaml"
Set-Content -Path $configPath -Value $config -Encoding UTF8
Write-Host "-> wrote $configPath"

# Open the firewall for the MCP port (inbound, so the cockpit can reach it).
try {
    New-NetFirewallRule -DisplayName "Enforcer MCP Node ($Port)" `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
        -ErrorAction SilentlyContinue | Out-Null
    Write-Host "-> firewall rule added for TCP $Port"
} catch { Write-Host "warning: could not add firewall rule: $_" }

# Register + start the service. If a previous install exists, remove it first —
# but only when it's actually present (a blind `uninstall` on a fresh box makes
# the binary log.Fatal to stderr, which PowerShell surfaces as a red error).
$exe = Join-Path $InstallDir "enforcer-node.exe"
if (Get-Service -Name "enforcer-node" -ErrorAction SilentlyContinue) {
    Write-Host "-> existing service found, removing it first"
    & $exe uninstall | Out-Null
    Start-Sleep -Seconds 1
}
& $exe install --config $configPath
Write-Host ""
Write-Host "Installed. Verify locally:  curl http://localhost:$Port/health"
Write-Host "Then add this node in the cockpit with the SAME bearer token."
