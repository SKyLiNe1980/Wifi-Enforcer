package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

// serve starts the HTTP server and blocks until ctx is cancelled (service
// stop / Ctrl-C), then shuts down gracefully. Plain net/http — the exact
// same surface the Python nodes expose, so the cockpit needs no changes.
func serve(ctx context.Context, cfg *Config) error {
	h := buildHandler(cfg)
	srv := &http.Server{
		Addr:              fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port),
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		log.Printf("enforcer-node-win %s listening on %s (mcp=%s, caps=%v)",
			Version, srv.Addr, cfg.Server.MCPPath, effectiveCapabilities(cfg))
		errCh <- srv.ListenAndServe()
	}()
	select {
	case <-ctx.Done():
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutCtx)
	case err := <-errCh:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	}
}

// buildHandler wires the routes: public /health, bearer-guarded /tools and
// the MCP Streamable-HTTP endpoint at cfg.Server.MCPPath.
func buildHandler(cfg *Config) http.Handler {
	mux := http.NewServeMux()
	specs := toolSpecs(cfg)

	// GET /health — public (matches Python: cockpit probes before it has a
	// token). Reports tool count + capabilities so the cockpit's probeNode
	// stores them in last_health_info.
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":        "ok",
			"service":       "enforcer-node-win",
			"version":       Version,
			"tools":         len(specs),
			"require_token": cfg.Server.RequireToken,
			"node":          cfg.Node.Name,
			"capabilities":  effectiveCapabilities(cfg),
			"ts":            time.Now().UTC().Format(time.RFC3339),
		})
	})

	// GET /tools — aux JSON listing (the cockpit's // tools tab uses this).
	mux.HandleFunc("/tools", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"tools": specs})
	})

	// MCP Streamable-HTTP endpoint.
	mux.HandleFunc(cfg.Server.MCPPath, func(w http.ResponseWriter, r *http.Request) {
		handleMCP(w, r, cfg, specs)
	})

	return bearerMiddleware(cfg, mux)
}

// bearerMiddleware enforces Authorization: Bearer <hex> on everything except
// /health and OPTIONS. Mirrors the Python BearerAuthMiddleware exactly.
func bearerMiddleware(cfg *Config, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions || r.URL.Path == "/health" || !cfg.Server.RequireToken {
			next.ServeHTTP(w, r)
			return
		}
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(strings.ToLower(auth), "bearer ") {
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "missing bearer token"})
			return
		}
		tok := strings.TrimSpace(auth[len("bearer "):])
		if subtle.ConstantTimeCompare([]byte(tok), []byte(cfg.Server.BearerTokenHex)) != 1 {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "invalid bearer token"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ─── MCP Streamable-HTTP (JSON-RPC 2.0) ─────────────────────────────────
// We implement only the subset the cockpit drives: initialize (returns an
// Mcp-Session-Id header), notifications/initialized, tools/list, tools/call,
// plus DELETE for session teardown. Replies are application/json — the
// cockpit's parser accepts JSON or SSE, and these are short calls.

type rpcReq struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

func handleMCP(w http.ResponseWriter, r *http.Request, cfg *Config, specs []toolSpec) {
	if r.Method == http.MethodDelete {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	var req rpcReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeRPCError(w, nil, -32700, "parse error")
		return
	}

	switch req.Method {
	case "initialize":
		w.Header().Set("Mcp-Session-Id", newSessionID())
		writeRPCResult(w, req.ID, map[string]any{
			"protocolVersion": "2025-06-18",
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "enforcer-node-win", "version": Version},
		})
	case "notifications/initialized":
		// Notification (no id) — spec says 202, no body.
		w.WriteHeader(http.StatusAccepted)
	case "tools/list":
		writeRPCResult(w, req.ID, map[string]any{"tools": mcpToolList(specs)})
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		_ = json.Unmarshal(req.Params, &p)
		out, isErr := runTool(cfg, specs, p.Name, p.Arguments)
		writeRPCResult(w, req.ID, map[string]any{
			"content": []map[string]any{{"type": "text", "text": out}},
			"isError": isErr,
		})
	default:
		if len(req.ID) == 0 {
			w.WriteHeader(http.StatusAccepted) // unknown notification — ignore
			return
		}
		writeRPCError(w, req.ID, -32601, "method not found: "+req.Method)
	}
}

// ─── response helpers ───────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeRPCResult(w http.ResponseWriter, id json.RawMessage, result any) {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"jsonrpc": "2.0", "id": id, "result": result,
	})
}

func writeRPCError(w http.ResponseWriter, id json.RawMessage, code int, msg string) {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"jsonrpc": "2.0", "id": id,
		"error": map[string]any{"code": code, "message": msg},
	})
}

func newSessionID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// effectiveCapabilities = configured capabilities, auto-appending "cuda" when
// an NVIDIA stack is present so the cockpit can schedule GPU jobs accurately.
func effectiveCapabilities(cfg *Config) []string {
	caps := append([]string{}, cfg.Node.Capabilities...)
	if hasBinary("nvidia-smi") && !contains(caps, "cuda") {
		caps = append(caps, "cuda")
	}
	if caps == nil {
		caps = []string{}
	}
	return caps
}

func hasBinary(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}
