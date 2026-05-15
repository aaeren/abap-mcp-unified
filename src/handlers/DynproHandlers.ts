import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ADTClient } from 'abap-adt-api';
import { BaseHandler } from './BaseHandler.js';
import { RunHandlers } from './RunHandlers.js';
import type { ToolDefinition } from '../types/tools.js';

/**
 * Dynpro (SAP Screen Painter) CRUD via RPY_DYNPRO_READ / RPY_DYNPRO_INSERT / RS_DYNPRO_DELETE.
 * Each call generates an IF_OO_ADT_CLASSRUN snippet, runs it through RunHandlers.executeAbap,
 * and parses marker-wrapped JSON output. Mandatory SCREEN container is injected automatically.
 */
export class DynproHandlers extends BaseHandler {
  private runHandlers: RunHandlers;

  constructor(adtclient: ADTClient, runHandlers: RunHandlers) {
    super(adtclient);
    this.runHandlers = runHandlers;
  }

  getTools(): ToolDefinition[] {
    const fieldItemSchema: any = {
      type: 'object',
      properties: {
        type:       { type: 'string', enum: ['TEXT', 'TEMPLATE', 'CHECK', 'RADIO', 'PUSH', 'BOX', 'SUB', 'TAB'],
                      description: 'Element type. TEXT=label, TEMPLATE=input/output field (NOT "I/O"), CHECK=checkbox, RADIO=radio, PUSH=button, BOX=group box, SUB=subscreen area, TAB=tabstrip.' },
        name:       { type: 'string', description: 'Field name. For TEMPLATE this is usually a DDIC dataref like SFLIGHT-CARRID or a custom name.' },
        text:       { type: 'string', description: 'Visible text/label.' },
        line:       { type: 'number', description: '1-based row.' },
        column:     { type: 'number', description: '1-based column.' },
        length:     { type: 'number', description: 'Stored length.' },
        vislength:  { type: 'number', description: 'Visible length (defaults to length).' },
        height:     { type: 'number', description: 'Height in rows (default 1).' },
        input_fld:  { type: 'boolean', description: 'TEMPLATE only — allow input (default false).' },
        output_fld: { type: 'boolean', description: 'TEMPLATE only — allow output (default false).' },
        group1:     { type: 'string', description: 'RADIO only — group name (3 chars).' },
        push_fcode: { type: 'string', description: 'PUSH only — function code.' },
        push_ftype: { type: 'string', description: 'PUSH only — function type, usually "E".' },
        format:     { type: 'string', description: 'Data format (default CHAR).' }
      },
      required: ['type', 'line', 'column']
    };

    const headerSchema: any = {
      type: 'object',
      properties: {
        type:       { type: 'string', enum: ['N', 'M', 'S', 'L'], description: 'N=normal, M=modal popup, S=subscreen, L=list. Default N.' },
        lines:      { type: 'number', description: 'Screen height in rows. Default 20.' },
        columns:    { type: 'number', description: 'Screen width in columns. Default 80.' },
        nextscreen: { type: 'string', description: 'Next screen number ("0" = back to caller). Default "0".' },
        descript:   { type: 'string', description: 'Short description.' },
        language:   { type: 'string', description: 'Master language (1 char ISO code, e.g. "E"). Defaults to current SAP user language.' }
      }
    };

    const containerItemSchema: any = {
      type: 'object',
      properties: {
        type:       { type: 'string', enum: ['CUST_CTRL', 'TABCTRL', 'TABSTRIP', 'SUBSCR'],
                      description: 'Container kind. CUST_CTRL=custom control area for cl_gui_*_container (most common — used to host HTML viewer / ALV / TextEdit), TABCTRL=table control, TABSTRIP=tabstrip, SUBSCR=subscreen area.' },
        name:       { type: 'string', description: 'Container name (used by ABAP at runtime, e.g. cl_gui_custom_container( container_name = "CCON_300_HIST" )). UPPERCASE recommended.' },
        line:       { type: 'number', description: '1-based top row.' },
        column:     { type: 'number', description: '1-based left column.' },
        length:     { type: 'number', description: 'Width in columns.' },
        height:     { type: 'number', description: 'Height in rows.' },
        element_of: { type: 'string', description: 'Parent container name. Default "SCREEN" (the auto-added root container).' }
      },
      required: ['type', 'name', 'line', 'column', 'length', 'height']
    };

    return [
      {
        name: 'abap_dynpro_read',
        description:
          'Read a SAP dynpro (screen) by program name and screen number. Returns the full external-format ' +
          'definition: header, containers, fields (DYFATC_TAB rows with cont_type/cont_name/type/name/text/line/' +
          'column/length/group1/push_fcode/etc.), flow_logic lines (PBO/PAI ABAP), and params. ' +
          'The native D021S fields_list is intentionally excluded — it contains base64 binary internal-format ' +
          'data not useful externally. Use this before editing a screen to capture its current state. ' +
          'Read-only — no transport needed.',
        annotations: { readOnlyHint: true, idempotentHint: true, title: 'Dynpro read' },
        inputSchema: {
          type: 'object',
          properties: {
            program:       { type: 'string', description: 'ABAP program name (e.g. SAPMV45A, Z_MY_PROG).' },
            dynpro_number: { type: 'string', description: '4-digit screen number (e.g. "9000"). Shorter values are zero-padded.' }
          },
          required: ['program', 'dynpro_number']
        } as any
      },
      {
        name: 'abap_dynpro_create',
        description:
          'Create a new SAP dynpro. Fails with subrc=2 ALREADY_EXISTS if the screen number is already in use — ' +
          'call abap_dynpro_update for an existing screen. The mandatory SCREEN container is added automatically; ' +
          'you only specify element fields and (optionally) custom containers. Element types: TEXT=label, ' +
          'TEMPLATE=input/output field (NOT "I/O"), CHECK=checkbox, RADIO (with group1=group_name), ' +
          'PUSH (with push_fcode+push_ftype="E"). Use the containers array for CUST_CTRL host areas needed by ' +
          'cl_gui_custom_container — e.g. to embed cl_gui_html_viewer, cl_gui_alv_grid, cl_gui_textedit. ' +
          'For $TMP package omit transport. flow_logic must be a list of ABAP source lines like ' +
          '["PROCESS BEFORE OUTPUT.", "  MODULE STATUS_9000.", "PROCESS AFTER INPUT.", "  MODULE USER_COMMAND_9000."].',
        annotations: { destructiveHint: false, idempotentHint: false, title: 'Dynpro create' },
        inputSchema: {
          type: 'object',
          properties: {
            program:       { type: 'string', description: 'ABAP program name (must already exist).' },
            dynpro_number: { type: 'string', description: '4-digit screen number to create.' },
            header:        headerSchema,
            fields:        { type: 'array', items: fieldItemSchema, description: 'List of screen elements. Empty array creates a blank screen with only the auto-added OKCODE field.' },
            containers:    { type: 'array', items: containerItemSchema, description: 'Optional list of custom containers (CUST_CTRL etc.). Omit or pass [] for a screen with no embedded GUI controls.' },
            flow_logic:    { type: 'array', items: { type: 'string' }, description: 'PBO/PAI ABAP lines, in order. Required.' },
            transport:     { type: 'string', description: 'Transport request (omit for $TMP / local objects).' }
          },
          required: ['program', 'dynpro_number', 'header', 'fields', 'flow_logic']
        } as any
      },
      {
        name: 'abap_dynpro_update',
        description:
          'Update (overwrite) an existing SAP dynpro. Internally calls RPY_DYNPRO_INSERT with ' +
          'suppress_exist_checks="X", so this will also CREATE the screen if it does not exist — there is no ' +
          'NOT_FOUND error from SAP for this path. If you need strict "must exist" semantics, call ' +
          'abap_dynpro_read first. Same schema as abap_dynpro_create. The full screen is replaced — pass all ' +
          'elements (fields + containers) you want to keep. The SCREEN root container is auto-added; do not list it.',
        annotations: { destructiveHint: true, idempotentHint: true, title: 'Dynpro update' },
        inputSchema: {
          type: 'object',
          properties: {
            program:       { type: 'string' },
            dynpro_number: { type: 'string' },
            header:        headerSchema,
            fields:        { type: 'array', items: fieldItemSchema },
            containers:    { type: 'array', items: containerItemSchema },
            flow_logic:    { type: 'array', items: { type: 'string' } },
            transport:     { type: 'string' }
          },
          required: ['program', 'dynpro_number', 'header', 'fields', 'flow_logic']
        } as any
      },
      {
        name: 'abap_dynpro_delete',
        description:
          'Delete a SAP dynpro. Non-interactive (POPUP=" "), permission checks bypassed (SUPPRESS_CHECKS="X"). ' +
          'For $TMP / local screens omit transport; for transport-bound screens pass the transport number. ' +
          'Returns subrc=1 DYNPRO_NOT_FOUND if the screen does not exist.',
        annotations: { destructiveHint: true, idempotentHint: true, title: 'Dynpro delete' },
        inputSchema: {
          type: 'object',
          properties: {
            program:       { type: 'string' },
            dynpro_number: { type: 'string' },
            transport:     { type: 'string', description: 'Transport request (omit for $TMP).' }
          },
          required: ['program', 'dynpro_number']
        } as any
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'abap_dynpro_read':   return this.handleRead(args);
      case 'abap_dynpro_create': return this.handleWrite(args, 'create');
      case 'abap_dynpro_update': return this.handleWrite(args, 'update');
      case 'abap_dynpro_delete': return this.handleDelete(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown dynpro tool: ${toolName}`);
    }
  }

  // ── Tool implementations ───────────────────────────────────────────────────

  private async handleRead(args: any): Promise<any> {
    const program = this.normProgram(args.program);
    const dynnr = this.normDynnr(args.dynpro_number);
    const body = this.buildReadAbap(program, dynnr);
    const output = await this.runHandlers.executeAbap(body, 'ZCL_TMP_DYNPRO_READ');

    const errLine = this.findErrorLine(output);
    if (errLine) {
      this.fail(this.translateReadError(errLine, program, dynnr));
    }

    const jsonStr = this.extractBetween(output, '__BEGIN_DYNPRO_JSON__', '__END_DYNPRO_JSON__');
    if (!jsonStr) {
      this.fail(`abap_dynpro_read: missing __BEGIN_DYNPRO_JSON__ markers in classrun output. Raw output (first 800 chars): ${output.slice(0, 800)}`);
    }

    let parsed: any;
    try { parsed = JSON.parse(jsonStr); }
    catch (e: any) { this.fail(`abap_dynpro_read: invalid JSON. ${e.message}. Raw JSON (first 800 chars): ${jsonStr.slice(0, 800)}`); }

    // Flatten flow rows ({line: "..."}) to plain strings so the caller can pass them
    // straight back to abap_dynpro_update without re-shaping.
    const flowRaw: any[] = Array.isArray(parsed?.flow) ? parsed.flow : [];
    const flow_logic: string[] = flowRaw.map((r: any) =>
      typeof r === 'string' ? r : (r?.line ?? '')
    );

    return this.success({
      program,
      dynpro_number: dynnr,
      header:     parsed?.header     ?? {},
      containers: parsed?.containers ?? [],
      fields:     parsed?.fields     ?? [],
      flow_logic,
      params:     parsed?.params     ?? []
    });
  }

  private async handleWrite(args: any, mode: 'create' | 'update'): Promise<any> {
    const program = this.normProgram(args.program);
    const dynnr = this.normDynnr(args.dynpro_number);
    const transport = (args.transport || '').toString().toUpperCase().trim();

    const headerIn = args.header || {};
    const header = {
      program,
      screen: dynnr,
      type:       String(headerIn.type || 'N').toUpperCase(),
      lines:      Number(headerIn.lines || 20),
      columns:    Number(headerIn.columns || 80),
      nextscreen: String(headerIn.nextscreen ?? '0'),
      descript:   String(headerIn.descript || ''),
      language:   String(headerIn.language || ''),
      cursor_pos: String(headerIn.cursor_pos || '')
    };

    if (header.lines < 1 || header.columns < 1) {
      this.fail(`abap_dynpro_${mode}: header.lines and header.columns must be >= 1 (got lines=${header.lines}, columns=${header.columns}).`);
    }

    const rawFields = Array.isArray(args.fields) ? args.fields : [];
    const fields = rawFields.map((f: any, i: number) => this.normalizeField(f, i, mode));

    const rawContainers = Array.isArray(args.containers) ? args.containers : [];
    const containers = rawContainers.map((c: any, i: number) => this.normalizeContainer(c, i, mode));

    const rawFlow = Array.isArray(args.flow_logic) ? args.flow_logic : [];
    if (rawFlow.length === 0) {
      this.fail(`abap_dynpro_${mode}: flow_logic must be a non-empty array of ABAP statement lines.`);
    }
    const flow = rawFlow.map((l: any) => String(l));

    const payload = { header, fields, containers, flow };
    const b64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
    const existFlag = mode === 'update' ? 'X' : ' ';

    const body = this.buildWriteAbap(b64, existFlag, transport);
    const output = await this.runHandlers.executeAbap(body, 'ZCL_TMP_DYNPRO_WRITE');

    const jsonStr = this.extractAfter(output, '__DYNPRO_WRITE_RESULT__');
    if (!jsonStr) {
      this.fail(`abap_dynpro_${mode}: missing __DYNPRO_WRITE_RESULT__ marker in classrun output. Raw output (first 800 chars): ${output.slice(0, 800)}`);
    }

    let result: any;
    try { result = JSON.parse(jsonStr); }
    catch (e: any) { this.fail(`abap_dynpro_${mode}: invalid result JSON. ${e.message}. Raw JSON (first 400 chars): ${jsonStr.slice(0, 400)}`); }

    if (result.subrc !== 0) {
      const name = this.writeSubrcName(result.subrc);
      const msg = [result.msgv1, result.msgv2, result.msgv3, result.msgv4].filter(Boolean).join(' ').trim();
      this.fail(
        `abap_dynpro_${mode} failed: subrc=${result.subrc} (${name})` +
        (result.msgid ? ` ${result.msgid}-${result.msgno}` : '') +
        (msg ? `: ${msg}` : '')
      );
    }

    return this.success({ mode, program, dynpro_number: dynnr, transport: transport || '$TMP', result });
  }

  private async handleDelete(args: any): Promise<any> {
    const program = this.normProgram(args.program);
    const dynnr = this.normDynnr(args.dynpro_number);
    const transport = (args.transport || '').toString().toUpperCase().trim();
    const body = this.buildDeleteAbap(program, dynnr, transport);
    const output = await this.runHandlers.executeAbap(body, 'ZCL_TMP_DYNPRO_DELETE');

    const jsonStr = this.extractAfter(output, '__DYNPRO_DELETE_RESULT__');
    if (!jsonStr) {
      this.fail(`abap_dynpro_delete: missing __DYNPRO_DELETE_RESULT__ marker in classrun output. Raw output (first 800 chars): ${output.slice(0, 800)}`);
    }

    let result: any;
    try { result = JSON.parse(jsonStr); }
    catch (e: any) { this.fail(`abap_dynpro_delete: invalid result JSON. ${e.message}. Raw JSON: ${jsonStr.slice(0, 400)}`); }

    if (result.subrc !== 0) {
      const name = this.deleteSubrcName(result.subrc);
      const msg = [result.msgv1, result.msgv2, result.msgv3, result.msgv4].filter(Boolean).join(' ').trim();
      this.fail(
        `abap_dynpro_delete failed: subrc=${result.subrc} (${name})` +
        (result.msgid ? ` ${result.msgid}-${result.msgno}` : '') +
        (msg ? `: ${msg}` : '')
      );
    }

    return this.success({ program, dynpro_number: dynnr, transport: transport || '$TMP', result });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private normProgram(p: any): string {
    const s = String(p || '').trim().toUpperCase();
    if (!s) this.fail('program is required.');
    if (s.includes("'")) this.fail(`program name must not contain single quotes: "${s}"`);
    return s;
  }

  private normDynnr(d: any): string {
    let s = String(d || '').trim();
    if (!s) this.fail('dynpro_number is required.');
    if (!/^\d+$/.test(s)) this.fail(`dynpro_number must be numeric: "${s}"`);
    if (s.length > 4) this.fail(`dynpro_number must be 4 digits or less: "${s}"`);
    return s.padStart(4, '0');
  }

  private normalizeContainer(c: any, index: number, mode: string): any {
    if (!c || typeof c !== 'object') {
      this.fail(`abap_dynpro_${mode}: containers[${index}] must be an object.`);
    }
    const type = String(c.type || '').toUpperCase();
    const ALLOWED = ['CUST_CTRL', 'TABCTRL', 'TABSTRIP', 'SUBSCR'];
    if (!ALLOWED.includes(type)) {
      this.fail(`abap_dynpro_${mode}: containers[${index}].type "${c.type}" not in allowed set ${ALLOWED.join(',')}.`);
    }
    const name = String(c.name || '').toUpperCase().trim();
    if (!name) {
      this.fail(`abap_dynpro_${mode}: containers[${index}] requires name.`);
    }
    const out = {
      type,
      name,
      element_of: String(c.element_of || 'SCREEN').toUpperCase().trim(),
      line:   Number(c.line || 0),
      column: Number(c.column || 0),
      length: Number(c.length || 0),
      height: Number(c.height || 0)
    };
    if (out.line < 1 || out.column < 1 || out.length < 1 || out.height < 1) {
      this.fail(`abap_dynpro_${mode}: containers[${index}] (${name}) must have line/column/length/height >= 1 (got line=${out.line}, column=${out.column}, length=${out.length}, height=${out.height}).`);
    }
    return out;
  }

  private normalizeField(f: any, index: number, mode: string): any {
    if (!f || typeof f !== 'object') {
      this.fail(`abap_dynpro_${mode}: fields[${index}] must be an object.`);
    }
    const type = String(f.type || '').toUpperCase();
    const ALLOWED = ['TEXT', 'TEMPLATE', 'CHECK', 'RADIO', 'PUSH', 'BOX', 'SUB', 'TAB'];
    if (!ALLOWED.includes(type)) {
      this.fail(`abap_dynpro_${mode}: fields[${index}].type "${f.type}" not in allowed set ${ALLOWED.join(',')}. NOTE: use "TEMPLATE" for input fields, NOT "I/O".`);
    }
    const boolFlag = (v: any) => (v === true || v === 'X' || v === 'x' || v === 1) ? 'X' : ' ';
    const out = {
      type,
      name:       String(f.name || ''),
      text:       String(f.text || ''),
      line:       Number(f.line || 0),
      column:     Number(f.column || 0),
      length:     Number(f.length || 0),
      vislength:  Number(f.vislength || 0),
      height:     Number(f.height || 0),
      input_fld:  boolFlag(f.input_fld),
      output_fld: boolFlag(f.output_fld),
      group1:     String(f.group1 || ''),
      push_fcode: String(f.push_fcode || ''),
      push_ftype: String(f.push_ftype || (type === 'PUSH' ? 'E' : '')),
      format:     String(f.format || '')
    };
    if (out.line < 1 || out.column < 1) {
      this.fail(`abap_dynpro_${mode}: fields[${index}] must have line>=1 and column>=1 (got line=${out.line}, column=${out.column}).`);
    }
    if (type === 'RADIO' && !out.group1) {
      this.fail(`abap_dynpro_${mode}: fields[${index}] type=RADIO requires a group1 (group name, e.g. "GR1").`);
    }
    if (type === 'PUSH' && !out.push_fcode) {
      this.fail(`abap_dynpro_${mode}: fields[${index}] type=PUSH requires push_fcode (function code).`);
    }
    return out;
  }

  private findErrorLine(output: string): string | null {
    const m = output.match(/^ERROR:[^\n]+/m);
    return m ? m[0] : null;
  }

  private translateReadError(errLine: string, program: string, dynnr: string): string {
    // Format: ERROR:{subrc}:{msgid}-{msgno}:{msgv1} {msgv2} {msgv3} {msgv4}
    const m = errLine.match(/^ERROR:(\d+):([^:]*):(.*)$/);
    if (!m) return `abap_dynpro_read failed: ${errLine}`;
    const rc = Number(m[1]);
    const idno = m[2];
    const txt = m[3].trim();
    const name = rc === 1 ? 'CANCELLED' : rc === 2 ? 'NOT_FOUND' : rc === 3 ? 'PERMISSION_ERROR' : `RC_${rc}`;
    let hint = '';
    if (rc === 2) hint = ` — verify program "${program}" exists and screen ${dynnr} is defined on it.`;
    return `abap_dynpro_read failed: subrc=${rc} (${name})${idno ? ' ' + idno : ''}${txt ? ': ' + txt : ''}${hint}`;
  }

  private extractBetween(s: string, start: string, end: string): string | null {
    const i = s.indexOf(start);
    if (i < 0) return null;
    const j = s.indexOf(end, i + start.length);
    if (j < 0) return null;
    return s.slice(i + start.length, j).trim();
  }

  private extractAfter(s: string, marker: string): string | null {
    const i = s.indexOf(marker);
    if (i < 0) return null;
    return s.slice(i + marker.length).trim();
  }

  private writeSubrcName(rc: number): string {
    return ({
      1: 'CANCELLED',
      2: 'ALREADY_EXISTS',
      3: 'PROGRAM_NOT_EXISTS',
      4: 'NOT_EXECUTED',
      5: 'MISSING_REQUIRED_FIELD',
      6: 'ILLEGAL_FIELD_VALUE',
      7: 'FIELD_NOT_ALLOWED',
      8: 'NOT_GENERATED',
      9: 'ILLEGAL_FIELD_POSITION'
    } as Record<number, string>)[rc] || `RC_${rc}`;
  }

  private deleteSubrcName(rc: number): string {
    return ({
      1: 'DYNPRO_NOT_FOUND',
      2: 'DYNPRO_NOT_SPECIFIED',
      3: 'NOT_EXECUTED',
      4: 'PERMISSION_FAILURE'
    } as Record<number, string>)[rc] || `RC_${rc}`;
  }

  /** Break a long base64 string into ABAP-line-safe chunks concatenated with `&&`. */
  private chunkBase64(b64: string): string {
    const SIZE = 100;
    const parts: string[] = [];
    for (let i = 0; i < b64.length; i += SIZE) parts.push(b64.slice(i, i + SIZE));
    if (parts.length === 0) return '``';
    return parts.map((c, i) => (i === 0 ? `\`${c}\`` : `         && \`${c}\``)).join('\n');
  }

  // ── ABAP code-gen templates ────────────────────────────────────────────────

  private buildReadAbap(program: string, dynnr: string): string {
    return `TYPES: BEGIN OF ty_out,
         header     TYPE rpy_dyhead,
         containers TYPE dycatt_tab,
         fields     TYPE dyfatc_tab,
         flow       TYPE STANDARD TABLE OF rpy_dyflow WITH EMPTY KEY,
         params     TYPE STANDARD TABLE OF rpy_dypara WITH EMPTY KEY,
       END OF ty_out.

DATA: ls_header TYPE rpy_dyhead,
      lt_cont   TYPE dycatt_tab,
      lt_f2c    TYPE dyfatc_tab,
      lt_flow   TYPE STANDARD TABLE OF rpy_dyflow,
      lt_params TYPE STANDARD TABLE OF rpy_dypara,
      lt_fields TYPE STANDARD TABLE OF d021s.

CALL FUNCTION 'RPY_DYNPRO_READ'
  EXPORTING
    progname             = '${program}'
    dynnr                = '${dynnr}'
    suppress_corr_checks = 'X'
  IMPORTING
    header               = ls_header
  TABLES
    containers           = lt_cont
    fields_to_containers = lt_f2c
    flow_logic           = lt_flow
    params               = lt_params
    fields_list          = lt_fields
  EXCEPTIONS
    cancelled            = 1
    not_found            = 2
    permission_error     = 3
    OTHERS               = 4.

DATA(lv_rc)    = sy-subrc.
DATA(lv_msgid) = sy-msgid.
DATA(lv_msgno) = sy-msgno.
DATA(lv_msgv1) = sy-msgv1.
DATA(lv_msgv2) = sy-msgv2.
DATA(lv_msgv3) = sy-msgv3.
DATA(lv_msgv4) = sy-msgv4.

IF lv_rc <> 0.
  out->write( |ERROR:{ lv_rc }:{ lv_msgid }-{ lv_msgno }:{ lv_msgv1 } { lv_msgv2 } { lv_msgv3 } { lv_msgv4 }| ).
  RETURN.
ENDIF.

DATA(ls_out) = VALUE ty_out(
  header     = ls_header
  containers = lt_cont
  fields     = lt_f2c
  flow       = lt_flow
  params     = lt_params ).

out->write( |__BEGIN_DYNPRO_JSON__| ).
out->write( /ui2/cl_json=>serialize(
  data        = ls_out
  pretty_name = /ui2/cl_json=>pretty_mode-low_case ) ).
out->write( |__END_DYNPRO_JSON__| ).`;
  }

  private buildWriteAbap(b64: string, existFlag: string, transport: string): string {
    const chunked = this.chunkBase64(b64);
    const corrCond = transport
      ? `'${transport}'`
      : `''`;
    const suppressCorrCond = transport
      ? `' '`
      : `'X'`;

    return `TYPES: BEGIN OF ty_fld,
         type        TYPE c LENGTH 8,
         name        TYPE c LENGTH 132,
         text        TYPE c LENGTH 70,
         line        TYPE i,
         column      TYPE i,
         length      TYPE i,
         vislength   TYPE i,
         height      TYPE i,
         input_fld   TYPE c LENGTH 1,
         output_fld  TYPE c LENGTH 1,
         group1      TYPE c LENGTH 3,
         push_fcode  TYPE c LENGTH 20,
         push_ftype  TYPE c LENGTH 1,
         format      TYPE c LENGTH 4,
       END OF ty_fld,
       tt_fld TYPE STANDARD TABLE OF ty_fld WITH EMPTY KEY.

TYPES: BEGIN OF ty_cont,
         type       TYPE c LENGTH 10,
         name       TYPE c LENGTH 30,
         element_of TYPE c LENGTH 30,
         line       TYPE i,
         column     TYPE i,
         length     TYPE i,
         height     TYPE i,
       END OF ty_cont,
       tt_cont TYPE STANDARD TABLE OF ty_cont WITH EMPTY KEY.

TYPES: BEGIN OF ty_payload,
         header     TYPE rpy_dyhead,
         fields     TYPE tt_fld,
         containers TYPE tt_cont,
         flow       TYPE STANDARD TABLE OF string WITH EMPTY KEY,
       END OF ty_payload.

DATA lv_b64 TYPE string.
lv_b64 = ${chunked}.

DATA(lv_xstring) = cl_http_utility=>decode_x_base64( lv_b64 ).
DATA(lv_json)    = cl_abap_codepage=>convert_from( lv_xstring ).

DATA ls_payload TYPE ty_payload.
/ui2/cl_json=>deserialize(
  EXPORTING
    json        = lv_json
    pretty_name = /ui2/cl_json=>pretty_mode-low_case
  CHANGING
    data        = ls_payload ).

IF ls_payload-header-language IS INITIAL.
  ls_payload-header-language = sy-langu.
ENDIF.

DATA: lt_cont   TYPE dycatt_tab,
      lt_f2c    TYPE dyfatc_tab,
      lt_flow   TYPE STANDARD TABLE OF rpy_dyflow,
      lt_params TYPE STANDARD TABLE OF rpy_dypara.

APPEND VALUE #(
  type   = 'SCREEN'
  name   = 'SCREEN'
  line   = 0
  column = 0
  length = ls_payload-header-columns
  height = ls_payload-header-lines ) TO lt_cont.

LOOP AT ls_payload-containers ASSIGNING FIELD-SYMBOL(<c>).
  APPEND VALUE #(
    type       = <c>-type
    name       = <c>-name
    element_of = COND #( WHEN <c>-element_of IS NOT INITIAL THEN <c>-element_of ELSE 'SCREEN' )
    line       = <c>-line
    column     = <c>-column
    length     = <c>-length
    height     = <c>-height
    c_line_min = 1
    c_coln_min = 1 ) TO lt_cont.
ENDLOOP.

LOOP AT ls_payload-fields ASSIGNING FIELD-SYMBOL(<src>).
  APPEND VALUE #(
    cont_type  = 'SCREEN'
    cont_name  = 'SCREEN'
    type       = <src>-type
    name       = <src>-name
    text       = <src>-text
    line       = <src>-line
    column     = <src>-column
    length     = <src>-length
    vislength  = COND #( WHEN <src>-vislength > 0 THEN <src>-vislength ELSE <src>-length )
    height     = COND #( WHEN <src>-height    > 0 THEN <src>-height    ELSE 1 )
    format     = COND #( WHEN <src>-format IS NOT INITIAL THEN <src>-format ELSE 'CHAR' )
    input_fld  = <src>-input_fld
    output_fld = <src>-output_fld
    group1     = <src>-group1
    push_fcode = <src>-push_fcode
    push_ftype = <src>-push_ftype ) TO lt_f2c.
ENDLOOP.

LOOP AT ls_payload-flow INTO DATA(lv_line).
  APPEND VALUE #( line = lv_line ) TO lt_flow.
ENDLOOP.

CALL FUNCTION 'RPY_DYNPRO_INSERT'
  EXPORTING
    suppress_corr_checks     = ${suppressCorrCond}
    corrnum                  = ${corrCond}
    suppress_exist_checks    = '${existFlag}'
    suppress_extended_checks = 'X'
    suppress_generate        = ' '
    suppress_dict_support    = 'X'
    header                   = ls_payload-header
  TABLES
    containers               = lt_cont
    fields_to_containers     = lt_f2c
    flow_logic               = lt_flow
    params                   = lt_params
  EXCEPTIONS
    cancelled                = 1
    already_exists           = 2
    program_not_exists       = 3
    not_executed             = 4
    missing_required_field   = 5
    illegal_field_value      = 6
    field_not_allowed        = 7
    not_generated            = 8
    illegal_field_position   = 9
    OTHERS                   = 10.

DATA(lv_rc)    = sy-subrc.
DATA(lv_msgid) = sy-msgid.
DATA(lv_msgno) = sy-msgno.
DATA(lv_msgv1) = sy-msgv1.
DATA(lv_msgv2) = sy-msgv2.
DATA(lv_msgv3) = sy-msgv3.
DATA(lv_msgv4) = sy-msgv4.

TYPES: BEGIN OF ty_res,
         subrc   TYPE sy-subrc,
         msgid   TYPE sy-msgid,
         msgno   TYPE sy-msgno,
         msgv1   TYPE sy-msgv1,
         msgv2   TYPE sy-msgv2,
         msgv3   TYPE sy-msgv3,
         msgv4   TYPE sy-msgv4,
         program TYPE c LENGTH 40,
         dynnr   TYPE c LENGTH 4,
       END OF ty_res.

DATA(ls_res) = VALUE ty_res(
  subrc   = lv_rc
  msgid   = lv_msgid
  msgno   = lv_msgno
  msgv1   = lv_msgv1
  msgv2   = lv_msgv2
  msgv3   = lv_msgv3
  msgv4   = lv_msgv4
  program = ls_payload-header-program
  dynnr   = ls_payload-header-screen ).

out->write( |__DYNPRO_WRITE_RESULT__| ).
out->write( /ui2/cl_json=>serialize(
  data        = ls_res
  pretty_name = /ui2/cl_json=>pretty_mode-low_case ) ).`;
  }

  private buildDeleteAbap(program: string, dynnr: string, transport: string): string {
    const suppressCorrCond = transport ? `' '` : `'X'`;
    return `CALL FUNCTION 'RS_DYNPRO_DELETE'
  EXPORTING
    progname        = '${program}'
    dynnr           = '${dynnr}'
    popup           = ' '
    suppress_checks = 'X'
    suppress_corr   = ${suppressCorrCond}
  EXCEPTIONS
    dynpro_not_found     = 1
    dynpro_not_specified = 2
    not_executed         = 3
    permission_failure   = 4
    OTHERS               = 5.

DATA(lv_rc)    = sy-subrc.
DATA(lv_msgid) = sy-msgid.
DATA(lv_msgno) = sy-msgno.
DATA(lv_msgv1) = sy-msgv1.
DATA(lv_msgv2) = sy-msgv2.
DATA(lv_msgv3) = sy-msgv3.
DATA(lv_msgv4) = sy-msgv4.

TYPES: BEGIN OF ty_res,
         subrc TYPE sy-subrc,
         msgid TYPE sy-msgid,
         msgno TYPE sy-msgno,
         msgv1 TYPE sy-msgv1,
         msgv2 TYPE sy-msgv2,
         msgv3 TYPE sy-msgv3,
         msgv4 TYPE sy-msgv4,
       END OF ty_res.

DATA(ls_res) = VALUE ty_res(
  subrc = lv_rc
  msgid = lv_msgid
  msgno = lv_msgno
  msgv1 = lv_msgv1
  msgv2 = lv_msgv2
  msgv3 = lv_msgv3
  msgv4 = lv_msgv4 ).

out->write( |__DYNPRO_DELETE_RESULT__| ).
out->write( /ui2/cl_json=>serialize(
  data        = ls_res
  pretty_name = /ui2/cl_json=>pretty_mode-low_case ) ).`;
  }
}
