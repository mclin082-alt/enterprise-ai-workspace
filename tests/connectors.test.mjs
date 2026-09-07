import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ConnectionStore } from '../scripts/connection-store.mjs';
import { ConnectorClient, parseLarkDocumentUrl } from '../scripts/connectors.mjs';
import { connectorMcpConfig, root } from '../scripts/runtime.mjs';

function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), 'enterprise-connectors-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('connection identity comes from binding result and tokens stay out of metadata', t => {
  const directory = temporary(t);
  const store = new ConnectionStore(directory, 'local:test');
  t.after(() => store.close());
  const saved = store.bind('outlook', {
    accountId: 'remote-id-1', displayName: 'Test User', accountHint: 'test@example.com', scopes: ['Mail.Read', 'User.Read'],
  }, { access_token: 'ACCESS_SECRET', refresh_token: 'REFRESH_SECRET' });
  assert.equal(saved.account_id, 'remote-id-1');
  assert.deepEqual(saved.scopes, ['Mail.Read', 'User.Read']);
  assert.equal(store.tokens('outlook').access_token, 'ACCESS_SECRET');
  const database = readFileSync(join(directory, 'connections.sqlite'));
  assert.ok(!database.includes(Buffer.from('ACCESS_SECRET')));
  const tokenPath = store.vault.path('local:test', 'outlook');
  assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
  assert.equal(store.disconnect('outlook'), true);
  assert.equal(store.get('outlook'), null);
});

test('lark URL parser is strict and read resolves Wiki to Docx with source', async t => {
  assert.deepEqual(parseLarkDocumentUrl('https://example.feishu.cn/docx/Doc_123?x=1'), {
    kind: 'docx', token: 'Doc_123', sourceUrl: 'https://example.feishu.cn/docx/Doc_123',
  });
  assert.throws(() => parseLarkDocumentUrl('http://example.feishu.cn/docx/Doc_123'), /只接受/);
  assert.throws(() => parseLarkDocumentUrl('https://evil.example/docx/Doc_123'), /只接受/);
  const directory = temporary(t);
  const store = new ConnectionStore(directory, 'local:test');
  t.after(() => store.close());
  store.bind('lark', { accountId: 'ou_1', displayName: 'Lark User', scopes: ['docx:document:readonly'] },
    { access_token: 'token', expires_at: '2999-01-01T00:00:00.000Z' });
  const urls = [];
  const client = new ConnectorClient(store, { fetcher: async url => {
    urls.push(String(url));
    if (String(url).includes('get_node')) return response({ code: 0, data: { node: { obj_type: 'docx', obj_token: 'doc-real' } } });
    if (String(url).endsWith('/raw_content')) return response({ code: 0, data: { content: '真实正文' } });
    return response({ code: 0, data: { document: { title: '项目周报', revision_id: 7 } } });
  } });
  const result = await client.larkReadDocument({ url: 'https://acme.feishu.cn/wiki/wiki-token' });
  assert.equal(result.sourceId, 'doc-real');
  assert.equal(result.content, '真实正文');
  assert.equal(result.revisionId, 7);
  assert.equal(urls.length, 3);
});

test('Outlook tools are delegated /me read-only requests with bounded output', async t => {
  const directory = temporary(t);
  const store = new ConnectionStore(directory, 'local:test');
  t.after(() => store.close());
  store.bind('outlook', { accountId: 'graph-id', displayName: 'Graph User', scopes: ['Mail.Read'] },
    { access_token: 'token', expires_at: '2999-01-01T00:00:00.000Z' });
  const requests = [];
  const client = new ConnectorClient(store, { fetcher: async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/messages/msg-1')) return response({ id: 'msg-1', subject: 'S', body: { contentType: 'text', content: 'Body' } });
    return response({ value: [{ id: 'msg-1', subject: 'S', from: { emailAddress: { address: 'a@example.com' } }, bodyPreview: 'P' }] });
  } });
  const found = await client.outlookSearchMessages({ query: '项目', limit: 5 });
  assert.equal(found.messages[0].id, 'msg-1');
  const message = await client.outlookGetMessage({ messageId: 'msg-1' });
  assert.equal(message.content, 'Body');
  assert.ok(requests.every(x => x.url.startsWith('https://graph.microsoft.com/v1.0/me/')));
  assert.ok(requests.every(x => !['POST', 'PATCH', 'DELETE'].includes(x.options?.method)));
  await assert.rejects(() => client.outlookSearchMessages({ query: 'x', limit: 26 }), /1–25/);
});

test('runtime MCP config injects fixed app identity without connector credentials', () => {
  const config = connectorMcpConfig({ actor: 'local:test', taskId: 'task-1', appDirectory: '/tmp/app' });
  assert.deepEqual(config.enterprise_connectors.enabled_tools,
    ['connection_status', 'lark_read_document', 'outlook_search_messages', 'outlook_get_message']);
  assert.equal(config.enterprise_connectors.required, true);
  assert.equal(config.enterprise_connectors.env.ENTERPRISE_CONNECTOR_ACTOR, 'local:test');
  assert.ok(!JSON.stringify(config).toLowerCase().includes('access_token'));
  assert.ok(!JSON.stringify(config).toLowerCase().includes('client_secret'));
});

test('expired Lark token refresh uses current OAuth v3 endpoint only once', async t => {
  const directory = temporary(t);
  const store = new ConnectionStore(directory, 'local:test');
  t.after(() => store.close());
  store.bind('lark', { accountId: 'ou_1', displayName: 'Lark User', scopes: ['offline_access'] }, {
    access_token: 'expired', refresh_token: 'refresh-one-use', expires_at: '2000-01-01T00:00:00.000Z',
    client_id: 'cli_1', client_secret: 'secret',
  });
  const requests = [];
  const client = new ConnectorClient(store, { fetcher: async (url, options) => {
    requests.push(String(url));
    assert.equal(options.method, 'POST');
    return response({ code: 0, access_token: 'fresh', refresh_token: 'refresh-next', expires_in: 7200 });
  } });
  assert.deepEqual(await Promise.all([client.accessToken('lark'), client.accessToken('lark')]), ['fresh', 'fresh']);
  assert.deepEqual(requests, ['https://accounts.feishu.cn/oauth/v3/token']);
  assert.equal(store.tokens('lark').refresh_token, 'refresh-next');
});

test('stdio MCP lists only read tools and reports disconnected access clearly', async t => {
  const directory = temporary(t);
  const child = spawn(process.execPath, ['scripts/connector-mcp.mjs'], {
    cwd: root, env: { ENTERPRISE_CONNECTOR_APP_DIR: directory, ENTERPRISE_CONNECTOR_ACTOR: 'local:test', ENTERPRISE_CONNECTOR_TASK_ID: 'task-1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  const lines = createInterface({ input: child.stdout });
  const waiting = [];
  lines.on('line', line => waiting.shift()?.(JSON.parse(line)));
  const send = (id, method, params = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP response timeout')), 3000);
    waiting.push(value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const initialized = await send(1, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal(initialized.result.serverInfo.name, 'enterprise-connectors');
  const listed = await send(2, 'tools/list');
  assert.deepEqual(listed.result.tools.map(x => x.name),
    ['connection_status', 'lark_read_document', 'outlook_search_messages', 'outlook_get_message']);
  const failed = await send(3, 'tools/call', { name: 'lark_read_document', arguments: { url: 'https://a.feishu.cn/docx/x' } });
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /未连接/);
});
