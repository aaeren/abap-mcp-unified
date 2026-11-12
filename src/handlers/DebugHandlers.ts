import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ADTClient, session_types } from 'abap-adt-api';
import { randomBytes } from 'crypto';
import { BaseHandler } from './BaseHandler.js';
import { RunHandlers } from './RunHandlers.js';
import { buildObjectUrl, buildSourceUrl } from '../lib/urlBuilder.js';
import { formatError } from '../lib/errors.js';
import type { ToolDefinition } from '../types/tools.js';

type Phase = 'idle' | 'listening' | 'attached' | 'ended' | 'error';

interface Trigger {
  kind: string;
  startedAt: number;
  done: boolean;
  result?: any;
  error?: string;
}

/**
 * ABAP debugger over the ADT debugger resources (the same ones Eclipse uses).
 *
 * The ADT model is "listen, then attach": a listener long-polls until a session of the user hits
 * an external breakpoint, then the debugger attaches to that debuggee. An MCP tool call must
 * return quickly, so the long-poll runs in the BACKGROUND on a dedicated stateful session and
 * the tools report / advance a small state machine:
 *
 *   idle ─debug_listen→ listening ─(breakpoint hit, auto-attach)→ attached ─step/continue→ … → ended
 *
 * Three SAP sessions are involved and must stay separate:
 *   - main client     : everything else (source, breakpoints are set from here)
 *   - debug client    : listener + attach + step + variables (stateful, owns the debuggee)
 *   - trigger client  : runs the code under test asynchronously; its request BLOCKS while the
 *                       debuggee is stopped, which is why it can share neither of the others.
 */
export class DebugHandlers extends BaseHandler {
  private readonly newClient: () => ADTClient;
  private readonly user: string;
  private readonly terminalId = randomBytes(16).toString('hex').toUpperCase();
  private readonly ideId = randomBytes(16).toString('hex').toUpperCase();
  private readonly clientId = `mcp-${randomBytes(4).toString('hex')}`;

  private dbg?: ADTClient;
  private phase: Phase = 'idle';
  private phaseInfo = '';
  private listenSeq = 0;
  private breakpoints: any[] = [];
  private bpSpecs: string[] = [];
  private position?: any;
  private trigger?: Trigger;
  private triggerClient?: ADTClient;
  private waiters: Array<() => void> = [];

  constructor(adtclient: ADTClient, newClient: () => ADTClient, user: string) {
    super(adtclient);
    this.newClient = newClient;
    this.user = (user || '').toUpperCase();
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'debug_breakpoints',
        description:
          'Manage external (user) breakpoints for the ABAP debugger. action="set" REPLACES the breakpoint list with ' +
          'the given ones; "list" shows them; "clear" removes all. Each breakpoint: {name, type, line} — line numbers ' +
          'are those of abap_get_source for that object (for a report with includes, set the breakpoint on the include, ' +
          'type PROG/I). Optional condition, e.g. "LV_COUNT > 10". Breakpoints only fire on executable statements, and ' +
          'only in sessions of your own SAP user. Set breakpoints BEFORE debug_listen.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['set', 'list', 'clear'], description: 'set | list | clear' } as any,
            breakpoints: {
              type: 'array',
              description: 'For action=set: [{name, type, line, condition?}]',
              items: {
                type: 'object',
                properties: { name: { type: 'string' }, type: { type: 'string' }, line: { type: 'number' }, condition: { type: 'string' } },
                required: ['name', 'type', 'line']
              }
            } as any
          },
          required: ['action']
        }
      },
      {
        name: 'debug_listen',
        description:
          'Start the debugger listener in the background and return immediately. While listening, any session of your ' +
          'SAP user that hits a breakpoint is caught and attached automatically. Then make the code run: either pass ' +
          '"trigger" here, or run it yourself (SAP GUI /h-less F8, a unit test, an HTTP/RFC call by the same user). ' +
          'trigger options: {kind:"unit_test", name, type} runs the ABAP Unit tests of an object; ' +
          '{kind:"abap", code} runs an ABAP snippet (same as abap_run — e.g. SUBMIT zreport AND RETURN, or a method call). ' +
          'The trigger runs asynchronously and its result appears in debug_status once the debuggee finishes. ' +
          'Next: call debug_status (with wait_seconds) until phase="attached".',
        inputSchema: {
          type: 'object',
          properties: {
            trigger: {
              type: 'object',
              description: 'Optional: what to run once listening. {kind:"unit_test", name, type} or {kind:"abap", code}',
              properties: { kind: { type: 'string' }, name: { type: 'string' }, type: { type: 'string' }, code: { type: 'string' } }
            } as any,
            system_debugging: { type: 'boolean', description: 'Also stop in SAP system programs (default false).' }
          }
        }
      },
      {
        name: 'debug_status',
        description:
          'Current debugger state: phase (idle | listening | attached | ended | error), the current position ' +
          '(program, include, line) with the call stack when attached, and the trigger result when finished. ' +
          'wait_seconds (max 50) blocks until the phase changes — use it instead of polling.',
        inputSchema: {
          type: 'object',
          properties: { wait_seconds: { type: 'number', description: 'Wait up to N seconds for a phase change (default 0, max 50).' } }
        }
      },
      {
        name: 'debug_step',
        description:
          'Advance the attached debuggee: into (F5), over (F6), return (F7), continue (F8, runs to the next breakpoint ' +
          'or to the end), terminate (abort the debuggee). Returns the new position. When the program ends, ' +
          'phase becomes "ended".',
        inputSchema: {
          type: 'object',
          properties: { action: { type: 'string', enum: ['into', 'over', 'return', 'continue', 'terminate'], description: 'Step type' } as any },
          required: ['action']
        }
      },
      {
        name: 'debug_variables',
        description:
          'Read variables at the current stop. Without arguments returns the local variables of the current frame. ' +
          'names: specific variables or expressions (e.g. ["LV_COUNT", "LS_ALV-BUKRS", "SY-SUBRC", "LT_DATA[1]"]). ' +
          'scope: "locals" (default) or "globals". expand: the id of a structure / table / object variable returned ' +
          'earlier, to list its components or rows. Values are truncated by SAP for long content.',
        inputSchema: {
          type: 'object',
          properties: {
            names: { type: 'array', description: 'Variable names / expressions', items: { type: 'string' } } as any,
            scope: { type: 'string', enum: ['locals', 'globals'], description: 'locals (default) or globals' } as any,
            expand: { type: 'string', description: 'Variable id to expand (structure components / table rows, 50 rows per call)' },
            from_row: { type: 'number', description: 'With expand on a table: first row to return (default 1).' }
          }
        }
      },
      {
        name: 'debug_set_variable',
        description: 'Change the value of a variable in the attached debuggee (like editing a value in the debugger).',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Variable name' }, value: { type: 'string', description: 'New value' } },
          required: ['name', 'value']
        }
      },
      {
        name: 'debug_stop',
        description:
          'End the debug session: terminates the debuggee if still attached (unless keep_running=true lets it continue), ' +
          'stops the listener, removes all breakpoints and closes the debugger SAP session. Always call this when done — ' +
          'a forgotten listener keeps catching your own SAP GUI sessions.',
        inputSchema: {
          type: 'object',
          properties: { keep_running: { type: 'boolean', description: 'Let the debuggee continue instead of terminating it.' } }
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    try {
      switch (toolName) {
        case 'debug_breakpoints':  return await this.handleBreakpoints(args);
        case 'debug_listen':       return await this.handleListen(args);
        case 'debug_status':       return await this.handleStatus(args);
        case 'debug_step':         return await this.handleStep(args);
        case 'debug_variables':    return await this.handleVariables(args);
        case 'debug_set_variable': return await this.handleSetVariable(args);
        case 'debug_stop':         return await this.handleStop(args);
        default: throw new McpError(ErrorCode.MethodNotFound, `Unknown debug tool: ${toolName}`);
      }
    } catch (error: any) {
      if (error instanceof McpError) throw error;
      this.fail(formatError(toolName, error));
    }
  }

  // ── state helpers ──────────────────────────────────────────────────────────

  private setPhase(p: Phase, info = ''): void {
    this.phase = p;
    this.phaseInfo = info;
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  private waitForChange(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      this.waiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  private async debugClient(): Promise<ADTClient> {
    if (!this.dbg) {
      const c = this.newClient();
      c.stateful = session_types.stateful;
      await c.login();
      this.dbg = c;
    }
    return this.dbg;
  }

  private requireAttached(tool: string): ADTClient {
    if (this.phase !== 'attached' || !this.dbg) {
      this.fail(`${tool}: no debuggee is attached (phase=${this.phase}). ` +
        (this.phase === 'listening' ? 'Wait with debug_status until a breakpoint is hit.' : 'Start with debug_breakpoints + debug_listen.'));
    }
    return this.dbg!;
  }

  private frame(s: any) {
    return {
      position: s.stackPosition,
      program: s.programName,
      include: s.includeName,
      line: s.line,
      event: [s.eventType, s.eventName].filter(Boolean).join(' '),
      ...(s.systemProgram ? { system_program: true } : {}),
    };
  }

  private async refreshPosition(): Promise<void> {
    if (!this.dbg) return;
    try {
      const st: any = await this.dbg.debuggerStackTrace(false);
      const stack = (st?.stack || []).map((s: any) => this.frame(s));
      // ADT lists the stack top-first on most releases; the current frame is the highest position.
      const top = stack.reduce((a: any, b: any) => (a && a.position >= b.position ? a : b), undefined);
      // Keep the answer small: the caller's own frames matter, the framework frames below do not.
      const own = stack.filter((f: any) => !f.system_program).sort((a: any, b: any) => b.position - a.position);
      this.position = {
        ...(top || {}),
        stack: own.slice(0, 8).map((f: any) => `${f.include || f.program}:${f.line} ${f.event}`.trim()),
        stack_depth: stack.length,
      };
    } catch (e: any) {
      this.position = { note: `stack not available: ${e?.message || e}` };
    }
  }

  private snapshot(): Record<string, any> {
    const t = this.trigger;
    return {
      phase: this.phase,
      ...(this.phaseInfo ? { info: this.phaseInfo } : {}),
      breakpoints: this.bpSpecs,
      ...(this.phase === 'attached' && this.position ? { at: this.position } : {}),
      ...(t ? {
        trigger: {
          kind: t.kind,
          state: t.done ? (t.error ? 'failed' : 'finished')
            : this.phase === 'attached' ? 'running (blocked while the debuggee is stopped)' : 'running',
          ...(t.done && t.error ? { error: t.error } : {}),
          ...(t.done && !t.error ? { result: t.result } : {}),
        }
      } : {}),
    };
  }

  // ── breakpoints ────────────────────────────────────────────────────────────

  private async syncBreakpoints(specs: Array<{ uri: string; condition?: string }>, systemDebugging = false): Promise<any[]> {
    // Breakpoints are synchronised from the MAIN session: the debug session may be busy long-polling.
    // With a condition the library wants its DebugBreakpoint shape (uri split into path + line).
    const xml = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const bps = specs.map(s => {
      if (!s.condition) return s.uri;
      const [path, line] = s.uri.split('#start=');
      return {
        kind: 'line', clientId: this.clientId, condition: xml(s.condition),
        uri: { uri: path, range: { start: { line: Number(line), column: 0 }, end: { line: Number(line), column: 0 } } },
      } as any;
    });
    const res: any[] = await this.withSession(() => (this.adtclient as any).debuggerSetBreakpoints(
      'user', this.terminalId, this.ideId, this.clientId, bps, this.user, 'external', systemDebugging, false, ''));
    return res || [];
  }

  private async handleBreakpoints(args: any): Promise<any> {
    const action = String(args.action || '').toLowerCase();
    if (action === 'list') {
      return this.success({ breakpoints: this.bpSpecs, count: this.bpSpecs.length });
    }
    if (action === 'clear') {
      if (this.bpSpecs.length) await this.syncBreakpoints([]);
      this.breakpoints = []; this.bpSpecs = [];
      return this.success({ cleared: true });
    }
    if (action !== 'set') this.fail('debug_breakpoints: action must be set, list or clear.');

    const list = Array.isArray(args.breakpoints) ? args.breakpoints : [];
    if (!list.length) this.fail('debug_breakpoints: breakpoints must be a non-empty array for action=set (use action=clear to remove all).');
    const specs = list.map((b: any, i: number) => {
      if (!b?.name || !b?.type || !Number(b?.line)) this.fail(`breakpoints[${i}] needs name, type and line.`);
      const src = buildSourceUrl(String(b.name), String(b.type));
      return {
        uri: `${src}#start=${Number(b.line)}`,
        label: `${String(b.name).toUpperCase()} (${String(b.type).toUpperCase()}) line ${Number(b.line)}`,
        condition: b.condition ? String(b.condition) : undefined,
      };
    });

    const res = await this.syncBreakpoints(specs);
    // The server does not answer in request order, so match accepted breakpoints by source + line.
    const accepted = new Set(res.filter((r: any) => !r?.errorMessage && r?.uri)
      .map((r: any) => `${String(r.uri.uri).toLowerCase()}#${r.uri.range?.start?.line}`));
    const errors = res.filter((r: any) => r?.errorMessage).map((r: any) => String(r.errorMessage));
    const ok: string[] = [];
    const rejected: string[] = [];
    for (const s of specs) {
      const [path, line] = s.uri.split('#start=');
      if (accepted.has(`${path.toLowerCase()}#${line}`)) ok.push(s.label + (s.condition ? ` if ${s.condition}` : ''));
      else rejected.push(s.label);
    }
    const failed = rejected.map((b, i) => ({ breakpoint: b, error: rejected.length === errors.length ? errors[i] : errors.join(' | ') || 'not accepted by the system' }));
    this.breakpoints = res.filter((r: any) => !r?.errorMessage);
    this.bpSpecs = ok;
    return this.success({
      set: ok.length, breakpoints: ok,
      ...(failed.length ? { failed, hint: 'A breakpoint must be on an executable statement of an ACTIVE object; check the line with abap_get_source.' } : {}),
    });
  }

  // ── listen / attach ────────────────────────────────────────────────────────

  private async handleListen(args: any): Promise<any> {
    if (this.phase === 'listening') this.fail('debug_listen: already listening. Use debug_status, or debug_stop to cancel.');
    if (this.phase === 'attached') this.fail('debug_listen: a debuggee is attached. Finish it with debug_step (continue/terminate) or debug_stop.');
    if (!this.bpSpecs.length) this.fail('debug_listen: no breakpoints are set — the listener would never stop. Call debug_breakpoints first.');

    const client = await this.debugClient();
    if (args.system_debugging === true) {
      try { await client.debuggerSaveSettings({ systemDebugging: true } as any); } catch (_) { /* applied on attach instead */ }
    }

    // Refuse to fight another debugger (Eclipse / a second MCP) listening for the same user.
    const conflict: any = await (client as any).debuggerListeners('user', this.terminalId, this.ideId, this.user, true).catch(() => undefined);
    if (conflict?.message?.text || conflict?.conflictText) {
      this.fail(`debug_listen: another debugger is already listening for user ${this.user}: ` +
        `${conflict.conflictText || conflict.message.text}. Stop it first (Eclipse debug session / other MCP).`);
    }

    this.trigger = undefined;
    this.position = undefined;
    const seq = ++this.listenSeq;
    this.setPhase('listening');

    // Background long-poll. Never awaited by the tool call.
    (client as any).debuggerListen('user', this.terminalId, this.ideId, this.user, true, true)
      .then(async (d: any) => {
        if (seq !== this.listenSeq || this.phase !== 'listening') return;   // cancelled meanwhile
        if (!d) { this.setPhase('idle', 'listener ended without a debuggee'); return; }
        if (!d.DEBUGGEE_ID) {
          this.setPhase('error', d.conflictText || d.message?.text || 'listener reported an error');
          return;
        }
        try {
          await (client as any).debuggerAttach('user', d.DEBUGGEE_ID, this.user, true);
          if (args.system_debugging === true) {
            try { await client.debuggerSaveSettings({ systemDebugging: true } as any); } catch (_) {}
          }
          await this.refreshPosition();
          this.setPhase('attached');
        } catch (e: any) {
          this.setPhase('error', `attach failed: ${e?.message || e}`);
        }
      })
      .catch((e: any) => {
        if (seq !== this.listenSeq) return;
        if (this.phase === 'listening') this.setPhase('error', `listener failed: ${e?.message || e}`);
      });

    let triggerNote: string | undefined;
    if (args.trigger) {
      // Give the listener a moment to register on the server before the code starts running.
      await new Promise(r => setTimeout(r, 1500));
      triggerNote = this.startTrigger(args.trigger);
    }

    return this.success({
      phase: this.phase,
      breakpoints: this.bpSpecs,
      ...(triggerNote ? { trigger: triggerNote } : { next: `Run the code as SAP user ${this.user} (or pass trigger), then call debug_status with wait_seconds.` }),
    });
  }

  private startTrigger(t: any): string {
    const kind = String(t.kind || '').toLowerCase();
    const trig: Trigger = { kind, startedAt: Date.now(), done: false };
    const finish = (result?: any, error?: string) => {
      trig.done = true; trig.result = result; trig.error = error;
      // The trigger request only returns after the debuggee has finished (or was terminated).
      if (this.phase === 'attached' || this.phase === 'listening') {
        if (this.phase === 'listening') {
          this.listenSeq++;   // nothing was hit — abandon the long-poll
          this.cancelListener();
          this.setPhase('ended', 'the triggered code finished without hitting a breakpoint');
        } else {
          this.setPhase('ended', 'the debuggee finished');
        }
      }
      // Fire-and-forget: a rejected logout must never surface as an unhandled rejection.
      if (this.triggerClient === client) this.triggerClient = undefined;
      Promise.resolve().then(() => client.logout()).catch(() => undefined);
    };

    const client = this.newClient();
    client.stateful = session_types.stateful;
    this.triggerClient = client;

    let run: Promise<any>;
    if (kind === 'unit_test') {
      if (!t.name || !t.type) this.fail('trigger unit_test needs name and type.');
      const url = buildObjectUrl(String(t.name), String(t.type));
      run = client.login().then(() => client.unitTestRun(url)).then(r => summariseUnit(r));
    } else if (kind === 'abap') {
      if (!t.code) this.fail('trigger abap needs code.');
      const runner = new RunHandlers(client);
      run = client.login().then(() => runner.executeAbap(String(t.code), 'ZCL_TMP_DEBUG_TRIG')).then(o => ({ output: o }));
    } else {
      this.fail('trigger.kind must be "unit_test" or "abap".');
    }

    this.trigger = trig;
    run!.then(r => finish(r)).catch((e: any) => finish(undefined, e?.message || String(e)));
    return `${kind} started asynchronously`;
  }

  private cancelListener(): void {
    if (!this.dbg) return;
    // Deleting the listener must come from another session: the debug session is busy long-polling.
    (this.adtclient as any).debuggerDeleteListener('user', this.terminalId, this.ideId, this.user)
      .catch(() => undefined);
  }

  private async handleStatus(args: any): Promise<any> {
    const wait = Math.max(0, Math.min(50, Number(args?.wait_seconds) || 0));
    if (wait > 0 && (this.phase === 'listening' || (this.phase === 'attached' && false))) {
      await this.waitForChange(wait * 1000);
    }
    return this.success(this.snapshot());
  }

  // ── stepping ───────────────────────────────────────────────────────────────

  private async handleStep(args: any): Promise<any> {
    const client = this.requireAttached('debug_step');
    const map: Record<string, string> = {
      into: 'stepInto', over: 'stepOver', return: 'stepReturn', continue: 'stepContinue', terminate: 'terminateDebuggee'
    };
    const action = String(args.action || '').toLowerCase();
    const step = map[action];
    if (!step) this.fail('debug_step: action must be into, over, return, continue or terminate.');

    try {
      const res: any = await (client as any).debuggerStep(step);
      if (action === 'terminate') {
        this.setPhase('ended', 'debuggee terminated');
        return this.success(this.snapshot());
      }
      await this.refreshPosition();
      if (this.position?.note && !this.position?.program) {
        this.setPhase('ended', 'the debuggee finished');
        return this.success(this.snapshot());
      }
      return this.success({
        ...this.snapshot(),
        ...(res?.reachedBreakpoints?.length ? { stopped_at_breakpoint: true } : {}),
      });
    } catch (e: any) {
      // ADT answers a step past the end of the program with an error ("debuggee ended").
      const msg = String(e?.message || e);
      if (/ended|terminat|not attached|no debuggee|debuggeeEnded|invalidDebuggee/i.test(msg) ||
          /debuggeeEnded/i.test(String(e?.properties?.['com.sap.adt.communicationFramework.subType'] || ''))) {
        this.setPhase('ended', 'the debuggee finished');
        // let the trigger promise settle so its result is in the snapshot
        await new Promise(r => setTimeout(r, 800));
        return this.success(this.snapshot());
      }
      throw e;
    }
  }

  // ── variables ──────────────────────────────────────────────────────────────

  private variable(v: any) {
    const complex = ['structure', 'table', 'dataref', 'objectref', 'class', 'object', 'boxref'].includes(v.META_TYPE);
    return {
      name: v.NAME,
      ...(complex ? { id: v.ID } : {}),
      type: v.ACTUAL_TYPE_NAME || v.DECLARED_TYPE_NAME || v.TECHNICAL_TYPE,
      kind: v.META_TYPE,
      ...(v.META_TYPE === 'table' ? { rows: Number(v.TABLE_LINES) || 0 } : { value: String(v.VALUE ?? '').trimEnd() }),
      ...(v.IS_VALUE_INCOMPLETE === 'X' ? { truncated: true } : {}),
    };
  }

  private async handleVariables(args: any): Promise<any> {
    const client = this.requireAttached('debug_variables');
    if (args.expand) {
      const id = String(args.expand);
      // Internal tables have no child hierarchy — their rows are addressed as NAME[1], NAME[2], …
      const self: any[] = await client.debuggerVariables([id]).catch(() => []);
      const me = self?.[0];
      if (me?.META_TYPE === 'table') {
        const total = Number(me.TABLE_LINES) || 0;
        const from = Math.max(1, Number(args.from_row) || 1);
        const n = Math.min(50, Math.max(0, total - from + 1));
        const base = id.replace(/[]$/, '');
        const keys = Array.from({ length: n }, (_, i) => `${base}[${from + i}]`);
        const rows: any[] = keys.length ? await client.debuggerVariables(keys) : [];
        return this.success({
          expanded: id, kind: 'table', rows: total, from_row: from, returned: rows.length,
          variables: rows.map((v: any) => this.variable(v)),
          ...(total > from + n - 1 ? { hint: `more rows: call again with from_row=${from + n}` } : {}),
        });
      }
      const info: any = await client.debuggerChildVariables([id]);
      const vars = (info?.variables || []).map((v: any) => this.variable(v));
      return this.success({ expanded: id, count: vars.length, variables: vars.slice(0, 200) });
    }
    if (Array.isArray(args.names) && args.names.length) {
      const names = args.names.map((n: any) => String(n).toUpperCase());
      const vars: any[] = await client.debuggerVariables(names);
      return this.success({ variables: (vars || []).map((v: any) => this.variable(v)) });
    }
    const scope = String(args.scope || 'locals').toLowerCase() === 'globals' ? '@GLOBALS' : '@LOCALS';
    // The root lists the scopes; the scope node lists its variables.
    const info: any = await client.debuggerChildVariables(['@ROOT', scope]);
    const ids = new Set((info?.hierarchies || []).filter((h: any) => h.PARENT_ID === scope).map((h: any) => h.CHILD_ID));
    const vars = (info?.variables || []).filter((v: any) => ids.has(v.ID)).map((v: any) => this.variable(v));
    return this.success({ scope: scope.slice(1).toLowerCase(), at: this.position ? { program: this.position.program, include: this.position.include, line: this.position.line } : undefined, count: vars.length, variables: vars.slice(0, 200) });
  }

  private async handleSetVariable(args: any): Promise<any> {
    const client = this.requireAttached('debug_set_variable');
    const name = String(args.name || '').toUpperCase();
    const value = await client.debuggerSetVariableValue(name, String(args.value ?? ''));
    return this.success({ name, value: String(value ?? '').trimEnd() });
  }

  // ── stop / dispose ─────────────────────────────────────────────────────────

  private async handleStop(args: any): Promise<any> {
    const was = this.phase;
    await this.dispose(args?.keep_running === true);
    return this.success({ stopped: true, previous_phase: was, phase: this.phase });
  }

  /** Release everything this handler holds on the SAP system. Safe to call repeatedly. */
  async dispose(keepRunning = false): Promise<void> {
    const client: any = this.dbg;
    const was = this.phase;
    this.listenSeq++;
    if (client) {
      if (was === 'attached') {
        try { await client.debuggerStep(keepRunning ? 'stepContinue' : 'terminateDebuggee'); } catch (_) {}
      }
      if (was === 'listening') {
        // The debug session is blocked in the long-poll — cancel it from the main session.
        try { await (this.adtclient as any).debuggerDeleteListener('user', this.terminalId, this.ideId, this.user); } catch (_) {}
        await new Promise(r => setTimeout(r, 500));
      }
      try { await Promise.race([client.logout(), new Promise(r => setTimeout(r, 3000))]); } catch (_) {}
    }
    if (this.bpSpecs.length) {
      try {
        await (this.adtclient as any).debuggerSetBreakpoints(
          'user', this.terminalId, this.ideId, this.clientId, [], this.user, 'external', false, false, '');
      } catch (_) {}
    }
    // A still-running trigger is left to finish on its own session; its completion handler logs it out.
    this.triggerClient = undefined;
    this.dbg = undefined;
    this.breakpoints = []; this.bpSpecs = [];
    this.position = undefined;
    this.setPhase('idle');
  }
}

/** Compact ABAP Unit result shared by abap_unit_run and the debugger trigger. */
export function summariseUnit(classes: any[]): any {
  let methods = 0, failed = 0;
  const failures: any[] = [];
  const out = (classes || []).map((c: any) => {
    const ms = (c.testmethods || []).map((m: any) => {
      methods++;
      const alerts = (m.alerts || []).map((a: any) => ({
        kind: a.kind, severity: a.severity, title: a.title,
        details: (a.details || []).slice(0, 6),
        at: (a.stack || []).slice(0, 2).map((s: any) => s['adtcore:description'] || s['adtcore:name']),
      }));
      const bad = alerts.some((a: any) => a.kind !== 'warning');
      if (bad) { failed++; failures.push({ class: c['adtcore:name'], method: m['adtcore:name'], alerts }); }
      return { method: m['adtcore:name'], passed: !bad, ms: m.executionTime, ...(alerts.length ? { alerts } : {}) };
    });
    const classAlerts = (c.alerts || []).map((a: any) => ({ kind: a.kind, severity: a.severity, title: a.title, details: (a.details || []).slice(0, 6) }));
    if (classAlerts.some((a: any) => a.kind !== 'warning')) failures.push({ class: c['adtcore:name'], alerts: classAlerts });
    return { class: c['adtcore:name'], risk: c.riskLevel, duration: c.durationCategory, methods: ms, ...(classAlerts.length ? { alerts: classAlerts } : {}) };
  });
  return { test_classes: out.length, test_methods: methods, failed, passed: methods - failed, failures, classes: out };
}
