// Opt-in live check: two real CLI processes and model calls, no business connectors.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './runtime.mjs';
import { TaskStore } from './task-store.mjs';

mkdirSync(join(root, 'runs'), { recursive: true, mode: 0o700 });
const evidence = mkdtempSync(join(root, 'runs', 'build-003-'));
const workspace = join(evidence, 'workspace');
mkdirSync(workspace, { mode: 0o700 });
function cli(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/chat.mjs', workspace], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const timeout = setTimeout(() => child.kill('SIGINT'), 200000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

const marker = `RESUME_${randomUUID()}`;
console.log(`真实恢复检查开始，记录：${evidence}`);
const first = await cli(`记住测试标记 ${marker}。只回复“已记住”，不调用工具，不读写文件。\n/exit\n`);
writeFileSync(join(evidence, 'first.json'), JSON.stringify(first, null, 2), { mode: 0o600 });
assert.equal(first.code, 0, first.stderr);
const id = first.stdout.match(/任务：([a-f0-9-]{36})/)?.[1];
assert.ok(id, 'CLI did not print a task ID');
console.log(`第一个 CLI 已退出，开始恢复 ${id}`);
const second = await cli(`/resume ${id}\n上一轮要求记住的完整测试标记是什么？只回复标记，不调用工具，不读写文件。\n/status\n/done\n/exit\n`);
writeFileSync(join(evidence, 'second.json'), JSON.stringify(second, null, 2), { mode: 0o600 });
assert.equal(second.code, 0, second.stderr);
const store = new TaskStore(join(root, '.runtime', 'app'));
try {
  const task = store.get(id), turns = store.history(id);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].status, 'completed');
  assert.equal(turns[1].status, 'completed');
  assert.ok(turns[1].result.includes(marker), 'resumed response lost the previous marker');
  assert.equal(task.status, 'succeeded');
  const summary = { passed: true, taskId: id, threadId: task.thread_id,
    checks: ['two separate CLI processes', 'same persisted thread', 'prior-turn marker recalled', 'explicit acceptance'],
    turnLogDirs: turns.map(turn => turn.log_dir) };
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
} finally { store.close(); }
