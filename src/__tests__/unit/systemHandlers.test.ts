import { SystemHandlers } from '../../handlers/SystemHandlers';

/**
 * Unit tests for SystemHandlers — specifically the new abap_get_transaction tool.
 * No real ADT client needed: tool definitions are static, and handler logic is
 * tested by verifying validation and route dispatch.
 */

describe('SystemHandlers: abap_get_transaction tool definition', () => {
  const handler = new SystemHandlers(null as any);
  const tools = handler.getTools();
  const txTool = tools.find(t => t.name === 'abap_get_transaction');

  it('abap_get_transaction is registered', () => {
    expect(txTool).toBeDefined();
  });

  it('has readOnlyHint annotation', () => {
    expect(txTool?.annotations?.readOnlyHint).toBe(true);
  });

  it('has a non-empty description', () => {
    expect(typeof txTool?.description).toBe('string');
    expect(txTool!.description.length).toBeGreaterThan(0);
  });

  it('has inputSchema.type = "object"', () => {
    expect(txTool?.inputSchema.type).toBe('object');
  });

  it('requires "name" parameter', () => {
    expect(txTool?.inputSchema.required).toContain('name');
  });

  it('"name" property is type string', () => {
    expect(txTool?.inputSchema.properties?.name?.type).toBe('string');
  });
});

describe('SystemHandlers: abap_get_transaction validation', () => {
  const handler = new SystemHandlers(null as any);

  it('rejects empty args with "missing required parameter"', async () => {
    await expect(handler.validateAndHandle('abap_get_transaction', {}))
      .rejects.toThrow(/missing required parameter/);
  });

  it('error message mentions the "name" field', async () => {
    try {
      await handler.validateAndHandle('abap_get_transaction', {});
      fail('Should have thrown');
    } catch (e: any) {
      expect(e.message).toContain('name');
    }
  });
});

describe('SystemHandlers: tool count includes abap_get_transaction', () => {
  const handler = new SystemHandlers(null as any);
  const names = handler.getTools().map(t => t.name);

  it('includes all expected system tools', () => {
    expect(names).toContain('login');
    expect(names).toContain('healthcheck');
    expect(names).toContain('abap_get_dump');
    expect(names).toContain('abap_get_transaction');
    expect(names).toContain('raw_http');
  });

  it('has exactly 5 system tools', () => {
    expect(names.length).toBe(5);
  });
});
