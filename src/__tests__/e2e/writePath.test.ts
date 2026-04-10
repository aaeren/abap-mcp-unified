/**
 * End-to-end write-path smoke test.
 * Creates a PROG in $TMP, writes source, syntax checks, activates, and deletes.
 * Proves the full lifecycle works. Cleanup runs even on failure.
 *
 * Requires: SAP_URL, SAP_USER, SAP_PASSWORD env vars.
 * Skips automatically when not set.
 */
import { ADTClient } from 'abap-adt-api';
import { hasLiveConfig, createClient, createHandlers, parseResult, TestHandlers } from '../helpers/setup';

const describeE2E = hasLiveConfig() ? describe : describe.skip;

describeE2E('write path: PROG lifecycle', () => {
  let client: ADTClient;
  let handlers: TestHandlers;
  // Unique name to avoid collisions
  const progName = `ZMCPTEST${Date.now().toString(36).toUpperCase().slice(-6)}`;

  beforeAll(async () => {
    client = createClient();
    handlers = createHandlers(client);
    await client.login();
  }, 30000);

  afterAll(async () => {
    // Best-effort cleanup — delete the test program even if a test failed
    try {
      await handlers.object.validateAndHandle('abap_delete', { name: progName, type: 'PROG/P' });
    } catch (_) {}
    try { await client.logout(); } catch (_) {}
  }, 30000);

  it('step 1: create program in $TMP', async () => {
    const result = parseResult(await handlers.object.validateAndHandle('abap_create', {
      name: progName,
      type: 'PROG/P',
      package: '$TMP',
      description: 'MCP regression test - safe to delete'
    }));
    expect(result.status).toBe('success');
    expect(result.name).toBe(progName);
  }, 30000);

  it('step 2: write source', async () => {
    const source = `REPORT ${progName.toLowerCase()}.\nWRITE: / 'MCP regression test passed'.`;
    const result = parseResult(await handlers.source.validateAndHandle('abap_set_source', {
      name: progName,
      type: 'PROG/P',
      source
    }));
    expect(result.status).toBe('success');
  }, 30000);

  it('step 3: syntax check passes', async () => {
    const result = parseResult(await handlers.quality.validateAndHandle('abap_syntax_check', {
      name: progName,
      type: 'PROG/P'
    }));
    expect(result.status).toBe('success');
  }, 30000);

  it('step 4: activate', async () => {
    const result = parseResult(await handlers.object.validateAndHandle('abap_activate', {
      name: progName,
      type: 'PROG/P'
    }));
    expect(result.status).toBe('success');
    expect(result.activated).toBe(true);
  }, 30000);

  it('step 5: delete', async () => {
    const result = parseResult(await handlers.object.validateAndHandle('abap_delete', {
      name: progName,
      type: 'PROG/P'
    }));
    expect(result.status).toBe('success');
  }, 30000);

  it('step 6: confirm deletion (search returns 0)', async () => {
    const result = parseResult(await handlers.object.validateAndHandle('abap_search', {
      query: progName
    }));
    expect(result.count).toBe(0);
  }, 15000);
});
