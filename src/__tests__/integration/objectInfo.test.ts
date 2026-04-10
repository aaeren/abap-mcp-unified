import { ADTClient } from 'abap-adt-api';
import { hasLiveConfig, createClient, createHandlers, parseResult, TestHandlers } from '../helpers/setup';

const describeLive = hasLiveConfig() ? describe : describe.skip;

describeLive('abap_object_info (live)', () => {
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

  it('returns structure for a class', async () => {
    const result = parseResult(await handlers.object.validateAndHandle('abap_object_info', {
      name: 'CL_ABAP_TYPEDESCR', type: 'CLAS'
    }));
    expect(result.status).toBe('success');
    expect(result.structure).toBeDefined();
    expect(typeof result.upgradeFlag).toBe('boolean');
  }, 15000);
});
