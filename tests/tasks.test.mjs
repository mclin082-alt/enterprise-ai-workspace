import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { TaskStore } from '../scripts/task-store.mjs';
import { TaskService } from '../scripts/task-service.mjs';
import { isolatedOptions, root } from '../scripts/runtime.mjs';

const provider = { api_key: 'SECRET_TEST_KEY', model: 'test-model', wire_api: 'responses', base_url: 'https://example.invalid/v1' };
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'enterprise-tasks-'));
  const store = new TaskStore(directory, 'local:test');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const sessions = join(directory, 'runtime');
  const calls = [];
  let mode = 'ok';
  const runtimeFactory = (p, options) => {
    const runtime = isolatedOptions(p, { ...options, stateRoot: sessions });
    const thread = id => ({ async runStreamed(prompt, { signal }) {
      calls.push({ id, prompt, sessionDir: runtime.sessionDir });
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: id ?? 'thread-a' };
        signal.throwIfAborted();
        if (mode === 'timeout') await new Promise((resolve, reject) => {
          const hold = setTimeout(resolve, 1000);
          signal.addEventListener('abort', () => { clearTimeout(hold); reject(signal.reason); }, { once: true });
        });
        if (mode === 'failed') { yield { type: 'turn.failed', error: { message: `bad ${p.api_key}` } }; return; }
        yield { type: 'item.completed', item: { type: 'agent_message', text: `answer ${p.api_key}` } };
        if (mode !== 'truncated') yield { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } };
      })() };
    } });
    return { ...runtime, codex: { startThread: () => thread(null), resumeThread: id => thread(id) } };
  };
  const service = new TaskService(store, provider, { runtimeFactory });
  const task = service.create(directory, 'task title');
  return { directory, store, service, task, calls, setMode: value => { mode = value; }, runtimeFactory };
}

test('persistent history, literal prompt, thread resume, explicit acceptance and redaction', async t => {
  const x = setup(t);
  const prompt = `原话 $(echo literal) ${provider.api_key}`;
  const first = await x.service.run(x.task.id, prompt);
  assert.equal(first.status, 'completed');
  assert.equal(x.store.get(x.task.id).status, 'awaiting_review');
  assert.equal(x.calls[0].prompt, prompt);
  assert.ok(!JSON.stringify(x.store.history(x.task.id)).includes(provider.api_key));
  assert.ok(!readFileSync(join(first.logDir, 'events.jsonl'), 'utf8').includes(provider.api_key));
  const reopened = new TaskStore(x.directory, 'local:test');
  try {
    const nextService = new TaskService(reopened, provider, { runtimeFactory: x.runtimeFactory });
    await nextService.run(x.task.id, '继续');
    assert.equal(x.calls[1].id, 'thread-a');
    assert.equal(x.calls[0].sessionDir, x.calls[1].sessionDir);
    assert.equal(reopened.history(x.task.id).length, 2);
    reopened.accept(x.task.id);
    assert.equal(reopened.get(x.task.id).status, 'succeeded');
    await nextService.run(x.task.id, '新追问');
    assert.equal(reopened.get(x.task.id).status, 'awaiting_review');
    assert.equal(reopened.get(x.task.id).accepted_at, null);
  } finally { reopened.close(); }
});

test('actor scoping, no parallel turn, live process is not recovered', t => {
  const x = setup(t);
  const turn = x.store.begin(x.task.id, 'one', 'model');
  assert.throws(() => x.store.begin(x.task.id, 'two', 'model'), /另一个入口/);
  assert.throws(() => x.store.accept(x.task.id), /待验收/);
  const other = new TaskStore(x.directory, 'local:other');
  try {
    assert.equal(other.list().length, 0);
    assert.throws(() => other.get(x.task.id), /不属于/);
    assert.throws(() => other.history(x.task.id), /不属于/);
    assert.throws(() => other.begin(x.task.id, 'attack', 'model'), /不属于/);
  } finally { other.close(); }
  x.store.recover();
  assert.equal(x.store.get(x.task.id).status, 'running');
  x.store.finish(x.task.id, turn, { status: 'cancelled' });
  assert.throws(() => x.store.finish(x.task.id, turn, { status: 'completed' }), /已结束/);
});

test('dead process becomes interrupted without replaying a task', t => {
  const x = setup(t);
  const code = `import { TaskStore } from './scripts/task-store.mjs';
    const s = new TaskStore(process.argv[1], 'local:test'); s.begin(process.argv[2], 'abandoned', 'model'); s.close();`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, x.directory, x.task.id], { cwd: root, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  x.store.recover();
  assert.equal(x.store.get(x.task.id).status, 'interrupted');
  assert.equal(x.store.history(x.task.id)[0].error_code, 'process_lost');
  assert.equal(x.calls.length, 0);
});

test('failure, truncated stream, timeout and cancellation have durable outcomes', async t => {
  const x = setup(t);
  for (const mode of ['failed', 'truncated', 'timeout']) {
    x.setMode(mode);
    const result = await x.service.run(x.task.id, mode, { timeoutMs: mode === 'timeout' ? 20 : 1000 });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, mode === 'timeout' ? 'timeout' : 'runtime_error');
    assert.ok(!result.error.includes(provider.api_key));
  }
  const controller = new AbortController();
  const pending = x.service.run(x.task.id, 'cancel', { signal: controller.signal });
  controller.abort();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(x.store.get(x.task.id).status, 'cancelled');
  assert.equal(x.store.history(x.task.id).length, 4);
});

test('missing runtime is an explicit failure; independent tasks use separate homes', async t => {
  const x = setup(t);
  const another = x.service.create(x.directory, 'second');
  assert.notEqual(x.task.session_dir, another.session_dir);
  rmSync(join(x.task.session_dir, 'codex'), { recursive: true });
  const result = await x.service.run(x.task.id, 'continue');
  assert.equal(result.status, 'failed');
  assert.equal(x.calls.length, 0);
});
