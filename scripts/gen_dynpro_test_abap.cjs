#!/usr/bin/env node
/**
 * Generate the ABAP method bodies that DynproHandlers would emit, so we can
 * smoke-test them through the existing abap_run MCP tool without waiting for
 * the new dynpro_* tools to be re-registered.
 *
 * Usage:
 *   node scripts/gen_dynpro_test_abap.cjs <op> <program> <dynnr> [json-payload]
 *
 *   op       = read | create | update | delete
 *   payload  = JSON string with {header, fields, flow} — only for create/update
 *
 * Prints the ABAP source to stdout so it can be piped or copied into abap_run.
 */
const op = process.argv[2];
const program = process.argv[3];
const dynnr = String(process.argv[4] || '').padStart(4, '0');
const payloadArg = process.argv[5];

function chunkB64(b64) {
  const SIZE = 100;
  const parts = [];
  for (let i = 0; i < b64.length; i += SIZE) parts.push(b64.slice(i, i + SIZE));
  if (parts.length === 0) return '``';
  return parts.map((c, i) => (i === 0 ? `\`${c}\`` : `         && \`${c}\``)).join('\n');
}

function buildRead(prog, dn) {
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
    progname             = '${prog}'
    dynnr                = '${dn}'
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

function normalizeField(f) {
  const type = String(f.type || '').toUpperCase();
  const bool = (v) => (v === true || v === 'X' || v === 'x') ? 'X' : ' ';
  return {
    type,
    name: String(f.name || ''),
    text: String(f.text || ''),
    line: Number(f.line || 0),
    column: Number(f.column || 0),
    length: Number(f.length || 0),
    vislength: Number(f.vislength || 0),
    height: Number(f.height || 0),
    input_fld: bool(f.input_fld),
    output_fld: bool(f.output_fld),
    group1: String(f.group1 || ''),
    push_fcode: String(f.push_fcode || ''),
    push_ftype: String(f.push_ftype || (type === 'PUSH' ? 'E' : '')),
    format: String(f.format || '')
  };
}

function buildWrite(prog, dn, mode, transport, payload) {
  const header = {
    program: prog,
    screen: dn,
    type: String(payload.header.type || 'N').toUpperCase(),
    lines: Number(payload.header.lines || 20),
    columns: Number(payload.header.columns || 80),
    nextscreen: String(payload.header.nextscreen ?? '0'),
    descript: String(payload.header.descript || ''),
    language: String(payload.header.language || ''),
    cursor_pos: String(payload.header.cursor_pos || '')
  };
  const fields = (payload.fields || []).map(normalizeField);
  const flow = (payload.flow || []).map(l => String(l));
  const json = JSON.stringify({ header, fields, flow });
  const b64 = Buffer.from(json, 'utf-8').toString('base64');
  const chunked = chunkB64(b64);
  const existFlag = mode === 'update' ? 'X' : ' ';
  const tr = (transport || '').toUpperCase();
  const corrCond = tr ? `'${tr}'` : `''`;
  const suppressCorrCond = tr ? `' '` : `'X'`;

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

TYPES: BEGIN OF ty_payload,
         header TYPE rpy_dyhead,
         fields TYPE tt_fld,
         flow   TYPE STANDARD TABLE OF string WITH EMPTY KEY,
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

function buildDelete(prog, dn, transport) {
  const suppressCorrCond = transport ? `' '` : `'X'`;
  return `CALL FUNCTION 'RS_DYNPRO_DELETE'
  EXPORTING
    progname        = '${prog}'
    dynnr           = '${dn}'
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

let abap;
if (op === 'read') {
  abap = buildRead(program.toUpperCase(), dynnr);
} else if (op === 'create' || op === 'update') {
  if (!payloadArg) {
    console.error('Missing JSON payload arg for create/update');
    process.exit(2);
  }
  const payload = JSON.parse(payloadArg);
  abap = buildWrite(program.toUpperCase(), dynnr, op, '', payload);
} else if (op === 'delete') {
  abap = buildDelete(program.toUpperCase(), dynnr, '');
} else {
  console.error(`Unknown op: ${op}`);
  process.exit(2);
}

process.stdout.write(abap);
