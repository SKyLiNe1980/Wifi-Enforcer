package main

import (
	"os"

	"gopkg.in/yaml.v3"
)

// Config mirrors the Linux node's config.yaml shape so the whole fleet feels
// consistent (same server.bearer_token_hex / host / port keys), plus a node
// block advertising capabilities and a tools block for GPU tooling paths.
type Config struct {
	Server struct {
		Host           string `yaml:"host"`
		Port           int    `yaml:"port"`
		BearerTokenHex string `yaml:"bearer_token_hex"`
		RequireToken   bool   `yaml:"require_token"`
		MCPPath        string `yaml:"mcp_path"`
	} `yaml:"server"`
	Node struct {
		Name         string   `yaml:"name"`
		Capabilities []string `yaml:"capabilities"`
	} `yaml:"node"`
	Tools struct {
		HashcatPath    string `yaml:"hashcat_path"`
		ExecTimeoutSec int    `yaml:"exec_timeout_sec"`
	} `yaml:"tools"`
}

// LoadConfig reads + parses the YAML config and fills in sane defaults so a
// minimal file (just a bearer token) still boots a working node.
func LoadConfig(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := yaml.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	if c.Server.Host == "" {
		c.Server.Host = "0.0.0.0"
	}
	if c.Server.Port == 0 {
		c.Server.Port = 8765
	}
	if c.Server.MCPPath == "" {
		c.Server.MCPPath = "/mcp"
	}
	if c.Tools.HashcatPath == "" {
		c.Tools.HashcatPath = "hashcat"
	}
	if c.Tools.ExecTimeoutSec == 0 {
		c.Tools.ExecTimeoutSec = 300
	}
	if c.Node.Name == "" {
		if h, err := os.Hostname(); err == nil {
			c.Node.Name = h
		} else {
			c.Node.Name = "win-node"
		}
	}
	return &c, nil
}
