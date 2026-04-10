# dassian-adt: Azure Deployment Guide

## What This Is

A Node.js server that gives AI assistants (Claude) access to SAP systems. Runs as a single process, listens on HTTP, handles multiple concurrent users — each gets their own SAP session via a browser login page. Your job: get it running, reachable by the team, reachable to SAP.

---

## 1. VM

**B2s** (2 vCPU, 4 GB RAM, ~$30/month). This is not compute-heavy — it proxies HTTP requests to SAP.

- **OS:** Windows Server 2022 or Ubuntu 22.04 LTS (either works — Node.js is cross-platform)
- **Disk:** 30 GB Standard SSD
- **Region:** Same as the SAP systems (they're already on Azure)

---

## 2. Network

**Outbound to SAP (NSG egress rules, port 44300 TCP):**

| Destination | Host | Purpose |
|-------------|------|---------|
| D23 | `d23app.dassian.org:44300` | Dev 2023 |
| D25 | `d25app.dassian.org:44300` | Dev 2025 |
| X22 | `x22app.dassian.org:44300` | Dev 2022 |
| C23 | `c23app.dassian.azure:44300` | Consolidation 2023 |
| C25 | `c25app.dassian.azure:44300` | Consolidation 2025 |
| M25 | `m25app.dassian.org:44300` | Replatform dev |

The `.dassian.azure` hosts are on the same Azure network — confirm the VM is in the same VNet or has peering. The `.dassian.org` hosts need routing through existing network paths.

**Inbound (NSG ingress rule):**

| Source | Port | Purpose |
|--------|------|---------|
| Team IP range or VPN CIDR | 3000 TCP | MCP HTTP endpoint + login page |

Do NOT expose port 3000 to the public internet. Restrict to your VPN/office CIDR.

---

## 3. Install

### Windows Server

```powershell
# Install Node.js 20 — download from https://nodejs.org/ or use winget:
winget install OpenJS.NodeJS.LTS

# Install Git
winget install Git.Git

# Clone and build
cd C:\
git clone https://github.com/DassianInc/dassian-adt.git
cd dassian-adt
npm install
npm run build

# Verify
npm test
# Should show 165 passing tests
```

### Ubuntu (alternative)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

git clone https://github.com/DassianInc/dassian-adt.git /opt/dassian-adt
cd /opt/dassian-adt
npm install
npm run build
npm test
```

---

## 4. Configure

There are two auth modes. **Per-user auth is recommended** — each team member logs in with their own SAP credentials via a browser page.

### Per-user auth (recommended)

Only set `SAP_URL`. Do NOT set `SAP_USER` or `SAP_PASSWORD`. The server will show a login page to each user.

**Windows** — create `C:\dassian-adt\.env`:
```
MCP_TRANSPORT=http
MCP_HTTP_PORT=3000
SAP_URL=https://d25app.dassian.org:44300
SAP_CLIENT=100
SAP_LANGUAGE=EN
NODE_TLS_REJECT_UNAUTHORIZED=0
```

**Ubuntu** — create `/opt/dassian-adt/.env`:
```
MCP_TRANSPORT=http
MCP_HTTP_PORT=3000
SAP_URL=https://d25app.dassian.org:44300
SAP_CLIENT=100
SAP_LANGUAGE=EN
NODE_TLS_REJECT_UNAUTHORIZED=0
```

### Shared service account (alternative)

Add `SAP_USER` and `SAP_PASSWORD` to the `.env`. All users share one SAP connection. No login page. Simpler but no per-user audit trail.

### Multiple SAP systems

Run one instance per system on different ports. Copy the `.env` file for each:

```
# .env.d25 — port 3000
MCP_TRANSPORT=http
MCP_HTTP_PORT=3000
SAP_URL=https://d25app.dassian.org:44300

# .env.d23 — port 3001
MCP_TRANSPORT=http
MCP_HTTP_PORT=3001
SAP_URL=https://d23app.dassian.org:44300
```

---

## 5. Run as a Service

### Windows (NSSM)

Download [NSSM](https://nssm.cc/) (Non-Sucking Service Manager) and install:

```powershell
# Install NSSM (or download from nssm.cc)
# Then create the service:
nssm install dassian-adt-d25 "C:\Program Files\nodejs\node.exe" "C:\dassian-adt\dist\index.js"
nssm set dassian-adt-d25 AppDirectory "C:\dassian-adt"
nssm set dassian-adt-d25 AppEnvironmentExtra "MCP_TRANSPORT=http" "MCP_HTTP_PORT=3000" "SAP_URL=https://d25app.dassian.org:44300" "SAP_CLIENT=100" "SAP_LANGUAGE=EN" "NODE_TLS_REJECT_UNAUTHORIZED=0"
nssm set dassian-adt-d25 DisplayName "dassian-adt (D25)"
nssm set dassian-adt-d25 Description "MCP server for SAP D25"
nssm start dassian-adt-d25

# For D23 on port 3001:
nssm install dassian-adt-d23 "C:\Program Files\nodejs\node.exe" "C:\dassian-adt\dist\index.js"
nssm set dassian-adt-d23 AppEnvironmentExtra "MCP_TRANSPORT=http" "MCP_HTTP_PORT=3001" "SAP_URL=https://d23app.dassian.org:44300" "SAP_CLIENT=100" "SAP_LANGUAGE=EN" "NODE_TLS_REJECT_UNAUTHORIZED=0"
nssm start dassian-adt-d23
```

### Ubuntu (systemd)

Create `/etc/systemd/system/dassian-adt-d25.service`:

```ini
[Unit]
Description=dassian-adt MCP server (D25)
After=network.target

[Service]
Type=simple
User=dassian
WorkingDirectory=/opt/dassian-adt
EnvironmentFile=/opt/dassian-adt/.env.d25
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -s /bin/false dassian
sudo chown -R dassian:dassian /opt/dassian-adt
sudo systemctl daemon-reload
sudo systemctl enable dassian-adt-d25
sudo systemctl start dassian-adt-d25
```

---

## 6. Verify

```bash
# Health check (from the VM)
curl http://localhost:3000/health
# Returns: {"status":"ok","sessions":0,"pendingLogins":0,"authMode":"per-user"}

# Health check (from your machine, through VPN)
curl http://<vm-ip>:3000/health

# Login page (open in browser)
http://<vm-ip>:3000/login
```

---

## 7. How Users Connect

### First time setup (one-time, ~2 minutes)

1. User adds this to their Claude Code config:
```json
{
  "mcpServers": {
    "abap-d25": {
      "type": "url",
      "url": "http://<vm-ip>:3000/mcp"
    }
  }
}
```

2. User starts a Claude session and calls any SAP tool
3. Claude shows a link to the login page (or user opens `http://<vm-ip>:3000/login` directly)
4. User enters their SAP username and password
5. Browser shows "Connected to SAP" — they close the tab
6. SAP tools work for the rest of the session

The login page validates credentials against SAP before accepting them. If the password is wrong, the user sees the error immediately and can retry.

### What to give Paul

- The URL: `http://<vm-ip-or-dns>:3000/mcp` (D25)
- The URL: `http://<vm-ip-or-dns>:3001/mcp` (D23, if running)
- Confirm which SAP systems are reachable from the VM

---

## 8. Maintenance

**Updates:**
```powershell
# Windows
cd C:\dassian-adt
git pull
npm install
npm run build
nssm restart dassian-adt-d25
```

```bash
# Ubuntu
cd /opt/dassian-adt
git pull
npm install
npm run build
sudo systemctl restart dassian-adt-d25
```

**Logs:**
- Windows: `nssm status dassian-adt-d25` / check Event Viewer or configure NSSM log file
- Ubuntu: `sudo journalctl -u dassian-adt-d25 --since "1 hour ago"`

**SAP password rotation:** No server restart needed — each user logs in with their own password.

**Monitoring:** The `/health` endpoint returns session count and auth mode. Point your monitoring at it.
