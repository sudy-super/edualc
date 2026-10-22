import { expect, test } from 'bun:test';
import { createSdkMcp } from '../src/sdk-mcp';

test('mirrors native MCP disable/enable through SDK controls, including an existing SDK connection', async () => {
  const client = { name: 'fixture', type: 'connected' };
  const actual = { name: 'fixture', status: 'connected' };
  const changes: any[] = [];
  let inspections = 0;
  const controls = createSdkMcp({ mcpServerStatus: async () => { inspections++; return [actual] as any; },
    toggleMcpServer: async (name, enabled) => { changes.push([name, enabled]); actual.status = enabled ? 'connected' : 'disabled'; },
    reconnectMcpServer: async name => { changes.push(['reconnect', name]); },
  }, () => ({ options: {}, getMcp: () => ({ clients: [client, { name: 'oauth-only', type: 'disabled' }] }) }));
  await controls.sync();
  await controls.sync();
  expect(inspections).toBe(1);
  client.type = 'disabled';
  await controls.sync();
  client.type = 'connected';
  await controls.sync();
  await controls.reconnect('fixture');
  await controls.reconnect('oauth-only');
  expect(changes).toEqual([['fixture', false], ['fixture', true], ['reconnect', 'fixture']]);
  controls.close();
});

test('surfaces SDK MCP failures and does not complete a late control after closure', async () => {
  const controls = createSdkMcp({ mcpServerStatus: async () => { throw new Error('MCP control unavailable'); },
    toggleMcpServer: async () => {}, reconnectMcpServer: async () => {},
  }, () => ({ options: { mcpClients: [{ name: 'fixture', type: 'disabled' }] } }));
  await expect(controls.sync()).rejects.toThrow('MCP control unavailable');
  controls.close();
  await controls.sync();
});
