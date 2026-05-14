# Screen Painter MCP Tools — Implementation Plan

**Hedef:** dassian-adt MCP server'ına SAP dynpro (Screen Painter) CRUD desteği eklemek. Sonuç: Tek MCP çağrısı ile screen yarat, oku, düzenle, sil.

**Durum:** POC tamamen kanıtlandı (Tosyali H4D'de). Şu an sadece TypeScript handler yazılıp build edilecek.

**Sistem:** Tosyali H4D (S/4HANA 757). SOAP RFC kapalı (403); ADT'nin dynpro endpoint'i yok; abap_run + RPY_DYNPRO_* code-gen yolu çalışıyor.

---

## 1. Mimari Karar

```
TS handler  →  abap_run (mevcut)  →  geçici ZCL_TMP_DYNPRO_* class
                                          ↓
                              RPY_DYNPRO_READ / INSERT / RS_DYNPRO_DELETE
                                          ↓
                              /ui2/cl_json=>serialize  (READ output)
                              cl_http_utility=>decode_x_base64 + deserialize  (WRITE input)
```

- **node-rfc YOK** (Windows'ta native binding sıkıntısı).
- **SOAP RFC YOK** (Tosyali'da SICF kapalı).
- **Z FM YOK** (kullanıcı: "direkt standard RPY_DYNPRO_*").
- **ADT REST endpoint YOK** (`/programs/programs/.../dynpros/{nr}` hepsi 404).

Sadece **abap_run mekanizmasını yeniden kullanan ABAP code-gen** — yeni bağımlılık yok.

---

## 2. POC Doğrulama Sonuçları (Tosyali H4D, 2026-05-14)

Test fixture: `Z_CLAUDE_SCREEN_TEST` programı (PROG/P, $TMP), 9000 dynpro — **canlı duruyor, dokunma**.

| Adım | FM | Sonuç |
|---|---|---|
| Boş dynpro yarat | RPY_DYNPRO_INSERT | subrc=0, otomatik SCREEN container + OKCODE field eklendi |
| Aynı dynpro'yu oku | RPY_DYNPRO_READ | header/flow/containers/f2c round-trip ✓ |
| Full form yarat (TEXT+TEMPLATE+CHECK+RADIO×2+PUSH) | RPY_DYNPRO_INSERT (suppress_exist='X') | subrc=0 — overwrite çalışıyor |
| Full form'u oku | RPY_DYNPRO_READ | 7 element round-trip ✓ (6 user + 1 auto OKCODE) |
| Delete | RS_DYNPRO_DELETE | İmza onaylandı; POPUP='X' interactive — bizimki POPUP=' ' kullanacak |

### Element vocabulary (round-trip doğrulandı)

| F2C type | SE51 anlamı | Ekstra attribute |
|---|---|---|
| TEXT | Statik label | — |
| TEMPLATE | Input/output field | input_fld, output_fld |
| CHECK | Checkbox | — |
| RADIO | Radio button | **group1** (grup adı) |
| PUSH | Pushbutton | **push_fcode** + **push_ftype** ('E') |
| OKCODE | OK code (otomatik) | — |
| (henüz test edilmedi) BOX, SUB, TAB | Group box / subscreen / tabstrip | — |

### Kritik constraint'ler

1. **CONTAINERS tablosuna SCREEN eklemek zorunlu.** Yoksa F2C entry'leri sessizce silinir (subrc=0 dönmesine rağmen alanlar yok olur). RPY_DYNPRO_CVT_FROM_EXTFORMAT iç loop'u `WHERE CONT_NAME = container.name` ile çalışır — container yoksa loop boş.
   ```abap
   APPEND VALUE #( type = 'SCREEN' name = 'SCREEN'
                   line = 0 column = 0 length = 80 height = 8 ) TO lt_containers.
   ```

2. **`I/O` field type YOK.** Input field için doğru type **`TEMPLATE`** (`I/O` SE51 GUI etiketi, API'da tanınmıyor — `XI-111` hatası).

3. **F2C `cont_type` + `cont_name` exact match olmalı.** SCREEN container için ikisi de literal 'SCREEN'.

4. **POPUP=' ' bypass.** RS_DYNPRO_DELETE default POPUP='X' interaktif dialog açar, abap_run hang yapar. Mutlaka `popup = ' '` geç.

5. **suppress_exist_checks** = create/update farkı:
   - `' '` → CREATE (zaten varsa ALREADY_EXISTS exception)
   - `'X'` → UPDATE (overwrite mode)

6. **`VALUE #( a = 1 b = 2 )`** ABAP'ta `=` öncesi/sonrası boşluk zorunlu — code-gen template'i bu kuralı uygulamalı.

---

## 3. FM İmzaları (Tam — abap_get_source ile çekildi)

### RPY_DYNPRO_READ (FUGR/FF, fugr=SIFP, package SEUX)
```
IMPORTING
  PROGNAME              TYPE D020S-PROG
  DYNNR                 TYPE D020S-DNUM
  SUPPRESS_EXIST_CHECKS TYPE C DEFAULT ' '
  SUPPRESS_CORR_CHECKS  TYPE C DEFAULT ' '
EXPORTING
  HEADER                TYPE RPY_DYHEAD
TABLES
  CONTAINERS            TYPE DYCATT_TAB     OPTIONAL
  FIELDS_TO_CONTAINERS  TYPE DYFATC_TAB     OPTIONAL
  FLOW_LOGIC            TYPE RPY_DYFLOW     OPTIONAL  ← STANDARD TABLE OF rpy_dyflow
  PARAMS                TYPE RPY_DYPARA     OPTIONAL  ← STANDARD TABLE OF rpy_dypara
  FIELDS_LIST           TYPE D021S          OPTIONAL  ← native fields (base64 binary — ignore)
EXCEPTIONS
  CANCELLED, NOT_FOUND, PERMISSION_ERROR
```

### RPY_DYNPRO_INSERT (FUGR/FF, fugr=SIFP)
```
IMPORTING
  SUPPRESS_CORR_CHECKS     TYPE C DEFAULT ' '
  CORRNUM                  TYPE E071-TRKORR DEFAULT SPACE   ← transport number
  SUPPRESS_EXIST_CHECKS    TYPE C DEFAULT ' '               ← 'X' = update/overwrite
  SUPPRESS_GENERATE        TYPE C DEFAULT ' '
  SUPPRESS_DICT_SUPPORT    TYPE C DEFAULT ' '
  SUPPRESS_EXTENDED_CHECKS TYPE C DEFAULT ' '               ← 'X' önerilir (pozisyon overlap check skip)
  HEADER                   TYPE RPY_DYHEAD
  USE_CORRNUM_IMMEDIATEDLY TYPE C DEFAULT ' '
  SUPPRESS_COMMIT_WORK     TYPE C DEFAULT ' '
TABLES
  CONTAINERS               TYPE DYCATT_TAB
  FIELDS_TO_CONTAINERS     TYPE DYFATC_TAB
  FLOW_LOGIC               TYPE RPY_DYFLOW
  PARAMS                   TYPE RPY_DYPARA  OPTIONAL
EXCEPTIONS
  CANCELLED, ALREADY_EXISTS, PROGRAM_NOT_EXISTS, NOT_EXECUTED,
  MISSING_REQUIRED_FIELD, ILLEGAL_FIELD_VALUE, FIELD_NOT_ALLOWED,
  NOT_GENERATED, ILLEGAL_FIELD_POSITION
```

### RS_DYNPRO_DELETE (FUGR/FF, fugr=SEUS, package SCRP)
```
IMPORTING
  DYNNR            TYPE ANY
  POPUP            TYPE SEU_BOOL DEFAULT 'X'   ← BUNU ' ' GEÇ! Yoksa hang.
  PROGNAME         TYPE ANY
  SUPPRESS_CHECKS  TYPE SEU_BOOL DEFAULT ' '   ← 'X' = permission/lock check skip
  SUPPRESS_CORR    TYPE SEU_BOOL DEFAULT ' '   ← 'X' = transport check skip ($TMP için)
EXCEPTIONS
  DYNPRO_NOT_FOUND, DYNPRO_NOT_SPECIFIED, NOT_EXECUTED, PERMISSION_FAILURE
```

### RPY_DYHEAD Struct (External format header)
Alanlar (round-trip görüldü):
```
program, screen, language, descript, type, nextscreen, cursor_pos,
screen_grp, lines, columns, hold_data, fixed_font, no_compr,
no_execute, keep_scpos, no_toolbar, ctx_menon, fiorienlargeoff
```
- `type` = `N` (normal), `M` (modal), `S` (subscreen), `L` (list)
- `lines`/`columns` integer

---

## 4. TS Implementasyon — Dosya ve Yapı

### Yeni dosya: `src/handlers/DynproHandlers.ts`

Mevcut handler pattern'ini takip et — `BaseHandler` extend, `getTools()` + `handle()` + per-tool private metodlar. Model olarak `src/handlers/RunHandlers.ts` (özellikle `handleRun` ve `buildClassSource`) ve `src/handlers/SourceHandlers.ts` kullan.

```typescript
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import type { ToolDefinition } from '../types/tools.js';
import { formatError } from '../lib/errors.js';

export class DynproHandlers extends BaseHandler {
  getTools(): ToolDefinition[] { /* 4 tool spec */ }
  async handle(toolName: string, args: any): Promise<any> { /* switch */ }

  private async handleRead(args): Promise<any> { /* ... */ }
  private async handleCreate(args): Promise<any> { /* ... */ }
  private async handleUpdate(args): Promise<any> { /* ... */ }
  private async handleDelete(args): Promise<any> { /* ... */ }

  // ABAP code-gen helpers
  private buildReadAbap(program: string, dynnr: string): string { /* ... */ }
  private buildWriteAbap(payload: object, mode: 'create' | 'update', transport?: string): string { /* ... */ }
  private buildDeleteAbap(program: string, dynnr: string, transport?: string): string { /* ... */ }

  // Run wrapper — reuse RunHandlers.handleRun pattern
  private async runAbap(methodBody: string, className: string): Promise<string> { /* ... */ }

  // Parse stdout output that starts with "JSON: { ... }"
  private extractJson(output: string, marker: string): any { /* ... */ }
}
```

### `src/index.ts` — Kayıt

3 yere ekleme:
1. Import: `import { DynproHandlers } from './handlers/DynproHandlers.js';`
2. Field: `private dynproHandlers: DynproHandlers;` ve `this.dynproHandlers = new DynproHandlers(this.adtClient);`
3. `allHandlers()` listesine ekle.

---

## 5. Tool Şemaları

### `abap_dynpro_read`
```yaml
description: |
  Read a SAP dynpro (screen) by program name and screen number. Returns the full
  external-format definition: header, containers, fields_to_containers (element list),
  flow_logic (PBO/PAI ABAP statements), and params. Use this before editing a screen
  to capture its current state. The fields_list (native D021S) is intentionally excluded
  because it contains base64-encoded binary internal-format data not useful externally.
inputSchema:
  program:        { type: string, description: "ABAP program name (e.g. SAPMV45A, Z_MY_PROG)" }
  dynpro_number:  { type: string, description: "4-digit screen number (e.g. '9000')" }
required: [program, dynpro_number]
```

### `abap_dynpro_create`
```yaml
description: |
  Create a new SAP dynpro. Fails with ALREADY_EXISTS if the screen number is in use —
  use abap_dynpro_update to modify an existing one. Automatically adds the mandatory
  SCREEN container; you only need to specify element fields. For $TMP package omit transport.
inputSchema:
  program:        { type: string }
  dynpro_number:  { type: string }
  header:
    type: object
    properties:
      type:        { type: string, enum: [N, M, S, L], default: N }
      lines:       { type: number, minimum: 1, maximum: 200 }
      columns:     { type: number, minimum: 1, maximum: 255 }
      nextscreen:  { type: string, default: '0' }
      descript:    { type: string }
  fields:
    type: array
    items:
      type: object
      properties:
        type:        { type: string, enum: [TEXT, TEMPLATE, CHECK, RADIO, PUSH, BOX, SUB, TAB] }
        name:        { type: string }
        text:        { type: string }
        line:        { type: number }
        column:      { type: number }
        length:      { type: number }
        vislength:   { type: number }   # optional, defaults to length
        height:      { type: number, default: 1 }
        input_fld:   { type: boolean }
        output_fld:  { type: boolean }
        group1:      { type: string }   # for RADIO grouping
        push_fcode:  { type: string }   # for PUSH
        push_ftype:  { type: string, default: E }  # for PUSH
        format:      { type: string, default: CHAR }
  flow_logic:
    type: array
    items: { type: string }
    description: "PBO/PAI lines. Example: ['PROCESS BEFORE OUTPUT.', '  MODULE STATUS_9000.', 'PROCESS AFTER INPUT.', '  MODULE USER_COMMAND_9000.']"
  transport: { type: string, description: "Transport request (omit for $TMP)" }
required: [program, dynpro_number, header, fields, flow_logic]
```

### `abap_dynpro_update`
Aynı `create`'in schema'sı, davranış farkı: `suppress_exist_checks='X'` → overwrite. Yoksa NOT_FOUND.

### `abap_dynpro_delete`
```yaml
description: |
  Delete a SAP dynpro. Calls RS_DYNPRO_DELETE with POPUP=' ' (non-interactive),
  SUPPRESS_CHECKS='X', and SUPPRESS_CORR='X' if transport omitted ($TMP).
inputSchema:
  program:        { type: string }
  dynpro_number:  { type: string }
  transport:      { type: string }
required: [program, dynpro_number]
```

---

## 6. ABAP Code-gen Şablonları

### READ template
```abap
DATA: ls_header TYPE rpy_dyhead,
      lt_cont   TYPE dycatt_tab,
      lt_f2c    TYPE dyfatc_tab,
      lt_flow   TYPE STANDARD TABLE OF rpy_dyflow,
      lt_params TYPE STANDARD TABLE OF rpy_dypara,
      lt_fields TYPE STANDARD TABLE OF d021s.

CALL FUNCTION 'RPY_DYNPRO_READ'
  EXPORTING
    progname             = '${PROGRAM}'
    dynnr                = '${DYNNR}'
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

IF sy-subrc <> 0.
  out->write( |ERROR:{ sy-subrc }:{ sy-msgid }-{ sy-msgno }:{ sy-msgv1 } { sy-msgv2 } { sy-msgv3 } { sy-msgv4 }| ).
  RETURN.
ENDIF.

DATA(lv_payload) = VALUE string( ).
" Marker-wrapped JSON for safe extraction
out->write( |__BEGIN_DYNPRO_JSON__| ).
out->write( /ui2/cl_json=>serialize(
  data = VALUE #(
    header     = ls_header
    containers = lt_cont
    fields     = lt_f2c
    flow       = lt_flow
    params     = lt_params
  )
  pretty_name = /ui2/cl_json=>pretty_mode-low_case
) ).
out->write( |__END_DYNPRO_JSON__| ).
```

TS-side parse: stdout'taki `__BEGIN_DYNPRO_JSON__\n{...}\n__END_DYNPRO_JSON__` markerları arasını al, JSON.parse.

### WRITE (CREATE/UPDATE) template — base64 payload yaklaşımı

Büyük element listesi için string-literal escape sorunu olmaması adına base64+deserialize:

```abap
TYPES: BEGIN OF ty_fld,
         cont_type   TYPE c LENGTH 30,
         cont_name   TYPE c LENGTH 30,
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

DATA(lv_b64) = `${BASE64_PAYLOAD}`.   " TS injects here

DATA(lv_xstring) = cl_http_utility=>decode_x_base64( lv_b64 ).
DATA(lv_json)    = cl_abap_codepage=>convert_from( lv_xstring ).

DATA ls_payload TYPE ty_payload.
/ui2/cl_json=>deserialize(
  EXPORTING json = lv_json pretty_name = /ui2/cl_json=>pretty_mode-low_case
  CHANGING  data = ls_payload ).

" Convert TS field list → DYFATC_TAB
DATA: lt_cont TYPE dycatt_tab,
      lt_f2c  TYPE dyfatc_tab,
      lt_flow TYPE STANDARD TABLE OF rpy_dyflow,
      lt_params TYPE STANDARD TABLE OF rpy_dypara.

" Auto-inject SCREEN container (mandatory constraint)
APPEND VALUE #( type = 'SCREEN' name = 'SCREEN'
                line = 0 column = 0
                length = ls_payload-header-columns
                height = ls_payload-header-lines ) TO lt_cont.

LOOP AT ls_payload-fields ASSIGNING FIELD-SYMBOL(<src>).
  APPEND VALUE #(
    cont_type  = 'SCREEN'  cont_name = 'SCREEN'
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
    push_ftype = <src>-push_ftype
  ) TO lt_f2c.
ENDLOOP.

LOOP AT ls_payload-flow INTO DATA(lv_line).
  APPEND VALUE #( line = lv_line ) TO lt_flow.
ENDLOOP.

CALL FUNCTION 'RPY_DYNPRO_INSERT'
  EXPORTING
    suppress_corr_checks     = COND #( WHEN '${TRANSPORT}' IS INITIAL THEN 'X' ELSE ' ' )
    corrnum                  = '${TRANSPORT}'
    suppress_exist_checks    = '${EXIST_FLAG}'   " ' ' = create, 'X' = update
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

out->write( |__DYNPRO_WRITE_RESULT__| ).
out->write( /ui2/cl_json=>serialize( data = VALUE #(
  subrc    = sy-subrc
  msgid    = sy-msgid
  msgno    = sy-msgno
  msgv1    = sy-msgv1
  msgv2    = sy-msgv2
  msgv3    = sy-msgv3
  msgv4    = sy-msgv4
  program  = ls_payload-header-program
  dynnr    = ls_payload-header-screen
) ) ).
```

### DELETE template
```abap
CALL FUNCTION 'RS_DYNPRO_DELETE'
  EXPORTING
    progname        = '${PROGRAM}'
    dynnr           = '${DYNNR}'
    popup           = ' '          " CRITICAL — no interactive dialog
    suppress_checks = 'X'
    suppress_corr   = COND #( WHEN '${TRANSPORT}' IS INITIAL THEN 'X' ELSE ' ' )
  EXCEPTIONS
    dynpro_not_found     = 1
    dynpro_not_specified = 2
    not_executed         = 3
    permission_failure   = 4
    OTHERS               = 5.

out->write( |__DYNPRO_DELETE_RESULT__| ).
out->write( /ui2/cl_json=>serialize( data = VALUE #(
  subrc = sy-subrc
  msgid = sy-msgid
  msgno = sy-msgno
  msgv1 = sy-msgv1
  msgv2 = sy-msgv2
  msgv3 = sy-msgv3
  msgv4 = sy-msgv4
) ) ).
```

---

## 7. ABAP Runner Reuse Stratejisi

`RunHandlers.handleRun` ABAP code'u **bir kez** çağırma için tasarlanmış — class create + lock + write + activate + classrun + delete. DynproHandler bunu reuse etmeli ama her tool için **farklı className** kullanmalı:

- `ZCL_TMP_DYNPRO_READ`
- `ZCL_TMP_DYNPRO_WRITE`
- `ZCL_TMP_DYNPRO_DELETE`

**İki seçenek:**

### A) RunHandlers'ı public bir helper'a refactor et (önerilen)
`RunHandlers.handleRun(args)` zaten public değil. Yeni bir public utility çıkar — örn. `runClass(methodBody, className): Promise<string>`. Hem RunHandlers hem DynproHandlers kullansın.

### B) DynproHandlers içinde abap_run tool'unu interna call et
`this.runHandlers.handle('abap_run', { methodBody, className })`. Ama bunun için DynproHandlers'a RunHandlers reference gerek — constructor injection veya `index.ts`'te bağla.

**Tercih: A.** Daha temiz API. RunHandlers'tan `executeAbap(methodBody, className): Promise<string>` adında bir public method çıkar (handleRun'ı sarmalayan ya da içinden çıkarılmış).

---

## 8. Implementation Steps (Yeni session için)

1. **Plan oku:** Bu dosyayı baştan sona oku, MEMORY.md'deki `project_screen_painter_plan` memory'ye bak.
2. **POC test fixture'ı doğrula:**
   - `mcp__sap-tosyali__abap_get_source` ile Z_CLAUDE_SCREEN_TEST var mı kontrol et
   - Yoksa POC adımlarını tekrarla (bu plandaki ABAP snippet'leri kullan)
3. **RunHandlers'ı refactor:** `handleRun` içindeki class-run logic'i `protected async executeAbap(methodBody: string, className: string): Promise<string>` adında bir method'a çıkar. `abap_run` tool'u bu helper'ı çağırsın.
4. **DynproHandlers yaz:**
   - `src/handlers/DynproHandlers.ts` oluştur
   - 4 tool spec + handle dispatcher + private metodlar
   - ABAP template'lerini bu plandan kopyala, `${PLACEHOLDER}` yerine TS template literal kullan
   - Base64 encoding: Node.js `Buffer.from(JSON.stringify(payload)).toString('base64')`
   - Marker-based output parsing
5. **index.ts'e kayda al:** import + field + allHandlers().
6. **Build:** `npm run build` (tsc).
7. **Reload MCP:** VSCode reload window.
8. **Smoke test:**
   - `mcp__sap-tosyali__abap_dynpro_read` Z_CLAUDE_SCREEN_TEST 9000 — POC'nin tüm 6 element'i geri gelmeli
   - Yeni screen yarat: 9001 — minimal header + 1 input field
   - Update: 9001'i farklı flow logic ile günceller
   - Delete: 9001 sil, 9000 dokunma
9. **Integration test yaz:** `src/__tests__/integration/dynpro.test.ts`.

---

## 9. Edge Cases / İleride

- **Subscreens (SUB type):** Container olarak parent screen + child subscreen lazım. F2C'de cont_type='SCREEN' yerine ayrı container.
- **Tab strips (TAB) / Table controls:** DYCATT_TAB'da tc_* alanları (tc_tabtype, tc_separ_v, tc_title vs). POC'de test edilmedi.
- **GUI status / titlebar:** Dynpro'nun parçası değil — ayrı obje (CUA). Kapsam dışı.
- **Field değişikliği yarım kalırsa:** RPY_DYNPRO_INSERT atomic mi? Hayır, GENERATE DYNPRO + R/3-EU export iki adım. Hata durumda ROLLBACK manual gerekli mi belirsiz. INSERT içinde subrc=0 ise commit garantili.
- **Locking:** RS_DYNPRO_DELETE lock kontrolü yapar (`RS_ACCESS_PERMISSION`). suppress_checks='X' bunu atlar — production'da dikkat. INSERT/UPDATE de kendi içinde lock yönetir.
- **Master language:** Header'da `language = sy-langu` set edilmezse SAP default 'D' kullanır. TS-side default sy-langu kullanmalı (current user language).

---

## 10. Test Plan (Yeni session için kabul kriterleri)

| Test | Beklenti |
|---|---|
| `read(Z_CLAUDE_SCREEN_TEST, 9000)` | POC v3'teki 6 element + auto-OKCODE dönmeli |
| `create(Z_CLAUDE_SCREEN_TEST, 9100, {minimal header}, [], [PBO,PAI])` | Boş screen yaratılır, geri okunabilir |
| `create` zaten var olan 9000 | ALREADY_EXISTS exception, MCP error |
| `update(Z_CLAUDE_SCREEN_TEST, 9100, {...different flow...})` | Overwrite çalışır, yeni flow geri okunabilir |
| `update` var olmayan 9999 | `NOT_FOUND` (SAP not_found exception RPY_DYNPRO_INSERT'te değil READ'te; INSERT suppress_exist=X ile her zaman yazar — bu davranışı test et) |
| `delete(Z_CLAUDE_SCREEN_TEST, 9100)` | subrc=0, geri okuyunca NOT_FOUND |
| `delete` var olmayan | `DYNPRO_NOT_FOUND` |
| Full form round-trip | TEXT/TEMPLATE/CHECK/RADIO/PUSH her biri geri gelmeli, position/text/flags preserve |

---

## 11. Bilgi Kaynakları

- **Plan:** Bu dosya (`SCREEN_PAINTER_PLAN.md`).
- **Memory:** `~/.claude/projects/c--VsCodeWorkspace/memory/project_screen_painter_plan.md` (üst seviye pointer + critical findings).
- **Existing handler patterns:** `src/handlers/RunHandlers.ts` (özellikle `handleRun`, `buildClassSource`), `src/handlers/SourceHandlers.ts`.
- **MCP server tooling info:** `C:\VsCodeWorkspace\SAP-MCP-yeni-sistem-ekleme.md`.
- **Test fixture:** Tosyali H4D, `Z_CLAUDE_SCREEN_TEST` + 9000 dynpro (canlı, dokunma).

---

## 12. Yapma Kuralları (Kullanıcı tercihi)

- Generic mesaj sınıfları yerine semantik mesajlar kullan (kullanıcının `feedback_zrpd_check_msg_class.md` memory'sine bağlı bir benzerlik — ama bu projede MESSAGE değil, exception/subrc kullanılıyor; aynı disiplinle generic değil structured error dön).
- FM parametrelerine elle dokunma (`feedback_abap_fm_params.md`) — RPY_DYNPRO_* imzasını değiştirmiyoruz, sadece çağırıyoruz, yani bu kural ihlal edilmiyor.
- Sadece istenen kapsama dokun (`feedback_scope_to_request.md`) — Z_CLAUDE_SCREEN_TEST 9000 test fixture'ına dokunma. Test için 9100+ kullan.
