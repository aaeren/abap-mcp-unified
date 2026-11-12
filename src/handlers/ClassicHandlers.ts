import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ADTClient } from 'abap-adt-api';
import { BaseHandler } from './BaseHandler.js';
import { RunHandlers } from './RunHandlers.js';
import type { ToolDefinition } from '../types/tools.js';

/**
 * Classic (non-ADT) program artefacts: text pools, GUI status / titlebars (CUA), T100 messages.
 *
 * ADT has no REST resource for these on most releases, so — like DynproHandlers — each call
 * generates an IF_OO_ADT_CLASSRUN snippet, runs it through RunHandlers.executeAbap and parses
 * marker-wrapped JSON. Standard APIs used: READ/INSERT TEXTPOOL, RS_CUA_INTERNAL_FETCH/WRITE, T100.
 */
export class ClassicHandlers extends BaseHandler {
  private runHandlers: RunHandlers;

  constructor(adtclient: ADTClient, runHandlers: RunHandlers) {
    super(adtclient);
    this.runHandlers = runHandlers;
  }

  getTools(): ToolDefinition[] {
    const lang = {
      type: 'string',
      description: 'Language: SAP 1-char (T, E, D) or ISO 2-char (TR, EN, DE). Default: master language of the object.'
    };
    return [
      {
        name: 'abap_textpool_read',
        description:
          'Read the text pool of a program: text symbols (TEXT-xxx), selection texts, report title, list headings. ' +
          'Returns entries as {id, key, entry, length}; id: I=text symbol, S=selection text, R=program title, H=list heading. ' +
          'For S entries "entry" is the plain label and ddic_reference=true means the label comes from the dictionary. ' +
          'Runs a temporary class on the system (same mechanism as abap_run). For a class use its class-pool name.',
        inputSchema: {
          type: 'object',
          properties: { program: { type: 'string', description: 'Program name, e.g. ZRPD_ABCD_P01' }, language: lang },
          required: ['program']
        }
      },
      {
        name: 'abap_textpool_write',
        description:
          'Create/update text pool entries of a program so code can use TEXT-xxx and selection texts instead of ' +
          'hard-coded literals. mode="merge" (default) keeps existing entries and upserts the given ones ' +
          '(an entry with delete=true is removed); mode="replace" replaces the whole text pool of that language. ' +
          'S entries: pass the plain label in "entry", or ddic_reference=true to take the label from the data element. ' +
          'The program must exist. Verified for local ($TMP) programs; for a transportable program make sure the ' +
          'program itself is on a transport — this tool does not create a separate transport entry.',
        inputSchema: {
          type: 'object',
          properties: {
            program: { type: 'string', description: 'Program name' },
            language: lang,
            mode: { type: 'string', enum: ['merge', 'replace'], description: 'merge (default) or replace' } as any,
            entries: {
              type: 'array',
              description: 'Entries: {id: I|S|R|H|T, key, entry, length?, ddic_reference?, delete?}. ' +
                'key: 3 chars for I (e.g. F01), parameter/select-option name for S, empty for R.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' }, key: { type: 'string' }, entry: { type: 'string' },
                  length: { type: 'number' }, ddic_reference: { type: 'boolean' }, delete: { type: 'boolean' }
                },
                required: ['id']
              }
            } as any
          },
          required: ['program', 'entries']
        }
      },
      {
        name: 'abap_gui_status_read',
        description:
          'Read the GUI interface (CUA) of a program: GUI statuses with their function keys / toolbar buttons, and ' +
          'titlebars. Returned in the same shape abap_gui_status_write accepts. has_menus=true means the program has ' +
          'menu-bar definitions that this simplified model does not carry (a write would drop them). ' +
          'Pass raw=true to also get the underlying RSMPE_* tables.',
        inputSchema: {
          type: 'object',
          properties: {
            program: { type: 'string', description: 'Program name' }, language: lang,
            raw: { type: 'boolean', description: 'Also return raw RSMPE tables' }
          },
          required: ['program']
        }
      },
      {
        name: 'abap_gui_status_write',
        description:
          'Define the GUI statuses (SET PF-STATUS) and titlebars (SET TITLEBAR) of a program — what SE41 does. ' +
          'IMPORTANT: this REPLACES the program\'s whole GUI interface; call abap_gui_status_read first and include ' +
          'statuses/titles you want to keep. Menu bars are not supported (statuses are created without a menu bar). ' +
          'The program must be ACTIVE. Each key: {key, fcode, text, icon?, toolbar?}. key is a function key: ' +
          '"F3" / 3, "SHIFT+F3" (=15), "CTRL+F1" (=25), or the number 1-99. Standard toolbar: F3=Back(green arrow), ' +
          'SHIFT+F3=Exit(yellow), F12=Cancel(red), CTRL+S / 11=Save. toolbar=true also puts the function on the ' +
          'application toolbar. icon is an icon name such as ICON_CANCEL. ' +
          'Typical ALV screen status: keys BACK on F3, EXIT on SHIFT+F3, CANC on F12. ' +
          'Verified for local ($TMP) programs; for transportable programs make sure the program is on a transport.',
        inputSchema: {
          type: 'object',
          properties: {
            program: { type: 'string', description: 'Program name (must be active)' },
            language: lang,
            statuses: {
              type: 'array',
              description: 'GUI statuses: {code, description?, keys: [{key, fcode, text, icon?, icon_text?, info_text?, toolbar?}]}',
              items: { type: 'object', properties: { code: { type: 'string' }, description: { type: 'string' }, keys: { type: 'array' } }, required: ['code', 'keys'] }
            } as any,
            titles: {
              type: 'array',
              description: 'Titlebars: {code, text}',
              items: { type: 'object', properties: { code: { type: 'string' }, text: { type: 'string' } }, required: ['code', 'text'] }
            } as any
          },
          required: ['program', 'statuses']
        }
      },
      {
        name: 'abap_message_read',
        description:
          'Read the messages (T100) of a message class in one language, with numbers and texts. ' +
          'Use before adding messages to find free numbers and avoid duplicates.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: 'object',
          properties: { message_class: { type: 'string', description: 'Message class, e.g. ZRPD_ABCD_M' }, language: lang },
          required: ['message_class']
        }
      },
      {
        name: 'abap_message_write',
        description:
          'Create/update messages in an existing message class so code can use MESSAGE e012(zmsg) instead of literal ' +
          'texts. Writes the text in the given language AND, if the message does not exist there yet, in the class\'s ' +
          'master language (otherwise syntax check / ATC report "message does not exist"). Placeholders: &1 &2 &3 &4. ' +
          'Create the message class first with abap_create (type MSAG). Writes T100 directly; verified for local ' +
          '($TMP) classes — for a transportable class make sure the message class is on a transport.',
        inputSchema: {
          type: 'object',
          properties: {
            message_class: { type: 'string', description: 'Message class' },
            language: lang,
            messages: {
              type: 'array',
              description: 'Messages: {number: "001".."999", text (max 73 chars)}',
              items: { type: 'object', properties: { number: { type: 'string' }, text: { type: 'string' } }, required: ['number', 'text'] }
            } as any
          },
          required: ['message_class', 'messages']
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'abap_textpool_read':    return this.textpoolRead(args);
      case 'abap_textpool_write':   return this.textpoolWrite(args);
      case 'abap_gui_status_read':  return this.guiStatusRead(args);
      case 'abap_gui_status_write': return this.guiStatusWrite(args);
      case 'abap_message_read':     return this.messageRead(args);
      case 'abap_message_write':    return this.messageWrite(args);
      default: throw new McpError(ErrorCode.MethodNotFound, `Unknown classic tool: ${toolName}`);
    }
  }

  // ── shared helpers ─────────────────────────────────────────────────────────

  private objName(v: any, what: string, max = 40): string {
    const s = String(v ?? '').trim().toUpperCase();
    if (!s || !/^[A-Z0-9_\/=$]+$/.test(s) || s.length > max) {
      this.fail(`${what}: invalid name "${v}" (letters, digits, _ and / only, max ${max} chars).`);
    }
    return s;
  }

  private langArg(v: any): string {
    const s = String(v ?? '').trim().toUpperCase();
    if (s && !/^[A-Z0-9]{1,2}$/.test(s)) this.fail(`language: expected 1-char SAP or 2-char ISO code, got "${v}".`);
    return s;
  }

  /** ABAP that resolves lv_lang from an optional 1/2-char code, else the object's master language. */
  private langAbap(lang: string, tadirObject: string, nameLiteral: string): string {
    return `DATA lv_lang TYPE sy-langu.
DATA lv_langin TYPE c LENGTH 2 VALUE '${lang}'.
IF strlen( lv_langin ) = 2.
  CALL FUNCTION 'CONVERSION_EXIT_ISOLA_INPUT'
    EXPORTING
      input  = lv_langin
    IMPORTING
      output = lv_lang
    EXCEPTIONS
      OTHERS = 1.
  IF sy-subrc <> 0.
    out->write( |ERROR:unknown language { lv_langin }| ).
    RETURN.
  ENDIF.
ELSEIF lv_langin IS NOT INITIAL.
  lv_lang = lv_langin(1).
ELSE.
  SELECT SINGLE masterlang FROM tadir
    WHERE pgmid = 'R3TR' AND object = '${tadirObject}' AND obj_name = '${nameLiteral}'
    INTO @lv_lang.
  IF sy-subrc <> 0 OR lv_lang IS INITIAL.
    lv_lang = sy-langu.
  ENDIF.
ENDIF.`;
  }

  private chunk(b64: string): string {
    const parts: string[] = [];
    for (let i = 0; i < b64.length; i += 100) parts.push(b64.slice(i, i + 100));
    if (!parts.length) return '``';
    return parts.map((c, i) => (i === 0 ? `\`${c}\`` : `  && \`${c}\``)).join('\n');
  }

  private payloadAbap(payload: any, typeName: string): string {
    const b64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
    return `DATA lv_b64 TYPE string.
lv_b64 = ${this.chunk(b64)}.
DATA(lv_json) = cl_abap_codepage=>convert_from( cl_http_utility=>decode_x_base64( lv_b64 ) ).
DATA ls_in TYPE ${typeName}.
/ui2/cl_json=>deserialize(
  EXPORTING
    json        = lv_json
    pretty_name = /ui2/cl_json=>pretty_mode-low_case
  CHANGING
    data        = ls_in ).`;
  }

  private async runJson(tool: string, body: string, className: string): Promise<any> {
    const output = await this.runHandlers.executeAbap(body, className);
    const err = output.match(/^ERROR:([^\n]+)/m);
    if (err) this.fail(`${tool} failed: ${err[1].trim()}`);
    const i = output.indexOf('__BEGIN_JSON__');
    const j = output.indexOf('__END_JSON__');
    if (i < 0 || j < 0) this.fail(`${tool}: unexpected output from the system (first 600 chars): ${output.slice(0, 600)}`);
    try {
      return JSON.parse(output.slice(i + '__BEGIN_JSON__'.length, j).trim());
    } catch (e: any) {
      this.fail(`${tool}: invalid JSON from the system — ${e.message}`);
    }
  }

  private static readonly JSON_OUT = (expr: string) => `out->write( '__BEGIN_JSON__' ).
out->write( /ui2/cl_json=>serialize( data = ${expr} pretty_name = /ui2/cl_json=>pretty_mode-low_case ) ).
out->write( '__END_JSON__' ).`;

  private progCheckAbap(program: string): string {
    return `SELECT SINGLE name FROM trdir WHERE name = '${program}' INTO @DATA(lv_exists).
IF sy-subrc <> 0.
  out->write( |ERROR:program ${program} does not exist| ).
  RETURN.
ENDIF.`;
  }

  // ── text pool ──────────────────────────────────────────────────────────────

  private decodeTextpool(rows: any[]): any[] {
    return (rows || []).map((r: any) => {
      const id = String(r.id || '').toUpperCase();
      const raw = String(r.entry ?? '');
      if (id === 'S') {
        const ddic = raw.startsWith('D');
        return { id, key: r.key, entry: ddic ? '' : raw.slice(8).trimEnd(), ddic_reference: ddic, length: Number(r.length) || 0 };
      }
      return { id, key: r.key || '', entry: raw, length: Number(r.length) || 0 };
    });
  }

  private async textpoolRead(args: any): Promise<any> {
    const program = this.objName(args.program, 'program');
    const body = `${this.progCheckAbap(program)}
${this.langAbap(this.langArg(args.language), 'PROG', program)}
TYPES: BEGIN OF ty_out,
         language TYPE sy-langu,
         entries  TYPE STANDARD TABLE OF textpool WITH EMPTY KEY,
       END OF ty_out.
DATA ls_out TYPE ty_out.
ls_out-language = lv_lang.
READ TEXTPOOL '${program}' INTO ls_out-entries LANGUAGE lv_lang.
${ClassicHandlers.JSON_OUT('ls_out')}`;
    const res = await this.runJson('abap_textpool_read', body, 'ZCL_TMP_TPOOL_READ');
    const entries = this.decodeTextpool(res.entries);
    return this.success({ program, language: res.language, count: entries.length, entries });
  }

  private async textpoolWrite(args: any): Promise<any> {
    const program = this.objName(args.program, 'program');
    const mode = String(args.mode || 'merge').toLowerCase();
    if (mode !== 'merge' && mode !== 'replace') this.fail('abap_textpool_write: mode must be "merge" or "replace".');
    const raw = Array.isArray(args.entries) ? args.entries : [];
    if (!raw.length) this.fail('abap_textpool_write: entries must be a non-empty array.');

    const entries = raw.map((e: any, i: number) => {
      const id = String(e.id || '').trim().toUpperCase();
      if (!['I', 'S', 'R', 'H', 'T'].includes(id)) this.fail(`entries[${i}].id must be one of I, S, R, H, T (got "${e.id}").`);
      const key = String(e.key ?? '').trim().toUpperCase();
      const text = String(e.entry ?? '');
      const del = e.delete === true;
      if (id === 'I' && !/^[A-Z0-9]{3}$/.test(key)) this.fail(`entries[${i}]: text symbol key must be exactly 3 characters (got "${e.key}").`);
      if (id === 'S' && !/^[A-Z0-9_]{1,8}$/.test(key)) this.fail(`entries[${i}]: selection text key must be the parameter/select-option name, max 8 chars (got "${e.key}").`);
      const ddic = id === 'S' && e.ddic_reference === true;
      if (!del && !ddic && !text) this.fail(`entries[${i}]: entry text is required (or set delete=true / ddic_reference=true).`);
      const max = id === 'S' ? 30 : id === 'R' ? 70 : 132;
      if (text.length > max) this.fail(`entries[${i}]: text is ${text.length} chars, max ${max} for id ${id}.`);
      const length = id === 'S' ? (ddic ? 9 : text.length + 8) : Math.min(max, Math.max(Number(e.length) || 0, text.length));
      return { id, key, text, ddic: ddic ? 'X' : '', del: del ? 'X' : '', length };
    });

    const body = `TYPES: BEGIN OF ty_e,
         id     TYPE c LENGTH 1,
         key    TYPE c LENGTH 8,
         text   TYPE c LENGTH 132,
         ddic   TYPE c LENGTH 1,
         del    TYPE c LENGTH 1,
         length TYPE i,
       END OF ty_e.
TYPES: BEGIN OF ty_in,
         entries TYPE STANDARD TABLE OF ty_e WITH EMPTY KEY,
       END OF ty_in.
${this.progCheckAbap(program)}
${this.langAbap(this.langArg(args.language), 'PROG', program)}
${this.payloadAbap({ entries }, 'ty_in')}
DATA lt_tp TYPE STANDARD TABLE OF textpool WITH EMPTY KEY.
DATA ls_tp TYPE textpool.
${mode === 'merge' ? `READ TEXTPOOL '${program}' INTO lt_tp LANGUAGE lv_lang.` : ''}
DATA(lv_before) = lines( lt_tp ).
LOOP AT ls_in-entries INTO DATA(ls_e).
  DELETE lt_tp WHERE id = ls_e-id AND key = ls_e-key.
  IF ls_e-del = 'X'.
    CONTINUE.
  ENDIF.
  CLEAR ls_tp.
  ls_tp-id  = ls_e-id.
  ls_tp-key = ls_e-key.
  IF ls_e-id = 'S'.
    IF ls_e-ddic = 'X'.
      ls_tp-entry = 'D       .'.
    ELSE.
      ls_tp-entry+8 = ls_e-text.
    ENDIF.
  ELSE.
    ls_tp-entry = ls_e-text.
  ENDIF.
  ls_tp-length = ls_e-length.
  APPEND ls_tp TO lt_tp.
ENDLOOP.
SORT lt_tp BY id key.
INSERT TEXTPOOL '${program}' FROM lt_tp LANGUAGE lv_lang.
IF sy-subrc <> 0.
  out->write( |ERROR:INSERT TEXTPOOL failed, subrc={ sy-subrc }| ).
  RETURN.
ENDIF.
COMMIT WORK.
TYPES: BEGIN OF ty_out,
         language TYPE sy-langu,
         before   TYPE i,
         entries  TYPE STANDARD TABLE OF textpool WITH EMPTY KEY,
       END OF ty_out.
DATA ls_out TYPE ty_out.
ls_out-language = lv_lang.
ls_out-before   = lv_before.
READ TEXTPOOL '${program}' INTO ls_out-entries LANGUAGE lv_lang.
${ClassicHandlers.JSON_OUT('ls_out')}`;
    const res = await this.runJson('abap_textpool_write', body, 'ZCL_TMP_TPOOL_WRITE');
    const after = this.decodeTextpool(res.entries);
    return this.success({ program, language: res.language, mode, entries_before: res.before, entries_after: after.length, entries: after });
  }

  // ── GUI status (CUA) ───────────────────────────────────────────────────────

  private static readonly CUA_TYPES = `TYPES: BEGIN OF ty_cua,
         adm TYPE rsmpe_adm,
         sta TYPE STANDARD TABLE OF rsmpe_stat WITH EMPTY KEY,
         fun TYPE STANDARD TABLE OF rsmpe_funt WITH EMPTY KEY,
         men TYPE STANDARD TABLE OF rsmpe_men  WITH EMPTY KEY,
         mtx TYPE STANDARD TABLE OF rsmpe_mnlt WITH EMPTY KEY,
         act TYPE STANDARD TABLE OF rsmpe_act  WITH EMPTY KEY,
         but TYPE STANDARD TABLE OF rsmpe_but  WITH EMPTY KEY,
         pfk TYPE STANDARD TABLE OF rsmpe_pfk  WITH EMPTY KEY,
         set TYPE STANDARD TABLE OF rsmpe_staf WITH EMPTY KEY,
         doc TYPE STANDARD TABLE OF rsmpe_atrt WITH EMPTY KEY,
         tit TYPE STANDARD TABLE OF rsmpe_titt WITH EMPTY KEY,
         biv TYPE STANDARD TABLE OF rsmpe_buts WITH EMPTY KEY,
       END OF ty_cua.`;

  private static readonly CUA_FETCH = (program: string) => `CALL FUNCTION 'RS_CUA_INTERNAL_FETCH'
  EXPORTING
    program         = '${program}'
    language        = lv_lang
  IMPORTING
    adm             = ls_cua-adm
  TABLES
    sta             = ls_cua-sta
    fun             = ls_cua-fun
    men             = ls_cua-men
    mtx             = ls_cua-mtx
    act             = ls_cua-act
    but             = ls_cua-but
    pfk             = ls_cua-pfk
    set             = ls_cua-set
    doc             = ls_cua-doc
    tit             = ls_cua-tit
    biv             = ls_cua-biv
  EXCEPTIONS
    not_found       = 1
    unknown_version = 2
    OTHERS          = 3.`;

  /** "F3" / "SHIFT+F3" / "CTRL+SHIFT+F2" / 15 → 2-digit PF number. */
  private pfno(key: any, where: string): string {
    const s = String(key ?? '').trim().toUpperCase().replace(/\s+/g, '');
    let n: number;
    if (/^\d{1,2}$/.test(s)) n = Number(s);
    else if (s === 'CTRL+S') n = 11;
    else {
      const m = s.match(/^((?:CTRL\+|SHIFT\+)*)F(\d{1,2})$/);
      if (!m) this.fail(`${where}: cannot parse key "${key}" — use e.g. "F3", "SHIFT+F3", "CTRL+F1" or a number 1-99.`);
      const f = Number(m![2]);
      if (f < 1 || f > 12) this.fail(`${where}: function key must be F1..F12 (got "${key}").`);
      const mods = m![1];
      n = f + (mods.includes('SHIFT+') ? 12 : 0) + (mods.includes('CTRL+') ? 24 : 0);
    }
    if (n < 1 || n > 99) this.fail(`${where}: key number out of range (${n}).`);
    return String(n).padStart(2, '0');
  }

  private keyName(pfno: string): string {
    const n = Number(pfno);
    if (!n) return pfno;
    if (n <= 12) return `F${n}`;
    if (n <= 24) return `SHIFT+F${n - 12}`;
    if (n <= 36) return `CTRL+F${n - 24}`;
    if (n <= 48) return `CTRL+SHIFT+F${n - 36}`;
    return pfno;
  }

  private modelFromCua(c: any): { statuses: any[]; titles: any[]; has_menus: boolean } {
    const fun = new Map<string, any>();
    for (const f of c.fun || []) if (!fun.has(f.code)) fun.set(f.code, f);
    const statuses = (c.sta || []).map((s: any) => {
      const tb = new Set((c.but || []).filter((b: any) => b.pfk_code === s.pfkcode && b.code === s.butcode).map((b: any) => b.pfno));
      const active = new Set((c.set || []).filter((x: any) => x.status === s.code).map((x: any) => x.function));
      const keys = (c.pfk || [])
        .filter((p: any) => p.code === s.pfkcode && (active.size === 0 || active.has(p.funcode)))
        .map((p: any) => {
          const f = fun.get(p.funcode) || {};
          return {
            key: this.keyName(p.pfno), fcode: p.funcode, text: f.fun_text || '',
            ...(f.text_name ? { icon: f.text_name } : {}),
            ...(f.icon_text ? { icon_text: f.icon_text } : {}),
            ...(f.info_text ? { info_text: f.info_text } : {}),
            ...(tb.has(p.pfno) ? { toolbar: true } : {}),
          };
        });
      return { code: s.code, description: s.int_note || '', keys };
    });
    const titles = (c.tit || []).map((t: any) => ({ code: t.code, text: t.text }));
    return { statuses, titles, has_menus: (c.men || []).length > 0 || (c.act || []).length > 0 };
  }

  private async guiStatusRead(args: any): Promise<any> {
    const program = this.objName(args.program, 'program');
    const body = `${this.progCheckAbap(program)}
${this.langAbap(this.langArg(args.language), 'PROG', program)}
${ClassicHandlers.CUA_TYPES}
DATA ls_cua TYPE ty_cua.
${ClassicHandlers.CUA_FETCH(program)}
IF sy-subrc > 1.
  out->write( |ERROR:RS_CUA_INTERNAL_FETCH subrc={ sy-subrc }| ).
  RETURN.
ENDIF.
${ClassicHandlers.JSON_OUT('ls_cua')}`;
    const cua = await this.runJson('abap_gui_status_read', body, 'ZCL_TMP_CUA_READ');
    const model = this.modelFromCua(cua);
    return this.success({
      program, ...model,
      ...(model.has_menus ? { warning: 'This program has menu-bar definitions; abap_gui_status_write would drop them.' } : {}),
      ...(args.raw === true ? { raw: cua } : {}),
    });
  }

  private async guiStatusWrite(args: any): Promise<any> {
    const program = this.objName(args.program, 'program');
    const statusesIn = Array.isArray(args.statuses) ? args.statuses : [];
    if (!statusesIn.length) this.fail('abap_gui_status_write: statuses must be a non-empty array.');
    const p6 = (n: number) => String(n).padStart(6, '0');

    const sta: any[] = [], pfk: any[] = [], but: any[] = [], set: any[] = [], doc: any[] = [];
    const fun = new Map<string, any>();
    const seenStatus = new Set<string>();

    statusesIn.forEach((s: any, i: number) => {
      const code = String(s.code ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9_]{1,20}$/.test(code)) this.fail(`statuses[${i}].code is invalid ("${s.code}") — max 20 chars, letters/digits/_.`);
      if (seenStatus.has(code)) this.fail(`statuses: duplicate status code "${code}".`);
      seenStatus.add(code);
      const n = p6(i + 1);
      const note = String(s.description || code).slice(0, 79);
      sta.push({ code, modal: 'D', actcode: n, pfkcode: n, butcode: '0001', int_note: note });
      doc.push({ obj_type: 'A', obj_code: n, modal: 'D', int_note: note });
      doc.push({ obj_type: 'P', obj_code: n, modal: 'D', int_note: note });
      doc.push({ obj_type: 'B', obj_code: n, sub_code: '0001', modal: 'D', int_note: note });

      const keys = Array.isArray(s.keys) ? s.keys : [];
      if (!keys.length) this.fail(`statuses[${i}] (${code}): keys must list at least one function (e.g. BACK on F3).`);
      const usedPf = new Set<string>();
      let btn = 0;
      keys.forEach((k: any, j: number) => {
        const where = `statuses[${i}].keys[${j}]`;
        const fcode = String(k.fcode ?? '').trim().toUpperCase();
        if (!fcode || fcode.length > 20) this.fail(`${where}: fcode is required (max 20 chars).`);
        const pf = this.pfno(k.key, where);
        if (usedPf.has(pf)) this.fail(`${where}: key ${this.keyName(pf)} is assigned twice in status ${code}.`);
        usedPf.add(pf);
        const text = String(k.text ?? '').trim();
        if (!text) this.fail(`${where}: text is required (function text shown to the user).`);
        if (!fun.has(fcode)) {
          fun.set(fcode, {
            code: fcode, textno: '001', text_type: 'S', fun_text: text.slice(0, 40),
            text_name: String(k.icon || '').trim().toUpperCase(),
            icon_text: String(k.icon_text || '').slice(0, 40),
            info_text: String(k.info_text || '').slice(0, 40),
          });
        }
        pfk.push({ code: n, pfno: pf, funcode: fcode, funno: '001' });
        set.push({ status: code, function: fcode });
        if (k.toolbar === true) {
          btn++;
          but.push({ pfk_code: n, code: '0001', no: String(btn).padStart(2, '0'), pfno: pf });
        }
      });
    });

    const tit = (Array.isArray(args.titles) ? args.titles : []).map((t: any, i: number) => {
      const code = String(t.code ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9_]{1,20}$/.test(code)) this.fail(`titles[${i}].code is invalid ("${t.code}").`);
      const text = String(t.text ?? '');
      if (!text) this.fail(`titles[${i}].text is required.`);
      return { code, text: text.slice(0, 70) };
    });

    const last = p6(statusesIn.length);
    const payload = { adm: { actcode: last, pfkcode: last }, sta, fun: [...fun.values()], pfk, but, set, doc, tit };

    const body = `${ClassicHandlers.CUA_TYPES}
SELECT SINGLE subc FROM trdir WHERE name = '${program}' INTO @DATA(lv_subc).
IF sy-subrc <> 0.
  out->write( |ERROR:program ${program} does not exist| ).
  RETURN.
ENDIF.
SELECT SINGLE state FROM progdir WHERE name = '${program}' AND state = 'A' INTO @DATA(lv_state).
IF sy-subrc <> 0.
  out->write( |ERROR:program ${program} has no active version - activate it first| ).
  RETURN.
ENDIF.
${this.langAbap(this.langArg(args.language), 'PROG', program)}
${this.payloadAbap(payload, 'ty_cua')}
LOOP AT ls_in-fun ASSIGNING FIELD-SYMBOL(<ls_fun>) WHERE text_name IS NOT INITIAL.
  SELECT SINGLE id FROM icon WHERE name = @<ls_fun>-text_name INTO @DATA(lv_icon).
  IF sy-subrc <> 0.
    out->write( |ERROR:unknown icon { <ls_fun>-text_name } for function { <ls_fun>-code }| ).
    RETURN.
  ENDIF.
  <ls_fun>-icon_id = lv_icon.
ENDLOOP.
DATA ls_trkey TYPE trkey.
SELECT SINGLE devclass FROM tadir
  WHERE pgmid = 'R3TR' AND object = 'PROG' AND obj_name = '${program}'
  INTO @ls_trkey-devclass.
ls_trkey-obj_type = 'PROG'.
ls_trkey-obj_name = '${program}'.
ls_trkey-sub_type = 'CUAD'.
ls_trkey-sub_name = '${program}'.
CALL FUNCTION 'RS_CUA_INTERNAL_WRITE'
  EXPORTING
    program      = '${program}'
    language     = lv_lang
    tr_key       = ls_trkey
    adm          = ls_in-adm
    state        = 'A'
  TABLES
    sta          = ls_in-sta
    fun          = ls_in-fun
    men          = ls_in-men
    mtx          = ls_in-mtx
    act          = ls_in-act
    but          = ls_in-but
    pfk          = ls_in-pfk
    set          = ls_in-set
    doc          = ls_in-doc
    tit          = ls_in-tit
    biv          = ls_in-biv
  EXCEPTIONS
    not_found    = 1
    invalid_data = 2
    OTHERS       = 3.
IF sy-subrc <> 0.
  MESSAGE ID sy-msgid TYPE 'S' NUMBER sy-msgno WITH sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4 INTO DATA(lv_msg).
  out->write( |ERROR:RS_CUA_INTERNAL_WRITE subrc={ sy-subrc } { lv_msg }| ).
  RETURN.
ENDIF.
COMMIT WORK.
DATA ls_cua TYPE ty_cua.
${ClassicHandlers.CUA_FETCH(program)}
${ClassicHandlers.JSON_OUT('ls_cua')}`;
    const cua = await this.runJson('abap_gui_status_write', body, 'ZCL_TMP_CUA_WRITE');
    const model = this.modelFromCua(cua);
    const missing = [...seenStatus].filter(c => !model.statuses.some((s: any) => s.code === c));
    if (missing.length) this.fail(`abap_gui_status_write: write returned OK but status(es) ${missing.join(', ')} are not on the system afterwards.`);
    return this.success({ program, written: { statuses: model.statuses.length, titles: model.titles.length }, ...model });
  }

  // ── messages (T100) ────────────────────────────────────────────────────────

  private async messageRead(args: any): Promise<any> {
    const cls = this.objName(args.message_class, 'message_class', 20);
    const lang = this.langArg(args.language);
    // Read-only path: plain SQL, no temporary class.
    const q: any = await this.withSession(() =>
      this.adtclient.runQuery(`SELECT ARBGB, MASTERLANG FROM T100A WHERE ARBGB = '${cls}'`, 1));
    const head = q?.values?.[0];
    if (!head) this.fail(`abap_message_read: message class ${cls} does not exist.`);
    let sapLang = lang.length === 1 ? lang : '';
    if (lang.length === 2) {
      const l: any = await this.withSession(() =>
        this.adtclient.runQuery(`SELECT SPRAS FROM T002 WHERE LAISO = '${lang}'`, 1));
      sapLang = l?.values?.[0]?.SPRAS || '';
      if (!sapLang) this.fail(`abap_message_read: unknown language ${lang}.`);
    }
    if (!sapLang) sapLang = head.MASTERLANG;
    const r: any = await this.withSession(() =>
      this.adtclient.runQuery(`SELECT MSGNR, TEXT FROM T100 WHERE ARBGB = '${cls}' AND SPRSL = '${sapLang}' ORDER BY MSGNR`, 1000));
    const messages = (r?.values || []).map((m: any) => ({ number: m.MSGNR, text: m.TEXT }));
    return this.success({ message_class: cls, master_language: head.MASTERLANG, language: sapLang, count: messages.length, messages });
  }

  private async messageWrite(args: any): Promise<any> {
    const cls = this.objName(args.message_class, 'message_class', 20);
    const raw = Array.isArray(args.messages) ? args.messages : [];
    if (!raw.length) this.fail('abap_message_write: messages must be a non-empty array.');
    const seen = new Set<string>();
    const messages = raw.map((m: any, i: number) => {
      const n = String(m.number ?? '').trim();
      if (!/^\d{1,3}$/.test(n)) this.fail(`messages[${i}].number must be 0-999 (got "${m.number}").`);
      const number = n.padStart(3, '0');
      if (seen.has(number)) this.fail(`messages: number ${number} appears twice.`);
      seen.add(number);
      const text = String(m.text ?? '');
      if (!text) this.fail(`messages[${i}].text is required.`);
      if (text.length > 73) this.fail(`messages[${i}].text is ${text.length} chars — T100 allows max 73.`);
      return { msgnr: number, text };
    });

    const body = `TYPES: BEGIN OF ty_m,
         msgnr TYPE t100-msgnr,
         text  TYPE t100-text,
       END OF ty_m.
TYPES: BEGIN OF ty_in,
         messages TYPE STANDARD TABLE OF ty_m WITH EMPTY KEY,
       END OF ty_in.
SELECT SINGLE masterlang FROM t100a WHERE arbgb = '${cls}' INTO @DATA(lv_master).
IF sy-subrc <> 0 OR lv_master IS INITIAL.
  out->write( |ERROR:message class ${cls} does not exist - create it first (abap_create type MSAG)| ).
  RETURN.
ENDIF.
${this.langAbap(this.langArg(args.language), 'MSAG', cls)}
${this.payloadAbap({ messages }, 'ty_in')}
DATA lt_t100  TYPE STANDARD TABLE OF t100 WITH EMPTY KEY.
DATA lt_t100u TYPE STANDARD TABLE OF t100u WITH EMPTY KEY.
DATA lv_master_added TYPE i.
LOOP AT ls_in-messages INTO DATA(ls_m).
  APPEND VALUE #( sprsl = lv_lang arbgb = '${cls}' msgnr = ls_m-msgnr text = ls_m-text ) TO lt_t100.
  IF lv_lang <> lv_master.
    SELECT SINGLE msgnr FROM t100
      WHERE sprsl = @lv_master AND arbgb = '${cls}' AND msgnr = @ls_m-msgnr
      INTO @DATA(lv_dummy).
    IF sy-subrc <> 0.
      APPEND VALUE #( sprsl = lv_master arbgb = '${cls}' msgnr = ls_m-msgnr text = ls_m-text ) TO lt_t100.
      lv_master_added = lv_master_added + 1.
    ENDIF.
  ENDIF.
  APPEND VALUE #( arbgb = '${cls}' msgnr = ls_m-msgnr name = sy-uname datum = sy-datum selfdef = '3' ) TO lt_t100u.
ENDLOOP.
MODIFY t100 FROM TABLE lt_t100.
IF sy-subrc <> 0.
  out->write( |ERROR:T100 update failed, subrc={ sy-subrc }| ).
  ROLLBACK WORK.
  RETURN.
ENDIF.
MODIFY t100u FROM TABLE lt_t100u.
COMMIT WORK.
TYPES: BEGIN OF ty_out,
         language     TYPE sy-langu,
         master       TYPE sy-langu,
         master_added TYPE i,
         written      TYPE i,
       END OF ty_out.
DATA(ls_out) = VALUE ty_out( language = lv_lang master = lv_master master_added = lv_master_added
                             written = lines( ls_in-messages ) ).
${ClassicHandlers.JSON_OUT('ls_out')}`;
    const res = await this.runJson('abap_message_write', body, 'ZCL_TMP_MSG_WRITE');
    return this.success({
      message_class: cls, language: res.language, master_language: res.master,
      written: res.written,
      ...(res.master_added ? { note: `${res.master_added} message(s) were also created in master language ${res.master} with the same text — translate them there if needed.` } : {}),
      messages: messages.map((m: any) => ({ number: m.msgnr, text: m.text })),
    });
  }
}
