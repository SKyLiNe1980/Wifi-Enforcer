package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
)

// Version of the Windows node binary. Reported via /health and `version`.
const Version = "0.1.0"

// Windows service identity (used by the SCM install/uninstall paths).
const (
	serviceName    = "enforcer-node"
	serviceDisplay = "Enforcer MCP Node"
	serviceDesc    = "Enforcer pentest mesh node (MCP over HTTP; GPU/hashcat capable)."
)

func main() {
	// First arg is the subcommand; default to "run" so a bare launch (e.g.
	// by the SCM) just runs.
	cmd := "run"
	var rest []string
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "install", "uninstall", "start", "stop", "run", "version":
			cmd = os.Args[1]
			rest = os.Args[2:]
		default:
			// Treat unknown leading token as flags for `run`.
			rest = os.Args[1:]
		}
	}

	switch cmd {
	case "version":
		fmt.Printf("enforcer-node-win %s\n", Version)
	case "install":
		exe, err := os.Executable()
		if err != nil {
			fatal(err)
		}
		if err := installService(exe, configPathFromArgs(rest)); err != nil {
			fatal(err)
		}
		fmt.Printf("installed + started service %q\n", serviceName)
	case "uninstall":
		if err := uninstallService(); err != nil {
			fatal(err)
		}
		fmt.Printf("uninstalled service %q\n", serviceName)
	case "start":
		if err := startService(); err != nil {
			fatal(err)
		}
		fmt.Println("service started")
	case "stop":
		if err := stopService(); err != nil {
			fatal(err)
		}
		fmt.Println("service stopped")
	case "run":
		cfg, err := LoadConfig(configPathFromArgs(rest))
		if err != nil {
			fatal(fmt.Errorf("config: %w", err))
		}
		if isWindowsService() {
			if err := runService(cfg); err != nil {
				fatal(err)
			}
		} else {
			if err := runInteractive(cfg); err != nil {
				fatal(err)
			}
		}
	}
}

// configPathFromArgs resolves --config, defaulting to config.yaml next to the
// executable (so an installed service finds its config without extra flags).
func configPathFromArgs(args []string) string {
	fs := flag.NewFlagSet("enforcer-node", flag.ContinueOnError)
	var cfg string
	fs.StringVar(&cfg, "config", "", "path to config.yaml")
	_ = fs.Parse(args)
	if cfg == "" {
		if exe, err := os.Executable(); err == nil {
			cfg = filepath.Join(filepath.Dir(exe), "config.yaml")
		} else {
			cfg = "config.yaml"
		}
	}
	return cfg
}

// runInteractive runs the server in the foreground (dev / testing / non-Windows),
// shutting down cleanly on Ctrl-C or SIGTERM.
func runInteractive(cfg *Config) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Printf("enforcer-node-win %s starting (interactive)", Version)
	return serve(ctx, cfg)
}

func fatal(err error) {
	log.Fatalf("enforcer-node: %v", err)
}
