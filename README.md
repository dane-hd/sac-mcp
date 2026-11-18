# [SAP Analytics Cloud MCP Server](https://github.com/dane-hd/sac-mcp)

Forked from [JumenEngels/sap_analytics_cloud_mcp](https://github.com/JumenEngels/sap_analytics_cloud_mcp).

An [MCP](https://modelcontextprotocol.io/) (Model Context Protocol) server that exposes the SAP Analytics Cloud REST API as 90 tools consumable by any MCP-compatible client (Custom Agent, Claude Desktop, Claude Code, Cursor, etc.).

## What it does

Each person signs in to SAC as themselves with corporate SSO (OAuth 2.0 Authorization Code grant), so every call runs with that person's SAC permissions. The server manages tokens, refresh, CSRF tokens and session cookies automatically. It then exposes the full SAC REST API surface as discrete MCP tools grouped into 11 service areas:

| Module | Tools | Covers |
|---|---|---|
| Content | 10 | Stories, Resources, File Repository, Repositories, Widget Query |
| Data Export | 22 | Namespaces, Providers, Subscriptions, FactData, MasterData, AuditData, Aggregation, Difference, Currency/Unit tables, Public Dimensions |
| Data Import | 24 | Models, Import Jobs lifecycle (create/upload/validate/run/status), One-click Import, Public Dimensions, Currency Conversions, Unit Conversions |
| Multi Actions | 2 | Execute and poll status |
| Calendar | 3 | Get, update, copy calendar events |
| Content Transport | 7 | Export/import jobs, packages, permissions |
| User Management | 10 | SCIM v2 Users, Teams/Groups, Bulk operations |
| Monitoring | 2 | Audit activity export, model monitoring |
| Schedule & Publication | 4 | Schedule CRUD |
| Translation | 4 | Artifact metadata, XLIFF download (single + bulk) |
| Smart Query | 1 | Intelligent routing (Relational vs Analytical) |

Plus a `ping` connectivity check tool, `sac_login` / `sac_logout` sign-in tools, and **Prompt** support for guided workflows.


## Prerequisites

- **Node.js >= 18.0** (required for native `fetch` and `Headers.getSetCookie`)
- **npm**
- An SAP Analytics Cloud tenant with an Authorization Code OAuth client (see below).
- A browser on the same machine as the server, for the SSO sign-in.

### SAC Tenant Setup (admin, once per tenant)

1. Open your SAC tenant and go to **System > Administration > App Integration > Add a New OAuth Client**.
2. Set **Purpose** to **Interactive Usage**.
3. Set **Authorization Grant** to **Authorization Code**, keep it **Confidential**, and enter a **Secret**.
4. Set **Redirect URI** to `http://localhost:8765/callback` (or the value you will put in `SAC_REDIRECT_URI`; it must match exactly).
5. Set **Token Lifetime** and **Refresh Token Lifetime**. The refresh token lifetime is how long a user stays signed in before SSO is needed again.
6. Note down these values (the URLs are listed at the top of the App Integration page):
   - **Base URL** -- `https://<tenant>.<datacenter>.sapanalytics.cloud`
   - **Token URL**
   - **Authorization URL**
   - **Client ID**
   - **Client Secret**

The Client ID and Secret only identify this app to SAC. They grant nothing on their own: data access comes from the person who signs in.

### Sign in (each user)

Put the variables from the Configuration section in a `.env` file in the repo root (it is gitignored), then:

```bash
node --env-file=.env build/index.js login
```

A browser window opens at your SAC tenant, which hands you to the corporate IdP for SSO. After you sign in, the tokens are stored in your user profile under `~/.sac-mcp/` and refreshed silently. If you skip this step, the first SAC tool call opens the browser for you and asks you to retry; the `sac_login` tool does the same and waits. `node build/index.js logout` (or `sac_logout`) deletes the stored tokens.

## Installation & Build

```bash
git clone https://github.com/dane-hd/sac-mcp
cd sac-mcp
npm install
npm run build
```

## Quick Start: Agent Client

The easiest way to test the server locally (after doing mcp setup above) is using the included **Agent Client**. It connects to the server and uses an LLM (SAP AI Core, Anthropic, OpenAI, etc.) to interact with your SAC tenant.

### 1. Setup Configuration
Navigate to the client directory and run the setup script:

```bash
cd AgentClient
npm install
npm run setup
```

This creates `mcp_agentclient.json`. **Open this file and fill in your credentials:**
1.  **SAC Credentials**: Fill in `sac` section with the values from "SAC Tenant Setup".
2.  **LLM Credentials**: Fill in `aicore`, `anthropic`, or `openai` sections. 
3.  **Default Provider**: Set `"defaultProvider"` to your preferred LLM (e.g., `"genaicore"`, `"anthropic"`).

### 2. Run the Client
```bash
npm run build
npm start
```

The client will automatically load all necessary configuration (both for the LLM and the SAC Server) from your JSON file.

---

## Configuration (For standard MCP Clients)

If you are using **Claude Desktop**, **Cursor**, or another MCP client, you need to configure the server environment variables directly.

The server reads these environment variables at runtime:

| Variable | Required | Description | Example |
|---|---|---|---|
| `SAC_BASE_URL` | yes | Tenant root URL | `https://mytenant.eu10.sapanalytics.cloud` |
| `SAC_TOKEN_URL` | yes | OAuth token endpoint | `https://mytenant.authentication.eu10.hana.ondemand.com/oauth/token` |
| `SAC_CLIENT_ID` | yes | Client ID of the Authorization Code OAuth client | `sb-abc123-def456` |
| `SAC_CLIENT_SECRET` | yes | Secret of that OAuth client | `AbC123...` |
| `SAC_AUTHORIZE_URL` | no | Authorization URL. Default: `SAC_TOKEN_URL` with `/oauth/token` replaced by `/oauth/authorize` | `https://mytenant.authentication.eu10.hana.ondemand.com/oauth/authorize` |
| `SAC_REDIRECT_URI` | no | Redirect URI registered on the OAuth client. Must be on `localhost`. Default: `http://localhost:8765/callback` | |

### MCP Client Configuration

#### Claude Desktop
To automatically generate a configuration file with the correct absolute path:

```bash
npm run setup
```

This creates an `mcp_config.json` file in the project root. fill in your SAC credentials there and copy the content to your Claude Desktop config file.

#### Cursor / Other Clients
Add the server with the command `node build/index.js` and set the environment variables above in the client's configuration UI.

## Smart Query

The `smart_query` tool simplifies data access by intelligently routing your request:

- **Relational**: Simple `SELECT *` queries are routed to the OData API for raw entity data.
- **Analytical**: Queries with aggregations (`SUM`, `COUNT`, `GROUP BY`) are analyzed and routed to the Widget Query API.

```sql
SELECT SUM(Amount) FROM Model123 GROUP BY Region
```

## Prompts

The server provides pre-defined prompts to guide users through common workflows:

1.  **explore_content**: Discover stories and files in your tenant.
2.  **analyze_story**: Deep dive into a specific story's metadata and dependencies.
3.  **system_health_check**: Quick status check of connectivity and recent failures.

## Deployment

### Docker
```bash
docker build -t sac-mcp-server .
docker run -e SAC_BASE_URL="..." ... sac-mcp-server
```

## Development

Watch mode recompiles on every file change:

```bash
npm run dev
```

### Security Notes

- **Write Operations**: All tools that modify data require `allowalteration=true` argument.

