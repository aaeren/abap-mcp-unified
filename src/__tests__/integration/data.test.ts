import { ADTClient } from 'abap-adt-api';
import { hasLiveConfig, createClient, createHandlers, parseResult, TestHandlers } from '../helpers/setup';

const describeLive = hasLiveConfig() ? describe : describe.skip;

describeLive('data tools (live)', () => {
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

  it('abap_table reads T000', async () => {
    const result = parseResult(await handlers.data.validateAndHandle('abap_table', {
      name: 'T000', limit: 5
    }));
    expect(result.status).toBe('success');
    expect(result.result).toBeDefined();
  }, 15000);

  it('abap_query executes simple SQL', async () => {
    const result = parseResult(await handlers.data.validateAndHandle('abap_query', {
      sql: 'SELECT * FROM T000', limit: 5
    }));
    expect(result.status).toBe('success');
    expect(result.result).toBeDefined();
  }, 15000);
});
