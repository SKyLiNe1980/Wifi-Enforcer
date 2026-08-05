//go:build !windows

package main

import "errors"

// Non-Windows stubs so the module compiles + runs on Linux/macOS for testing
// the HTTP/MCP surface. Only the SCM service lifecycle is Windows-only; the
// core server (serve/runInteractive) is fully cross-platform.

var errWindowsOnly = errors.New("service management is Windows-only; use `run` for interactive mode")

func runService(cfg *Config) error         { return errWindowsOnly }
func installService(_, _ string) error      { return errWindowsOnly }
func uninstallService() error               { return errWindowsOnly }
func startService() error                   { return errWindowsOnly }
func stopService() error                    { return errWindowsOnly }

// Never a Windows service off Windows → always run interactively.
func isWindowsService() bool { return false }
