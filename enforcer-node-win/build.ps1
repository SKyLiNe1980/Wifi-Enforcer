# Build the Windows node binary on Windows.
# Produces dist\enforcer-node.exe
Set-Location $PSScriptRoot
if (!(Test-Path dist)) { New-Item -ItemType Directory dist | Out-Null }

Write-Host "-> go mod tidy"
go mod tidy

Write-Host "-> building enforcer-node.exe (CGO_ENABLED=0)"
$env:CGO_ENABLED = "0"
go build -trimpath -ldflags "-s -w" -o dist\enforcer-node.exe .

Write-Host "done. dist\enforcer-node.exe"
