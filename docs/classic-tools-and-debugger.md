# Classic program tools, ABAP Unit and the debugger

Tools added on top of the ADT source/transport tools. All verified live on S/4HANA (SAP_BASIS 816).

## ABAP Unit — `abap_unit_run`

Runs the tests of an object (`CLAS`, `PROG/P`, `FUGR/F`) or a package (`DEVC`) and returns counts plus,
for each failed method, the assertion text, details and source position.

- `test_classes: 0` means **no tests**, not a pass.
- `include_dangerous` adds risk level dangerous/critical; `only_failures` drops the passed-method list.
- `abap_set_class_include` with `include_type: testclasses` now creates the test include when the class
  has none yet (previously failed with "…CCAU does not have any inactive version").

## Text pool — `abap_textpool_read` / `abap_textpool_write`

Text symbols (`TEXT-xxx`), selection texts, program title, list headings.

| id | meaning | key |
|---|---|---|
| `I` | text symbol | 3 characters, e.g. `F01` |
| `S` | selection text | parameter / select-option name |
| `R` | program title | empty |
| `H` | list heading | line id |

- Write `mode: "merge"` (default) upserts the given entries; `delete: true` removes one; `"replace"`
  replaces the whole pool of that language.
- Selection texts: pass the plain label, or `ddic_reference: true` to take it from the data element.
- Language: 1-char SAP or 2-char ISO; default is the program's master language.

## GUI status and titlebar — `abap_gui_status_read` / `abap_gui_status_write`

What SE41 does, for `SET PF-STATUS` / `SET TITLEBAR`.

```json
{
  "program": "ZRPD_ABCD_P01",
  "statuses": [
    { "code": "0100", "description": "ALV", "keys": [
      { "key": "F3",       "fcode": "BACK", "text": "Geri" },
      { "key": "SHIFT+F3", "fcode": "EXIT", "text": "Çıkış" },
      { "key": "F12",      "fcode": "CANC", "text": "İptal", "icon": "ICON_CANCEL" },
      { "key": "F8",       "fcode": "REFRESH", "text": "Yenile", "icon": "ICON_REFRESH", "toolbar": true }
    ] }
  ],
  "titles": [ { "code": "0100", "text": "Örnek Rapor" } ]
}
```

- **Write replaces the program's whole GUI interface.** Read first and include what you want to keep.
- Menu bars are not supported; `has_menus: true` on read means a write would drop existing menus.
- The program must be active. Keys: `F1`–`F12`, `SHIFT+Fn` (+12), `CTRL+Fn` (+24), or a number 1–99.
- `toolbar: true` also places the function on the application toolbar.

## Messages — `abap_message_read` / `abap_message_write`

Reads / writes T100 messages of an existing message class (create the class with `abap_create`,
type `MSAG`). A message written in a non-master language is also created in the master language when
missing there — otherwise the syntax check and ATC report "message does not exist".

## Limits shared by the classic write tools

- They run a temporary class on the system (like `abap_run`), so they are refused on `readOnly` systems.
- Verified for local (`$TMP`) objects. For transportable objects the tools do **not** create transport
  entries: make sure the program / message class itself is on a transport.
- `abap_message_write` updates T100 directly (no SE91 lock).

## Debugger — `debug_*`

The ADT debugger is "listen, then attach". A tool call must return quickly, so the listener runs in the
background and the tools drive a small state machine:

```
idle ──debug_listen──▶ listening ──breakpoint hit (auto-attach)──▶ attached ──step/continue──▶ … ──▶ ended
```

Typical session:

1. `debug_breakpoints { action: "set", breakpoints: [{ name, type, line, condition? }] }`
   — line numbers as shown by `abap_get_source`; for a report with includes use the include (`PROG/I`).
2. `debug_listen { trigger: { kind: "unit_test", name, type } }`
   or `{ kind: "abap", code: "…" }` (an ABAP snippet, e.g. a method call or `SUBMIT … AND RETURN`),
   or no trigger and run the code yourself as the same SAP user.
3. `debug_status { wait_seconds: 40 }` until `phase: "attached"` — returns program, include, line, stack.
4. `debug_variables` (locals), `{ names: ["LV_X", "LS_ROW-FIELD", "SY-SUBRC"] }`,
   `{ expand: "LT_ROWS" }` (table rows, 50 per call, `from_row` for more) or `{ expand: "LT_ROWS[2]" }`.
5. `debug_step { action: into | over | return | continue | terminate }`, `debug_set_variable { name, value }`.
6. `debug_stop` — terminates the debuggee (or `keep_running: true`), stops the listener, removes breakpoints.

Notes and limits:

- Three SAP sessions are used: the main one, a debugger session, and a trigger session whose request
  blocks while the debuggee is stopped. The trigger result (unit test summary / snippet output) appears
  in `debug_status` once the debuggee has finished.
- Breakpoints are external user breakpoints: they catch **any** session of your SAP user while a listener
  is active — always finish with `debug_stop`. Switching system or closing the client disposes the debugger.
- A breakpoint on a non-executable line is rejected; a breakpoint on `ENDDO`/`ENDLOOP` stops after the loop.
- Only one debuggee at a time. Dialog steps of a GUI report (ALV screens) cannot be driven from here; code
  before the first screen can be debugged through `SUBMIT … AND RETURN` in an `abap` trigger.
- Not available: watchpoints, exception breakpoints, AMDP debugging.

## Fixes in this change

- `abap_get_dump` no longer fails with "Entity expansion limit exceeded" on busy systems.
- `abap_create` accepts `STRU` (mapped to `TABL/DS`).
- A rejected background promise can no longer terminate the server (`unhandledRejection` is logged).
