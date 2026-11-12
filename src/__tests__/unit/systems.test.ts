import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadRegistry, initialSystem, findSystem, describeSystem, ENV_SYSTEM_NAME } from '../../lib/systems';

const ENV_KEYS = ['SAP_SYSTEMS_FILE', 'SAP_SYSTEM', 'SAP_URL', 'SAP_USER', 'SAP_PASSWORD', 'SAP_CLIENT',
  'SAP_LANGUAGE', 'SAP_READ_ONLY', 'NODE_TLS_REJECT_UNAUTHORIZED', 'TEST_PW'];

describe('systems registry', () => {
  let dir: string;
  let file: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sapmcp-'));
    file = path.join(dir, 'systems.json');
    process.env.SAP_SYSTEMS_FILE = file;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (json: any) => fs.writeFileSync(file, typeof json === 'string' ? json : JSON.stringify(json));

  const sample = {
    defaultSystem: 'Dev',
    systems: {
      Dev: { url: 'https://dev', user: 'U', password: 'p', client: 100, insecureTls: true },
      'dev-prd': { url: 'https://prd', user: 'U', password: 'env:TEST_PW', readOnly: true },
      broken: { user: 'no-url' },
    },
  };

  it('starts empty when there is no file and no env', () => {
    const reg = loadRegistry();
    expect(reg.fileExists).toBe(false);
    expect(reg.systems.size).toBe(0);
    expect(initialSystem(reg)).toBeUndefined();
  });

  it('loads systems, lower-cases names, skips incomplete entries', () => {
    write(sample);
    const reg = loadRegistry();
    expect([...reg.systems.keys()]).toEqual(['dev', 'dev-prd']);
    expect(reg.systems.get('dev')).toMatchObject({ client: '100', insecureTls: true, readOnly: false, source: 'file' });
    expect(initialSystem(reg)?.name).toBe('dev');
  });

  it('resolves env: passwords', () => {
    write(sample);
    expect(loadRegistry().systems.get('dev-prd')!.password).toBe('');
    process.env.TEST_PW = 'secret';
    expect(loadRegistry().systems.get('dev-prd')!.password).toBe('secret');
  });

  it('reports a broken file instead of throwing', () => {
    write('{ not json');
    const reg = loadRegistry();
    expect(reg.fileError).toContain('systems.json');
    expect(reg.systems.size).toBe(0);
  });

  it('keeps legacy SAP_* env working and prefers it over the file default', () => {
    write(sample);
    process.env.SAP_URL = 'https://legacy'; process.env.SAP_USER = 'L'; process.env.SAP_PASSWORD = 'x';
    const reg = loadRegistry();
    expect(reg.systems.get(ENV_SYSTEM_NAME)?.source).toBe('env');
    expect(initialSystem(reg)?.name).toBe(ENV_SYSTEM_NAME);
    process.env.SAP_SYSTEM = 'DEV-PRD';
    expect(initialSystem(loadRegistry())?.name).toBe('dev-prd');
  });

  it('finds systems by exact name, sap- prefix, and unique partial; refuses ambiguous', () => {
    write(sample);
    const reg = loadRegistry();
    expect(findSystem(reg, 'DEV').match?.name).toBe('dev');           // exact wins over partial
    expect(findSystem(reg, 'sap-dev-prd').match?.name).toBe('dev-prd');
    expect(findSystem(reg, 'prd').match?.name).toBe('dev-prd');
    const amb = findSystem(reg, 'de');
    expect(amb.match).toBeUndefined();
    expect(amb.candidates.sort()).toEqual(['dev', 'dev-prd']);
    expect(findSystem(reg, 'nope').candidates).toEqual([]);
  });

  it('never exposes the password in listings', () => {
    write(sample);
    const d = describeSystem(loadRegistry().systems.get('dev')!, 'dev');
    expect(JSON.stringify(d)).not.toContain('"p"');
    expect(d).toMatchObject({ active: true, hasPassword: true });
    expect((d as any).password).toBeUndefined();
  });
});
