#!/usr/bin/env node

import { config } from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode
} from '@modelcontextprotocol/sdk/types.js';
import { ADTClient, session_types, createSSLConfig } from 'abap-adt-api';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import path from 'path';
import { URL } from 'url';

import { SourceHandlers }    from './handlers/SourceHandlers.js';
import { ObjectHandlers }    from './handlers/ObjectHandlers.js';
import { RunHandlers }       from './handlers/RunHandlers.js';
import { TransportHandlers } from './handlers/TransportHandlers.js';
import { DataHandlers }      from './handlers/DataHandlers.js';
import { QualityHandlers }   from './handlers/QualityHandlers.js';
import { GitHandlers }       from './handlers/GitHandlers.js';
import { SystemHandlers }    from './handlers/SystemHandlers.js';
import { DynproHandlers }    from './handlers/DynproHandlers.js';
import { renderLoginPage, renderLoginSuccess } from './auth/loginPage.js';
import { SystemDef, loadRegistry, initialSystem, findSystem, describeSystem, ENV_SYSTEM_NAME } from './lib/systems.js';

/** Tools that manage the connection itself — always available, even with no system connected. */
const CONNECTION_TOOLS = [
  {
    name: 'sap_systems',
    annotations: { readOnlyHint: true },
    description:
      'List the SAP systems this server can connect to (from the central systems file) and which one is ' +
      'currently active. Call this when the user names a system you do not recognise, or before sap_connect.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'sap_connect',
    annotations: { idempotentHint: true },
    description:
      'Switch the ACTIVE SAP system at runtime — no restart needed. Every other tool then runs against ' +
      'this system until sap_connect is called again. Use when the user says "connect to X" / "X sistemine bağlan". ' +
      'Logs in and returns the verified system identity (SID, client, user). Releases locks and logs out of the ' +
      'previous system first. A system marked readOnly refuses all modifying tools.',
    inputSchema: {
      type: 'object',
      properties: {
        system: { type: 'string', description: 'System name from sap_systems (unique partial names are accepted).' }
      },
      required: ['system']
    }
  }
];

/** Modifying tools that stay usable on a readOnly system because they do not change repository state. */
const READ_ONLY_EXEMPT = new Set(['login', 'sap_connect']);

config({ path: path.resolve(__dirname, '../.env') });

// ─── MCP Prompts ─────────────────────────────────────────────────────────────
// Pre-built workflows callable as slash commands from Claude Code.

interface PromptDef {
  name: string;
  description: string;
  messages: (args: Record<string, string>) => Array<{ role: 'user' | 'assistant'; content: { type: 'text'; text: string } }>;
}

const PROMPTS: PromptDef[] = [
  {
    name: 'fix-atc',
    description: 'Run ATC on an ABAP object, read all P1 findings, fix each one, and activate.',
    messages: (args) => [{
      role: 'user',
      content: {
        type: 'text',
        text: `Run ATC on the ABAP object "${args.name || '<name>'}" (type: ${args.type || 'CLAS'}).
For every Priority 1 finding:
1. Read the relevant source (use compact=true first for classes to understand the structure)
2. Fix the finding — prefer a real code fix over an exemption
3. Syntax-check before writing
4. After all fixes, activate the object
Report a summary of what was fixed.`
      }
    }]
  },
  {
    name: 'transport-review',
    description: 'List transport contents, syntax-check all objects, and report issues.',
    messages: (args) => [{
      role: 'user',
      content: {
        type: 'text',
        text: `Review transport "${args.transport || '<transport>'}":
1. List all objects in the transport with transport_contents
2. For each ABAP source object (CLAS, PROG, FUGR, INTF), run abap_syntax_check
3. Report any syntax errors with line numbers
4. If clean, confirm the transport is ready for release.`
      }
    }]
  },
  {
    name: 'class-overview',
    description: 'Get a compact interface summary of a class plus its where-used count.',
    messages: (args) => [{
      role: 'user',
      content: {
        type: 'text',
        text: `Give me an overview of ABAP class "${args.name || '<class name>'}":
1. Get the compact source (abap_get_source with compact=true) to see the full interface
2. Get the where-used count (abap_where_used) to understand how widely it's used
3. Summarize: what the class does, its public API, and how many things depend on it.`
      }
    }]
  },
  {
    name: 'release-transport',
    description: 'Check, syntax-validate, and release a transport.',
    messages: (args) => [{
      role: 'user',
      content: {
        type: 'text',
        text: `Prepare and release transport "${args.transport || '<transport>'}":
1. Show the transport contents
2. Syntax-check every ABAP object in the transport
3. If there are syntax errors, stop and report them — do NOT release
4. If all clean, release the transport (task first, then request)
5. Confirm the release status.`
      }
    }]
  },
];

export class AbapAdtServer extends Server {
  private adtClient: ADTClient;
  private sourceHandlers:    SourceHandlers;
  private objectHandlers:    ObjectHandlers;
  private runHandlers:       RunHandlers;
  private transportHandlers: TransportHandlers;
  private dataHandlers:      DataHandlers;
  private qualityHandlers:   QualityHandlers;
  private gitHandlers:       GitHandlers;
  private systemHandlers:    SystemHandlers;
  private dynproHandlers:    DynproHandlers;

  /** objectUrl → LOCK_HANDLE for every lock this process currently holds. See trackLocks(). */
  private readonly heldLocks = new Map<string, string>();

  /** The system every tool currently runs against; undefined until sap_connect when no default exists. */
  private activeSystem?: SystemDef;

  constructor(sapUrl?: string, sapUser?: string, sapPassword?: string, sapClient?: string, sapLanguage?: string) {
    super(
      { name: 'dassian-adt', version: '2.0.0' },
      { capabilities: { tools: {}, logging: {}, prompts: {} } }
    );

    // Explicit credentials (HTTP mode) win; otherwise pick the startup system from the registry.
    // With neither, the server still starts — tools ask for sap_connect instead of crashing the client.
    let initial: SystemDef | undefined;
    if (sapUrl && sapUser && sapPassword) {
      initial = {
        name: ENV_SYSTEM_NAME, url: sapUrl, user: sapUser, password: sapPassword,
        client: sapClient || process.env.SAP_CLIENT, language: sapLanguage || process.env.SAP_LANGUAGE,
        insecureTls: process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0', source: 'env',
      };
    } else {
      initial = initialSystem(loadRegistry());
    }

    this.adtClient = this.buildClient(initial);
    this.activeSystem = initial;
    this.sourceHandlers = this.objectHandlers = this.runHandlers = this.transportHandlers = undefined as any;
    this.dataHandlers = this.qualityHandlers = this.gitHandlers = this.systemHandlers = this.dynproHandlers = undefined as any;
    this.buildHandlers();

    this.setupHandlers();
  }

  /** Create an ADT client for a system (or an inert placeholder when none is connected yet). */
  private buildClient(sys?: SystemDef): ADTClient {
    const client = sys
      ? new ADTClient(sys.url, sys.user, sys.password, sys.client, sys.language,
          sys.insecureTls ? createSSLConfig(true) : undefined)
      : new ADTClient('http://not-connected.invalid', '_NONE_', '_NONE_');
    client.stateful = session_types.stateful;
    return client;
  }

  /** (Re)create every handler around the current client and re-inject the server callbacks. */
  private buildHandlers(): void {
    this.trackLocks();

    this.sourceHandlers    = new SourceHandlers(this.adtClient);
    this.objectHandlers    = new ObjectHandlers(this.adtClient);
    this.runHandlers       = new RunHandlers(this.adtClient);
    this.transportHandlers = new TransportHandlers(this.adtClient);
    this.dataHandlers      = new DataHandlers(this.adtClient);
    this.qualityHandlers   = new QualityHandlers(this.adtClient);
    this.gitHandlers       = new GitHandlers(this.adtClient);
    this.systemHandlers    = new SystemHandlers(this.adtClient);
    this.dynproHandlers    = new DynproHandlers(this.adtClient, this.runHandlers);

    const elicitFn = (params: any) => this.elicitInput(params);

    const notifyFn = async (level: 'info' | 'warning' | 'error', message: string) => {
      await this.sendLoggingMessage({ level, data: message });
    };

    const samplingFn = async (systemPrompt: string, userMessage: string, maxTokens = 200): Promise<string> => {
      const caps = this.getClientCapabilities();
      if (!(caps as any)?.sampling) {
        throw new Error('Client does not support sampling');
      }
      const result = await this.createMessage({
        messages: [{ role: 'user', content: { type: 'text', text: userMessage } }],
        systemPrompt,
        maxTokens,
        includeContext: 'none',
      });
      return result.content.type === 'text' ? result.content.text : '';
    };

    for (const handler of this.allHandlers()) {
      handler.setElicit(elicitFn);
      handler.setNotify(notifyFn);
      handler.setSampling(samplingFn);
    }
  }

  /**
   * Switch the active SAP system. Hands the previous session back first (locks + logout) so a
   * switch never strands an enqueue entry on the system we are leaving.
   */
  private async switchSystem(sys: SystemDef | undefined, releasePrevious = true): Promise<void> {
    if (releasePrevious && this.activeSystem) await this.releaseSapSession();
    this.heldLocks.clear();
    this.adtClient = this.buildClient(sys);
    this.activeSystem = sys;
    this.buildHandlers();
  }

  private async handleSapSystems(): Promise<any> {
    const reg = loadRegistry();
    return {
      status: 'success',
      active: this.activeSystem?.name ?? null,
      systemsFile: reg.file,
      ...(reg.fileExists ? {} : { note: 'Systems file not found — create it to manage systems centrally.' }),
      ...(reg.fileError ? { fileError: reg.fileError } : {}),
      systems: [...reg.systems.values()].map(s => describeSystem(s, this.activeSystem?.name)),
    };
  }

  private async handleSapConnect(args: any): Promise<any> {
    const reg = loadRegistry();
    if (reg.fileError) throw new McpError(ErrorCode.InternalError, `Systems file is invalid — ${reg.fileError}`);
    const { match, candidates } = findSystem(reg, String(args?.system || ''));
    if (!match) {
      const all = [...reg.systems.keys()].join(', ') || '(none defined)';
      throw new McpError(ErrorCode.InvalidParams,
        candidates.length > 1
          ? `"${args?.system}" is ambiguous: ${candidates.join(', ')}. Pass the exact name.`
          : `Unknown system "${args?.system}". Available: ${all}. File: ${reg.file}`);
    }
    if (!match.password) {
      throw new McpError(ErrorCode.InvalidParams, `System "${match.name}" has no password configured in ${reg.file}.`);
    }

    const previous = this.activeSystem;
    await this.switchSystem(match);
    try {
      await this.adtClient.login();
    } catch (e: any) {
      // Do not leave the session pointing at a system we could not reach: fall back to the
      // previous one so the next tool call does not silently hit a dead connection.
      const reason = e?.message || String(e);
      await this.switchSystem(previous, false);
      throw new McpError(ErrorCode.InternalError,
        `Could not connect to "${match.name}" (${match.url}): ${reason}. ` +
        `Active system is still: ${previous?.name ?? 'none'}.`);
    }

    // Client role straight from the system — tells a productive client apart before any write.
    const identity: Record<string, any> = {};
    try {
      const q: any = await this.adtClient.runQuery(
        "SELECT MANDT, MTEXT, CCCATEGORY FROM T000 WHERE MANDT = '" + (match.client || '').replace(/[^0-9]/g, '') + "'", 1);
      const row: any = q?.values?.[0];
      if (row) {
        const roles: Record<string, string> = { P: 'PRODUCTIVE', T: 'test', C: 'customizing', D: 'demo', E: 'training', S: 'SAP reference' };
        identity.clientText = row.MTEXT;
        identity.clientRole = roles[row.CCCATEGORY] || row.CCCATEGORY;
      }
    } catch (_) { /* no authorization for T000 — identity stays partial */ }

    return {
      status: 'success',
      connected: match.name,
      previous: previous?.name ?? null,
      url: match.url,
      client: match.client,
      user: match.user,
      readOnly: !!match.readOnly,
      ...identity,
      ...(identity.clientRole === 'PRODUCTIVE' && !match.readOnly
        ? { warning: 'This client is PRODUCTIVE and the system is not marked readOnly in the systems file.' }
        : {}),
    };
  }

  /** Refuse work that must not happen on the current system (none connected / readOnly). */
  private guard(name: string, args: any, tool?: { annotations?: { readOnlyHint?: boolean } }): void {
    if (!this.activeSystem) {
      const names = [...loadRegistry().systems.keys()].join(', ') || '(none defined)';
      throw new McpError(ErrorCode.InvalidRequest,
        `No SAP system is connected. Call sap_connect first. Available systems: ${names}`);
    }
    if (!this.activeSystem.readOnly) return;
    if (tool?.annotations?.readOnlyHint || READ_ONLY_EXEMPT.has(name)) return;
    if (name === 'raw_http' && String(args?.method || '').toUpperCase() === 'GET') return;
    throw new McpError(ErrorCode.InvalidRequest,
      `System "${this.activeSystem.name}" is readOnly — "${name}" is refused. ` +
      `Change readOnly in the systems file if writes are intended.`);
  }

  private allHandlers() {
    return [
      this.sourceHandlers, this.objectHandlers, this.runHandlers,
      this.transportHandlers, this.dataHandlers, this.qualityHandlers,
      this.gitHandlers, this.systemHandlers, this.dynproHandlers,
    ];
  }

  private setupHandlers() {
    this.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...CONNECTION_TOOLS, ...this.allHandlers().flatMap(h => h.getTools())]
    }));

    this.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: PROMPTS.map(p => ({ name: p.name, description: p.description }))
    }));

    this.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const p = PROMPTS.find(p => p.name === request.params.name);
      if (!p) throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${request.params.name}`);
      const args = request.params.arguments || {};
      return { messages: p.messages(args) };
    });

    this.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name === 'sap_systems' || name === 'sap_connect') {
        const data = name === 'sap_systems' ? await this.handleSapSystems() : await this.handleSapConnect(args);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      for (const handler of this.allHandlers()) {
        const tool = handler.getTools().find(t => t.name === name);
        if (tool) {
          this.guard(name, args, tool);
          const system = this.activeSystem!.name;
          try {
            const result = await handler.validateAndHandle(name, args || {});
            if (result?.content) {
              // Stamp every modifying call with the system it ran on, so a write to the wrong
              // system is visible in the very response that performed it.
              if (!tool.annotations?.readOnlyHint && Array.isArray(result.content)) {
                result.content.push({ type: 'text', text: `[sap system: ${system}]` });
              }
              return result;
            }
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(result, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)
              }]
            };
          } catch (error: any) {
            if (error instanceof McpError) throw error;
            throw new McpError(ErrorCode.InternalError, error.message || 'Unknown error');
          }
        }
      }

      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    });
  }

  /**
   * Wrap lock/unLock on the shared client so the server always knows which objects it holds.
   *
   * Without this, closing the Claude Code window leaves any in-flight lock on SAP's enqueue
   * server until SAP's own session reaper runs — minutes later. The next session then hits
   * "object is locked by user X" where X is the same developer. Wrapping the client instead of
   * each call site means no lock path can be missed (ObjectHandlers, RunHandlers, SourceHandlers
   * all lock directly on adtclient).
   *
   * deleteObject is wrapped too: a delete releases its lock implicitly, so the entry must be
   * forgotten or shutdown would try to unlock an object that no longer exists.
   */
  private trackLocks(): void {
    const client = this.adtClient as any;
    const origLock = client.lock.bind(client);
    const origUnlock = client.unLock.bind(client);
    const origDelete = client.deleteObject.bind(client);

    client.lock = async (objectUrl: string, accessMode?: string) => {
      const result = await origLock(objectUrl, accessMode);
      if (result?.LOCK_HANDLE) this.heldLocks.set(objectUrl, result.LOCK_HANDLE);
      return result;
    };

    // Only forget the lock when the unlock actually succeeded. A failed unLock (dead session)
    // means the enqueue entry is still out there — keep it so shutdown gets one more attempt
    // on a freshly logged-in session.
    client.unLock = async (objectUrl: string, lockHandle: string) => {
      const result = await origUnlock(objectUrl, lockHandle);
      this.heldLocks.delete(objectUrl);
      return result;
    };

    client.deleteObject = async (objectUrl: string, lockHandle: string, transport?: string) => {
      const result = await origDelete(objectUrl, lockHandle, transport);
      this.heldLocks.delete(objectUrl);
      return result;
    };
  }

  /**
   * Hand the SAP session back before the process exits: release outstanding locks, then log out.
   *
   * The logout is the important half. MCP's close() only tears down the stdio transport — the
   * stateful ICM session stays alive on SAP, and an ADT lock is bound to that session, not just
   * to the enqueue table. That is why a lock can survive even after SM12 looks clean.
   */
  private async releaseSapSession(): Promise<void> {
    if (this.heldLocks.size > 0) {
      // Re-login stateful first: the lock handles are only valid inside a live stateful session,
      // and whatever killed the previous one is often why we still hold these.
      try {
        this.adtClient.stateful = session_types.stateful;
        await this.adtClient.login();
      } catch (_) { /* best-effort — try the unlocks anyway */ }

      for (const [objectUrl, lockHandle] of this.heldLocks) {
        try {
          await this.adtClient.unLock(objectUrl, lockHandle);
          console.error(`[SHUTDOWN] released lock on ${objectUrl}`);
        } catch (e: any) {
          console.error(`[SHUTDOWN] could not release lock on ${objectUrl}: ${e?.message || e} ` +
            `— use abap_unlock on the next session if it stays blocked`);
        }
      }
      this.heldLocks.clear();
    }

    try {
      await this.adtClient.logout();
      console.error('[SHUTDOWN] SAP session ended');
    } catch (e: any) {
      console.error(`[SHUTDOWN] logout failed: ${e?.message || e}`);
    }
  }

  /** MCP Server.close(), extended to end the SAP session instead of abandoning it. */
  async close(): Promise<void> {
    await this.releaseSapSession();
    await super.close();
  }

  /** Run in stdio mode (default). Requires SAP_USER/SAP_PASSWORD in env. */
  async runStdio() {
    const transport = new StdioServerTransport();
    await this.connect(transport);
    const clientCaps = this.getClientCapabilities();
    console.error('dassian-adt v2.0 running on stdio');
    console.error('Client capabilities:', JSON.stringify(clientCaps, null, 2));

    // Shut down cleanly on every route the client can take us down by. On Windows, Claude Code
    // usually ends a stdio server by closing our stdin rather than signalling, so 'end' matters
    // at least as much as SIGINT/SIGTERM here. Guarded against re-entry and against a hung
    // network call — a stuck logout must not stop the process from exiting.
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        await Promise.race([
          this.close(),
          new Promise(resolve => setTimeout(resolve, 5000)),
        ]);
      } catch (e: any) {
        console.error(`[SHUTDOWN] ${e?.message || e}`);
      }
      process.exit(0);
    };

    process.on('SIGINT',  shutdown);
    process.on('SIGTERM', shutdown);
    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
  }
}

// ─── HTTP mode: per-user auth via browser login page ────────────────────────

interface HttpSession {
  transport: StreamableHTTPServerTransport;
  server: AbapAdtServer;
}

/** Pending sessions waiting for the user to log in via the browser. */
interface PendingSession {
  transport: StreamableHTTPServerTransport;
  sessionId: string;
}

function parseFormBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const params: Record<string, string> = {};
      for (const pair of body.split('&')) {
        const [key, val] = pair.split('=').map(decodeURIComponent);
        if (key) params[key] = val || '';
      }
      resolve(params);
    });
    req.on('error', reject);
  });
}

async function runHttp() {
  const sapUrl = process.env.SAP_URL;
  if (!sapUrl) throw new Error('SAP_URL is required even in HTTP mode (all users connect to the same SAP system).');

  const port = parseInt(process.env.MCP_HTTP_PORT || '3000', 10);
  const mcpPath = process.env.MCP_HTTP_PATH || '/mcp';
  const sapClient = process.env.SAP_CLIENT;
  const sapLanguage = process.env.SAP_LANGUAGE;

  // Shared service account (optional fallback — if SAP_USER + SAP_PASSWORD are set, skip login page)
  const sharedUser = process.env.SAP_USER;
  const sharedPass = process.env.SAP_PASSWORD;
  const requireLogin = !sharedUser || !sharedPass;

  const sessions = new Map<string, HttpSession>();
  // Pending sessions: MCP handshake done, but user hasn't logged in yet
  const pendingSessions = new Map<string, PendingSession>();
  // Session → SAP credentials (set after user logs in via /login)
  const sessionCredentials = new Map<string, { user: string; password: string }>();

  if (requireLogin) {
    console.error('[HTTP] Per-user auth mode: users will log in via /login page');
  } else {
    console.error(`[HTTP] Shared service account mode: ${sharedUser}`);
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── Health check ──
    if (reqUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        sessions: sessions.size,
        pendingLogins: pendingSessions.size,
        authMode: requireLogin ? 'per-user' : 'shared'
      }));
      return;
    }

    // ── Login page (GET) ──
    if (reqUrl.pathname === '/login' && req.method === 'GET') {
      const sessionId = reqUrl.searchParams.get('session') || '';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderLoginPage(sapUrl!, sessionId));
      return;
    }

    // ── Login submit (POST) ──
    if (reqUrl.pathname === '/login' && req.method === 'POST') {
      const body = await parseFormBody(req);
      const sessionId = body.session || '';
      const username = body.username?.trim();
      const password = body.password;

      if (!username || !password) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderLoginPage(sapUrl!, sessionId, 'Username and password are required.'));
        return;
      }

      // Validate credentials by attempting an ADT login
      try {
        const testClient = new ADTClient(sapUrl!, username, password, sapClient, sapLanguage);
        testClient.stateful = session_types.stateful;
        await testClient.login();
        await testClient.logout();
      } catch (e: any) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderLoginPage(sapUrl!, sessionId, `SAP login failed: ${e.message || 'Invalid credentials'}`));
        return;
      }

      // Store credentials for this session
      sessionCredentials.set(sessionId, { user: username, password });
      console.error(`[HTTP] User ${username} authenticated for session ${sessionId}`);

      // If there's a pending session, promote it to active
      const pending = pendingSessions.get(sessionId);
      if (pending) {
        try {
          const server = new AbapAdtServer(sapUrl!, username, password, sapClient, sapLanguage);
          await server.connect(pending.transport);
          sessions.set(sessionId, { transport: pending.transport, server });
          pendingSessions.delete(sessionId);
          console.error(`[HTTP] Session ${sessionId} activated for ${username} (${sessions.size} active)`);
        } catch (err: any) {
          console.error(`[HTTP] Failed to activate session ${sessionId}: ${err.message}`);
        }
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderLoginSuccess());
      return;
    }

    // ── MCP endpoint ──
    if (reqUrl.pathname !== mcpPath && !reqUrl.pathname.startsWith(mcpPath + '?')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Existing active session
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
      return;
    }

    // Existing pending session — user hasn't logged in yet.
    // Allow DELETE through so the MCP client can terminate the session cleanly
    // (triggers onclose, which cleans up pendingSessions/sessionCredentials).
    // All other methods get a 401 directing the user to the login page.
    if (sessionId && pendingSessions.has(sessionId)) {
      if (req.method === 'DELETE') {
        const pending = pendingSessions.get(sessionId)!;
        await pending.transport.handleRequest(req, res);
        return;
      }
      const loginUrl = `/login?session=${encodeURIComponent(sessionId)}`;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Authentication required',
        message: `SAP login required. Open ${loginUrl} in your browser to connect, then retry.`,
        loginUrl
      }));
      return;
    }

    // Invalid session
    if (sessionId && !sessions.has(sessionId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    // New session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    if (!requireLogin) {
      // Shared service account — create server immediately
      const server = new AbapAdtServer(sapUrl!, sharedUser!, sharedPass!, sapClient, sapLanguage);
      await server.connect(transport);
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          console.error(`[HTTP] Session closed: ${transport.sessionId} (${sessions.size} active)`);
        }
      };
      await transport.handleRequest(req, res);
      if (transport.sessionId) {
        sessions.set(transport.sessionId, { transport, server });
        console.error(`[HTTP] New session: ${transport.sessionId} [${sharedUser}] (${sessions.size} active)`);
      }
    } else {
      // Per-user auth — the MCP handshake needs a real server to negotiate the session ID.
      // Check if the user already authenticated (login-before-connect race).
      // If not, use a temporary server for the handshake, then park the session as pending.
      // Subsequent requests on a pending session get a clear 401 + login URL (handled above).

      // For the initial handshake we need a connected server. The handshake itself (initialize,
      // listTools) doesn't touch SAP, so dummy creds are fine for this single request.
      const handshakeServer = new AbapAdtServer(sapUrl!, '_HANDSHAKE_', '_HANDSHAKE_', sapClient, sapLanguage);
      await handshakeServer.connect(transport);

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          pendingSessions.delete(transport.sessionId);
          sessionCredentials.delete(transport.sessionId);
          console.error(`[HTTP] Session closed: ${transport.sessionId}`);
        }
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        // Check if user already logged in (race condition: login before MCP connect)
        const creds = sessionCredentials.get(transport.sessionId);
        if (creds) {
          const realServer = new AbapAdtServer(sapUrl!, creds.user, creds.password, sapClient, sapLanguage);
          await realServer.connect(transport);
          sessions.set(transport.sessionId, { transport, server: realServer });
          console.error(`[HTTP] New session: ${transport.sessionId} [${creds.user}] (${sessions.size} active)`);
        } else {
          pendingSessions.set(transport.sessionId, { transport, sessionId: transport.sessionId });
          console.error(`[HTTP] Pending login: ${transport.sessionId} — user must visit /login?session=${transport.sessionId}`);
        }
      }
    }
  });

  httpServer.listen(port, () => {
    console.error(`dassian-adt v2.0 running on http://0.0.0.0:${port}${mcpPath}`);
    console.error(`Login page: http://0.0.0.0:${port}/login`);
    console.error(`Health check: http://0.0.0.0:${port}/health`);
    console.error(`SAP system: ${sapUrl}`);
    if (requireLogin) {
      console.error('Auth mode: per-user (users log in via /login page)');
    } else {
      console.error(`Auth mode: shared service account (${sharedUser})`);
    }
  });

  process.on('SIGINT',  () => { httpServer.close(); process.exit(0); });
  process.on('SIGTERM', () => { httpServer.close(); process.exit(0); });
}

// ─── Entry point ────────────────────────────────────────────────────────────

const mode = process.env.MCP_TRANSPORT || 'stdio';

if (mode === 'http') {
  runHttp().catch(console.error);
} else {
  // Stdio mode — system comes from SAP_* env, the systems file default, or a later sap_connect
  const server = new AbapAdtServer();
  server.runStdio().catch(console.error);
}
