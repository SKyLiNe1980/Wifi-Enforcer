# Federating enforcer-mcp through Tailscale Aperture

[Tailscale Aperture](https://tailscale.com/docs/aperture/mcp-server) is a tailnet
MCP gateway: point one MCP client at Aperture and it proxies to every MCP server
you've registered as a **connector**. This lets you drive enforcer-mcp (and the
whole swarm) from a single endpoint — e.g.:

```
http://enforcer.tailf5f9bc.ts.net/v1/mcp
```

enforcer-mcp already speaks the MCP 2025 Streamable-HTTP transport at
`/mcp` (port `8765`, bearer-token auth). Adding it to Aperture is a
**config-only** change on the Aperture side — no server code change.

## 1. Apply the connector config

Use [`packaging/aperture-connector.example.json`](packaging/aperture-connector.example.json)
as a template. Merge each block into your Aperture config (don't overwrite
existing `flags` / `connectors` / `grants`):

- **`flags.connectors: true`** — enables MCP proxying.
- **`connectors.servers.enforcer`** — points Aperture at the node's `/mcp`
  URL over MagicDNS, with the cockpit's bearer token:
  ```json
  {
    "protocol": "mcp",
    "url": "http://enforcer-cockpit.tailf5f9bc.ts.net:8765/mcp",
    "auth": { "type": "bearer_token", "secret": "<64-hex from cockpit MCP tab>" }
  }
  ```
  Replace the host with your node's MagicDNS name and the secret with the
  **same** `bearer_token_hex` you set in `config.yaml` (shown in the cockpit's
  MCP tab). Aperture reaches the node over the tailnet, so no port-forwarding
  or public exposure is needed.
- **`grants`** — Aperture is deny-by-default. The grant allows access to
  `enforcer/**` (all of the connector's tools). Tighten `src` / the tool glob
  as needed (e.g. `enforcer/tools/gtfobins_*`).

## 2. Verify

Point any MCP client (Claude, Hermes, MCP Inspector) at the Aperture endpoint
and list tools. enforcer-mcp's tools appear **prefixed with the connector ID**:

```
enforcer_self_update
enforcer_start_session
enforcer_write_stdin
enforcer_read_session
enforcer_gtfobins_lookup
enforcer_gtfobins_triage
...
```

## 3. Multiple nodes

Add one `connectors.servers.<id>` entry per node (e.g. `enforcer`, `node-alpha`,
`node-bravo`), each with its own MagicDNS URL + bearer token. Every node's
tools then show up prefixed by its connector ID, so you can target a specific
box from the single Aperture endpoint.

## Notes

- **Dynamic self-registration** (nodes registering themselves at boot) is
  possible if you set `mcp.accept_registrations: true` in Aperture. We ship the
  static-config path here because it's zero-risk and doesn't require handing an
  Aperture token to every node. Ask if you want the self-registration variant.
- The connector URL must be the node's **MCP endpoint** (`.../mcp`), not the
  Aperture endpoint (`.../v1/mcp`) — the latter is what clients connect to.
