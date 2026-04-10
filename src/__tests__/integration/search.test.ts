import { ADTClient } from 'abap-adt-api';
import { hasLiveConfig, createClient, createHandlers, parseResult, TestHandlers } from '../helpers/setup';

const describeLive = hasLiveConfig() ? describe : describe.skip;

describeLive('abap_search (live)', () => {
  let client: ADTClient;
  let handlers: TestHandlers;

  beforeAll(async () => {
    client = createClient();
    handlers = createHandlers(client);
    await client.login();
  }, 15000);

  afterAll(async () => {
    try { await client.logout(); } catch (_) {}
  });

  it('finds classes by wildcard', async () => {
    const result = parseResult(await handlers.object.validateAndHandle('abap_search', {
      query: 'CL_ABAP_*', type: 'CLAS/OC', max: 5
    }));
    expect(result.count).toBeGreaterThan(0);
  }, 15000);

  it('returns empty + hint when no results and no wildcard', async () => {
    const result = parseResult(await handlers.object.validateAndHandle('abap_search', {
      query: 'ZXYZZY_NONEXISTENT_99999'
    }));
    expect(result.count).toBe(0);
    expect(result.hint).toContain('wildcard');
  }, 15000);

  it('respects max parameter', async () => {
    const result = parseResult(await handlers.object.validateAndHandle('abap_search', {
      query: 'CL_*', max: 3
    }));
    expect(result.count).toBeLessThanOrEqual(3);
  }, 15000);
});
