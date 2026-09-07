import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRuntime, readProvider, root, threadOptions } from './runtime.mjs';

const provider = readProvider();
const appDirectory = join(root, '.runtime', 'app');
const stateRoot = join(root, '.runtime', 'mcp-spike');
mkdirSync(appDirectory, { recursive: true, mode: 0o700 });
const taskId = `mcp-spike-${randomUUID()}`;
const runtime = createRuntime(provider, { stateRoot, connectorContext: { actor: `local:${process.getuid?.() ?? 'owner'}`, taskId, appDirectory } });
const thread = runtime.codex.startThread(threadOptions(provider, root, true));
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 90000);
const events = [];
try {
  const streamed = await thread.runStreamed('Call the enterprise_connectors connection_status MCP tool exactly once. Do not use shell or files. Then briefly report its result.', { signal: controller.signal });
  for await (const event of streamed.events) events.push(event);
} finally { clearTimeout(timer); }
const calls = events.filter(event => event.type === 'item.completed' && event.item.type === 'mcp_tool_call');
const report = {
  taskId, provider: provider.name, model: provider.model, finishedAt: new Date().toISOString(),
  calls: calls.map(event => ({ server: event.item.server, tool: event.item.tool, status: event.item.status, error: event.item.error?.message })),
  completed: events.some(event => event.type === 'turn.completed'),
};
const path = join(runtime.sessionDir, 'mcp-spike-summary.json');
writeFileSync(path, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...report, evidence: path }, null, 2));
if (!report.completed || calls.length !== 1 || calls[0].item.tool !== 'connection_status' || calls[0].item.status !== 'completed') process.exitCode = 1;
