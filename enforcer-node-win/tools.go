package main

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// toolSpec is the aux (/tools) description shape, mirroring the Python node's
// listing so the cockpit's // tools tab renders identically.
type toolSpec struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	ArgSchema   map[string]any `json:"arg_schema"`
}

// toolSpecs is Phase-1's fixed tool set: a generic shell exec (parity with the
// Linux nodes' exec_command) and a hashcat wrapper for GPU cracking.
func toolSpecs(_ *Config) []toolSpec {
	return []toolSpec{
		{
			Name:        "exec_command",
			Description: "Run a shell command on this Windows node (cmd /C).",
			ArgSchema:   map[string]any{"cmd": "string"},
		},
		{
			Name:        "hashcat",
			Description: "Run hashcat with the given argument string (GPU cracking).",
			ArgSchema:   map[string]any{"args": "string"},
		},
	}
}

// mcpToolList renders the MCP tools/list shape (name/description/inputSchema).
func mcpToolList(specs []toolSpec) []map[string]any {
	out := make([]map[string]any, 0, len(specs))
	for _, s := range specs {
		props := map[string]any{}
		for k := range s.ArgSchema {
			props[k] = map[string]any{"type": "string"}
		}
		out = append(out, map[string]any{
			"name":        s.Name,
			"description": s.Description,
			"inputSchema": map[string]any{"type": "object", "properties": props},
		})
	}
	return out
}

// runTool dispatches an MCP tools/call. Returns (text, isError).
func runTool(cfg *Config, _ []toolSpec, name string, args map[string]any) (string, bool) {
	switch name {
	case "exec_command":
		cmd, _ := args["cmd"].(string)
		if strings.TrimSpace(cmd) == "" {
			return "error: 'cmd' argument is required", true
		}
		return runShell(cfg, cmd)
	case "hashcat":
		a, _ := args["args"].(string)
		return runShell(cfg, cfg.Tools.HashcatPath+" "+a)
	default:
		return "error: unknown tool " + name, true
	}
}

// runShell executes a command with a timeout and returns combined output.
// Cross-platform so the same binary is testable on Linux (sh -c) and runs on
// Windows (cmd /C). Phase 3 will replace synchronous hashcat runs with proper
// job dispatch + streamed results.
func runShell(cfg *Config, command string) (string, bool) {
	ctx, cancel := context.WithTimeout(
		context.Background(), time.Duration(cfg.Tools.ExecTimeoutSec)*time.Second)
	defer cancel()

	var c *exec.Cmd
	if runtime.GOOS == "windows" {
		c = exec.CommandContext(ctx, "cmd", "/C", command)
	} else {
		c = exec.CommandContext(ctx, "sh", "-c", command)
	}
	out, err := c.CombinedOutput()
	s := string(out)
	if len(s) > 60000 {
		s = s[:60000] + "\n...[truncated]"
	}
	if ctx.Err() == context.DeadlineExceeded {
		return fmt.Sprintf("%s\n[timed out after %ds]", s, cfg.Tools.ExecTimeoutSec), true
	}
	if err != nil {
		return fmt.Sprintf("%s\n[exit: %v]", s, err), true
	}
	return s, false
}
