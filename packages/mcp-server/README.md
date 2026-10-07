# Lumière PayCheck MCP server (stdio)

The same six tools as the hosted server at `https://lumierepaycheck.org/mcp`, run locally over stdio. It answers with data from the public Lumière PayCheck API. Free, no API key.

Tools: `check_payment`, `check_endpoint`, `report_outcome`, `top_endpoints`, `catalog_stats`, `get_full_report`.

## Run

```bash
cd packages/mcp-server
npm ci --omit=dev
node server.js
```

MCP client config (`mcp.json`):

```json
{ "mcpServers": { "lumiere-paycheck": { "command": "node", "args": ["/path/to/lumiere-paycheck/packages/mcp-server/server.js"] } } }
```

Or with Docker, from the repo root:

```bash
docker build -t lumiere-paycheck-mcp .
docker run -i --rm lumiere-paycheck-mcp
```

Optional: `LUMIERE_PAYCHECK_URL` changes the API base URL (default `https://lumierepaycheck.org`).

Prefer no install? Use the hosted server: `https://lumierepaycheck.org/mcp`.
