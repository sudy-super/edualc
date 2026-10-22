import type { Query } from '@anthropic-ai/claude-agent-sdk';

interface Context {
  options: { mcpClients?: { name: string; type: string }[] };
  getMcp?(): { clients: { name: string; type: string }[] };
}

export function createSdkMcp(connection: Pick<Query, 'mcpServerStatus' | 'toggleMcpServer' | 'reconnectMcpServer'>, context: () => Context) {
  let previous = '';
  let known = new Set<string>();
  let pending = Promise.resolve();
  let closed = false;

  async function sync(force = false): Promise<void> {
    if (closed) return;
    const current = context();
    const clients = current.getMcp ? current.getMcp().clients : current.options.mcpClients ?? [];
    const desired = new Map(clients.map(client => [client.name, client.type !== 'disabled']));
    const fingerprint = JSON.stringify([...desired].sort(([a], [b]) => a.localeCompare(b)));
    if (!force && fingerprint === previous) return;
    if (!desired.size) { previous = fingerprint; return; }
    const actual = await connection.mcpServerStatus();
    if (closed) return;
    known = new Set(actual.map(server => server.name));
    for (const server of actual) {
      const enabled = desired.get(server.name);
      // 親のOAuthでのみ利用できるサーバーを、SDKにも存在すると仮定しない。
      if (enabled !== undefined && enabled !== (server.status !== 'disabled')) await connection.toggleMcpServer(server.name, enabled);
    }
    previous = fingerprint;
  }

  function serialize(operation: () => Promise<void>): Promise<void> {
    const next = pending.then(operation);
    pending = next.catch(() => {});
    return next;
  }

  return {
    sync: () => serialize(() => sync()),
    reconnect(name: string) { return serialize(async () => {
      await sync(true);
      if (!closed && known.has(name)) await connection.reconnectMcpServer(name);
    }); },
    close() { closed = true; },
  };
}
