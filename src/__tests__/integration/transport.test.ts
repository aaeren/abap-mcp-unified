import { ADTClient } from 'abap-adt-api';
import { hasLiveConfig, createClient, createHandlers, parseResult, TestHandlers } from '../helpers/setup';

const describeLive = hasLiveConfig() ? describe : describe.skip;

describeLive('transport tools (live)', () => {
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

  it('transport_list returns transports', async () => {
    const result = parseResult(await handlers.transport.validateAndHandle('transport_list', {}));
    expect(result.status).toBe('success');
    expect(result.transports).toBeDefined();
  }, 15000);
});
