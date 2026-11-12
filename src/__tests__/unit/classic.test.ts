import { ClassicHandlers } from '../../handlers/ClassicHandlers';
import { summariseUnit } from '../../handlers/DebugHandlers';

/** Fake RunHandlers: records the generated ABAP and answers with a canned classrun output. */
function make(output: string | ((body: string) => string)) {
  const bodies: string[] = [];
  const run: any = {
    executeAbap: async (body: string) => { bodies.push(body); return typeof output === 'function' ? output(body) : output; }
  };
  const h = new ClassicHandlers({} as any, run);
  return { h, bodies };
}

/** Decode the base64 JSON payload embedded in generated ABAP. */
function payload(body: string): any {
  const m = body.match(/lv_b64 = ([\s\S]*?)\.\nDATA\(lv_json\)/);
  if (!m) throw new Error('no payload in body');
  const b64 = [...m[1].matchAll(/`([^`]*)`/g)].map(x => x[1]).join('');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
}

const json = (o: any) => `__BEGIN_JSON__\n${JSON.stringify(o)}\n__END_JSON__`;
const text = (r: any) => JSON.parse(r.content[0].text);

describe('abap_textpool_write', () => {
  it('validates keys and lengths before touching the system', async () => {
    const { h, bodies } = make('');
    await expect(h.handle('abap_textpool_write', { program: 'ZP', entries: [{ id: 'I', key: 'TOOLONG', entry: 'x' }] }))
      .rejects.toThrow(/exactly 3 characters/);
    await expect(h.handle('abap_textpool_write', { program: 'ZP', entries: [{ id: 'S', key: 'P_X', entry: 'x'.repeat(31) }] }))
      .rejects.toThrow(/max 30/);
    await expect(h.handle('abap_textpool_write', { program: 'ZP', entries: [{ id: 'X', key: 'A' }] }))
      .rejects.toThrow(/one of I, S, R, H, T/);
    await expect(h.handle('abap_textpool_write', { program: 'Z"P', entries: [{ id: 'R', entry: 't' }] }))
      .rejects.toThrow(/invalid name/);
    expect(bodies).toHaveLength(0);
  });

  it('sends selection texts with ddic flag / plain label and keeps unicode intact', async () => {
    const { h, bodies } = make(json({ language: 'T', before: 0, entries: [
      { id: 'S', key: 'S_BUKRS', entry: 'D       .', length: 9 },
      { id: 'S', key: 'P_DATE', entry: '        Geçerlilik', length: 18 },
    ] }));
    const r = text(await h.handle('abap_textpool_write', { program: 'zp', language: 'tr', entries: [
      { id: 's', key: 's_bukrs', ddic_reference: true },
      { id: 'S', key: 'P_DATE', entry: 'Geçerlilik' },
      { id: 'I', key: 'f01', entry: 'Ülke', length: 20 },
    ] }));
    const p = payload(bodies[0]);
    expect(p.entries[0]).toMatchObject({ id: 'S', key: 'S_BUKRS', ddic: 'X', length: 9 });
    expect(p.entries[1]).toMatchObject({ text: 'Geçerlilik', ddic: '', length: 18 });
    expect(p.entries[2]).toMatchObject({ id: 'I', key: 'F01', text: 'Ülke', length: 20 });
    expect(bodies[0]).toContain('VALUE \'TR\'');
    expect(bodies[0]).toContain('READ TEXTPOOL \'ZP\'');          // merge reads first
    expect(r.entries[0]).toMatchObject({ ddic_reference: true, entry: '' });
    expect(r.entries[1]).toMatchObject({ ddic_reference: false, entry: 'Geçerlilik' });
  });

  it('surfaces ERROR lines from the system', async () => {
    const { h } = make('ERROR:program ZNOPE does not exist\n');
    await expect(h.handle('abap_textpool_read', { program: 'ZNOPE' })).rejects.toThrow(/does not exist/);
  });
});

describe('abap_gui_status_write', () => {
  const ok = (body: string) => {
    const p = payload(body);
    return json({ ...p, men: [], act: [] });
  };

  it('maps function keys and builds consistent CUA tables', async () => {
    const { h, bodies } = make(ok);
    const r = text(await h.handle('abap_gui_status_write', {
      program: 'zp',
      statuses: [
        { code: '0100', description: 'ALV', keys: [
          { key: 'F3', fcode: 'back', text: 'Geri' },
          { key: 'shift+f3', fcode: 'EXIT', text: 'Çıkış' },
          { key: 12, fcode: 'CANC', text: 'İptal', icon: 'icon_cancel' },
          { key: 'CTRL+F1', fcode: 'REFRESH', text: 'Yenile', toolbar: true },
        ] },
        { code: '0200', keys: [{ key: 'F3', fcode: 'BACK', text: 'Geri' }] },
      ],
      titles: [{ code: '0100', text: 'Başlık' }],
    }));
    const p = payload(bodies[0]);
    expect(p.adm).toEqual({ actcode: '000002', pfkcode: '000002' });
    expect(p.sta.map((s: any) => [s.code, s.pfkcode])).toEqual([['0100', '000001'], ['0200', '000002']]);
    expect(p.pfk.filter((k: any) => k.code === '000001').map((k: any) => `${k.pfno}=${k.funcode}`))
      .toEqual(['03=BACK', '15=EXIT', '12=CANC', '25=REFRESH']);
    expect(p.fun.map((f: any) => f.code)).toEqual(['BACK', 'EXIT', 'CANC', 'REFRESH']);   // BACK only once
    expect(p.fun[2].text_name).toBe('ICON_CANCEL');
    expect(p.but).toEqual([{ pfk_code: '000001', code: '0001', no: '01', pfno: '25' }]);
    expect(p.set).toHaveLength(5);
    expect(p.doc).toHaveLength(6);
    expect(r.statuses[0].keys.map((k: any) => k.key)).toEqual(['F3', 'SHIFT+F3', 'F12', 'CTRL+F1']);
    expect(r.statuses[0].keys[3].toolbar).toBe(true);
    expect(r.has_menus).toBe(false);
  });

  it('rejects bad keys, duplicates and empty statuses', async () => {
    const { h, bodies } = make(ok);
    const st = (keys: any[]) => ({ program: 'ZP', statuses: [{ code: 'S1', keys }] });
    await expect(h.handle('abap_gui_status_write', st([{ key: 'F13', fcode: 'A', text: 't' }]))).rejects.toThrow(/F1\.\.F12/);
    await expect(h.handle('abap_gui_status_write', st([{ key: 'ALT+X', fcode: 'A', text: 't' }]))).rejects.toThrow(/cannot parse key/);
    await expect(h.handle('abap_gui_status_write', st([{ key: 'F3', fcode: 'A', text: 't' }, { key: 3, fcode: 'B', text: 't' }])))
      .rejects.toThrow(/assigned twice/);
    await expect(h.handle('abap_gui_status_write', st([{ key: 'F3', fcode: 'A' }]))).rejects.toThrow(/text is required/);
    await expect(h.handle('abap_gui_status_write', st([]))).rejects.toThrow(/at least one function/);
    await expect(h.handle('abap_gui_status_write', { program: 'ZP', statuses: [
      { code: 'S1', keys: [{ key: 'F3', fcode: 'A', text: 't' }] }, { code: 's1', keys: [{ key: 'F3', fcode: 'A', text: 't' }] }] }))
      .rejects.toThrow(/duplicate status/);
    expect(bodies).toHaveLength(0);
  });

  it('fails when the system does not contain the status afterwards', async () => {
    const { h } = make(json({ sta: [], fun: [], pfk: [], but: [], set: [], tit: [], men: [], act: [] }));
    await expect(h.handle('abap_gui_status_write', { program: 'ZP', statuses: [{ code: 'S1', keys: [{ key: 'F3', fcode: 'A', text: 't' }] }] }))
      .rejects.toThrow(/not on the system afterwards/);
  });

  it('read flags menu definitions it cannot round-trip', async () => {
    const { h } = make(json({ sta: [{ code: 'S', pfkcode: '000001', butcode: '0001' }], fun: [], pfk: [], but: [], set: [], tit: [],
      men: [{ code: '000001' }], act: [] }));
    const r = text(await h.handle('abap_gui_status_read', { program: 'ZP' }));
    expect(r.has_menus).toBe(true);
    expect(r.warning).toMatch(/drop them/);
  });
});

describe('abap_message_write', () => {
  it('pads numbers, enforces the 73-char limit and rejects duplicates', async () => {
    const { h, bodies } = make(json({ language: 'T', master: 'E', master_added: 1, written: 1 }));
    await expect(h.handle('abap_message_write', { message_class: 'ZM', messages: [{ number: '1', text: 'x'.repeat(74) }] }))
      .rejects.toThrow(/max 73/);
    await expect(h.handle('abap_message_write', { message_class: 'ZM', messages: [{ number: '1', text: 'a' }, { number: '001', text: 'b' }] }))
      .rejects.toThrow(/appears twice/);
    await expect(h.handle('abap_message_write', { message_class: 'ZM', messages: [{ number: '1000', text: 'a' }] }))
      .rejects.toThrow(/0-999/);
    expect(bodies).toHaveLength(0);
    const r = text(await h.handle('abap_message_write', { message_class: 'zm', messages: [{ number: 7, text: '&1 için kayıt yok' }] }));
    expect(payload(bodies[0]).messages).toEqual([{ msgnr: '007', text: '&1 için kayıt yok' }]);
    expect(r.note).toMatch(/master language E/);
  });
});

describe('summariseUnit', () => {
  it('counts failures, ignores warnings, and treats no tests as zero — not as a pass', () => {
    expect(summariseUnit([])).toMatchObject({ test_classes: 0, test_methods: 0, failed: 0, passed: 0 });
    const s = summariseUnit([{
      'adtcore:name': 'LTCL', riskLevel: 'harmless', durationCategory: 'short', alerts: [],
      testmethods: [
        { 'adtcore:name': 'OK', executionTime: 1, alerts: [] },
        { 'adtcore:name': 'WARN', executionTime: 1, alerts: [{ kind: 'warning', severity: 'tolerable', title: 'w', details: [], stack: [] }] },
        { 'adtcore:name': 'BAD', executionTime: 1, alerts: [{ kind: 'failedAssertion', severity: 'critical', title: 'boom', details: ['exp 1 act 2'], stack: [{ 'adtcore:description': 'Include X line 3' }] }] },
      ]
    }]);
    expect(s).toMatchObject({ test_classes: 1, test_methods: 3, failed: 1, passed: 2 });
    expect(s.failures[0]).toMatchObject({ class: 'LTCL', method: 'BAD' });
    expect(s.failures[0].alerts[0].at).toEqual(['Include X line 3']);
  });

  it('reports class-level aborts as failures', () => {
    const s = summariseUnit([{ 'adtcore:name': 'LTCL', testmethods: [], alerts: [{ kind: 'runtimeAbortion', severity: 'fatal', title: 'abort', details: [] }] }]);
    expect(s.failures).toHaveLength(1);
    expect(s.failed).toBe(0);
  });
});
