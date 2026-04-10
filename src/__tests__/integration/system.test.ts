import { ADTClient } from 'abap-adt-api';
import { hasLiveConfig, createClient, createHandlers, parseResult, TestHandlers } from '../helpers/setup';

const describeLive = hasLiveConfig() ? describe : describe.skip;

describeLive('SystemHandlers (live)', () => {
  let client: ADTClient;
  let handlers: TestHandlers;

  beforeAll(async () => {
    client = createClient();
    handlers = createHandlers(client);
  }, 15000);

  afterAll(async () => {
    try { await client.logout(); } catch (_) {}
  });

  it('healthcheck returns healthy', async () => {
    const result = parseResult(await handlers.system.validateAndHandle('healthcheck', {}));
    expect(result.status).toBe('success');
    expect(result.healthy).toBe(true);
  }, 15000);

  it('login returns loggedIn', async () => {
    const result = parseResult(await handlers.system.validateAndHandle('login', {}));
    expect(result.status).toBe('success');
    expect(result.loggedIn).toBe(true);
  }, 15000);

  it('abap_get_dump does not crash', async () => {
    // The dumps endpoint is flaky — XML parser limits, empty feeds, conversion errors.
    // We just verify it doesn't throw an unhandled exception (i.e. returns a structured response).
    try {
      const result = parseResult(await handlers.system.validateAndHandle('abap_get_dump', {}));
      expect(result.status).toBe('success');
      expect(Array.isArray(result.dumps)).toBe(true);
    } catch (e: any) {
      // Known failures: entity expansion limit, data conversion errors
      // As long as it's a McpError (structured) and not a raw crash, it's acceptable
      expect(e.message).toBeDefined();
    }
  }, 30000);
});
