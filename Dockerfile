# Lumière PayCheck MCP server over stdio (packages/mcp-server). No secrets needed.
# The same tools are also hosted at https://lumierepaycheck.org/mcp.
FROM node:22-alpine
WORKDIR /app
COPY packages/mcp-server/package.json packages/mcp-server/package-lock.json ./
RUN npm ci --omit=dev
COPY packages/mcp-server/server.js ./
ENTRYPOINT ["node", "server.js"]
