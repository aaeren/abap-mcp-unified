# abap-mcp-unified

Unified MCP server for SAP ABAP development via the ADT API. Connect AI assistants to your SAP system — read, write, activate, test, and deploy ABAP code without SAP GUI.

The AI can create objects, write source, activate, manage transports, run code, query tables, check quality, and inspect transaction codes. Full development lifecycle, not just read-only or code generation.

## Origins & Credits

This project merges two open-source ABAP MCP servers:

- **[mario-andreschak/mcp-abap-adt](https://github.com/mario-andreschak/mcp-abap-adt)** by **[Mario Andreschak](https://github.com/mario-andreschak)** — original MCP server structure, tool naming inspiration, and `abap_get_transaction` handler logic.
- **[DassianInc/dassian-adt](https://github.com/DassianInc/dassian-adt)** by **[Dassian Inc.](https://github.com/DassianInc)** — the base implementation: `BaseHandler`, `withSession`, error intelligence, MCP elicitation, session recovery, and comprehensive test suite.
- **[abap-adt-api](https://github.com/marcellourbani/abap-adt-api)** by **[Marcello Urbani](https://github.com/marcellourbani)** — the underlying ADT client library.

## What It Does

32 tools covering the full ABAP development lifecycle:

| Category | Tools | What They Do |
|----------|-------|-------------|
| **Source** | `abap_get_source`, `abap_set_source`, `abap_get_function_group`, `abap_set_class_include`, `abap_edit_method` | Read/write ABAP source for any object type. Function group tool fetches all includes and FMs in one call. |
| **Objects** | `abap_create`, `abap_delete`, `abap_activate`, `abap_activate_batch`, `abap_search`, `abap_object_info` | Full object lifecycle. Create in $TMP or real packages. Automatic type mapping. |
| **Transports** | `transport_create`, `transport_assign`, `transport_release`, `transport_list`, `transport_info`, `transport_contents` | Create, populate, and release transports. Toggleable via `ENABLE_TRANSPORT` env var. |
| **Quality** | `abap_syntax_check`, `abap_atc_run`, `abap_where_used`, `abap_atc_variants` | Syntax check, ATC with variant support, where-used analysis. |
| **Data** | `abap_table`, `abap_query` | Read tables/CDS views with WHERE/LIKE/BETWEEN. Execute freestyle SQL. |
| **Run** | `abap_run`, `abap_unlock` | Create temp class, run ABAP code, capture output, clean up. |
| **System** | `login`, `healthcheck`, `abap_get_dump`, `abap_get_transaction`, `raw_http` | Session management, ST22 dumps, transaction code details, raw ADT access. |
| **Git** | `git_repos`, `git_pull` | gCTS repository listing and pull. |

## Quick Start

### Prerequisites

- Node.js 18+
- Access to an SAP system with ADT enabled (port 44300)
- SAP user with development authorization

### Install

```bash
git clone https://github.com/aaeren/abap-mcp-unified.git
cd abap-mcp-unified
npm install
npm run build
```

### Configure

```bash
cp .env.example .env
# Edit .env with your SAP connection details:
#   SAP_URL=https://your-sap-server:44300
#   SAP_USER=YOUR_USER
#   SAP_PASSWORD=YOUR_PASSWORD
#   SAP_CLIENT=100
#   SAP_LANGUAGE=EN
```

For self-signed certificates, add to your `.env`:
```
NODE_TLS_REJECT_UNAUTHORIZED=0
```

### Transport Tools (optional)

Transport tools are enabled by default. To disable them:
```bash
ENABLE_TRANSPORT=false
```

### Add to Claude Code

```json
{
  "mcpServers": {
    "abap": {
      "command": "node",
      "args": ["/path/to/abap-mcp-unified/dist/index.js"],
      "env": {
        "SAP_URL": "https://your-sap-server:44300",
        "SAP_USER": "YOUR_USER",
        "SAP_PASSWORD": "YOUR_PASSWORD",
        "SAP_CLIENT": "100"
      }
    }
  }
}
```

## HTTP Mode (Team Deployment)

Run as a shared HTTP server so multiple users can connect via browser-based login:

```bash
MCP_TRANSPORT=http MCP_HTTP_PORT=3000 SAP_URL=https://your-sap-server:44300 node dist/index.js
```

Users open `http://localhost:3000/login` in their browser and enter their SAP credentials. Each user gets an isolated session.

## New Tool: abap_get_transaction

Read transaction code details directly from ADT:

```
abap_get_transaction(name: "VA01")
abap_get_transaction(name: "/DSN/BILLING")
```

Returns the raw ADT XML describing the transaction — target program, screen number, authorization object, and more.

## MCP Prompts

Pre-built workflows callable as slash commands from Claude Code:

| Prompt | What It Does |
|--------|-------------|
| `/fix-atc` | Run ATC, read P1 findings, fix each one, activate |
| `/transport-review` | List transport contents, syntax-check all objects |
| `/class-overview` | Compact source + where-used count for a class |
| `/release-transport` | Check, validate, and release a transport |

## License

MIT
