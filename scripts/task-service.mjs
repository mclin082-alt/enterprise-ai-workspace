import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime, root, threadOptions, workspacePath } from './runtime.mjs';

export class TaskService {
  constructor(store, provider, { runtimeFactory = createRuntime, stateRoot, appDirectory = join(root, '.runtime', 'app') } = {}) {
    this.store = store;
    this.provider = provider;
    this.runtimeFactory = runtimeFactory;
    this.stateRoot = stateRoot;
    this.appDirectory = appDirectory;
  }
  redact(value) { return String(value).split(this.provider.api_key).join('[REDACTED]'); }
  create(workspace, title) {
    workspace = workspacePath(workspace);
    const runtime = this.runtimeFactory(this.provider, { stateRoot: this.stateRoot });
    return this.store.create(workspace, runtime.sessionDir, this.redact(title));
  }
  async run(id, prompt, { signal, timeoutMs = 180000, onEvent = () => {} } = {}) {
    if (!prompt.trim()) throw new Error('任务内容不能为空。');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeoutMs 必须是正整数。');
    const turnId = this.store.begin(id, this.redact(prompt), this.provider.model);
    const task = this.store.get(id);
    const turnDir = join(task.session_dir, `turn-${turnId}`);
    const summary = { taskId: id, turnId, actor: task.actor, workspace: task.workspace,
      model: this.provider.model, status: 'running', startedAt: new Date().toISOString() };
    const save = (name, value) => writeFileSync(join(turnDir, name), this.redact(typeof value === 'string' ? value : JSON.stringify(value, null, 2)), { mode: 0o600 });
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let result = '', logReady = false;
    try {
      // Revalidate the workspace and persistent runtime before every turn.
      if (workspacePath(task.workspace) !== task.workspace) throw new Error('任务目录已变化，无法恢复。');
      const runtime = this.runtimeFactory(this.provider, { stateRoot: this.stateRoot, sessionDir: task.session_dir,
        connectorContext: { actor: task.actor, taskId: task.id, appDirectory: this.appDirectory } });
      mkdirSync(turnDir, { mode: 0o700 });
      logReady = true;
      this.store.logDir(id, turnId, turnDir);
      save('prompt.txt', prompt);
      save('summary.json', summary);
      combined.throwIfAborted();
      const options = threadOptions(this.provider, task.workspace);
      const thread = task.thread_id ? runtime.codex.resumeThread(task.thread_id, options) : runtime.codex.startThread(options);
      const { events } = await thread.runStreamed(prompt, { signal: combined });
      let completed = false;
      for await (const event of events) {
        appendFileSync(join(turnDir, 'events.jsonl'), this.redact(JSON.stringify(event)) + '\n', { mode: 0o600 });
        if (event.type === 'thread.started') this.store.bindThread(id, event.thread_id);
        if (event.type === 'item.completed' && event.item.type === 'agent_message') result += event.item.text + '\n';
        onEvent(JSON.parse(this.redact(JSON.stringify(event))));
        if (event.type === 'turn.completed') { completed = true; summary.usage = event.usage; }
        if (event.type === 'turn.failed' || event.type === 'error') throw new Error(event.error?.message || event.message || 'Runtime 执行失败。');
      }
      combined.throwIfAborted();
      if (!completed) throw new Error('事件流结束，但没有 turn.completed。');
      if (!this.store.get(id).thread_id) throw new Error('缺少 thread ID，无法保证后续恢复。');
      summary.status = 'completed';
    } catch (error) {
      summary.status = signal?.aborted ? 'cancelled' : 'failed';
      summary.errorCode = signal?.aborted ? 'cancelled' : deadline.aborted ? 'timeout' : 'runtime_error';
      summary.error = this.redact(deadline.aborted && !signal?.aborted ? '本轮执行超时；已停止，未自动重试。' : error.message);
    }
    summary.result = this.redact(result);
    summary.finishedAt = new Date().toISOString();
    summary.threadId = this.store.get(id).thread_id;
    summary.taskStatus = summary.status === 'completed' ? 'awaiting_review' : summary.status;
    this.store.finish(id, turnId, { status: summary.status, result: summary.result,
      error: summary.error, errorCode: summary.errorCode, usage: summary.usage });
    if (logReady) save('summary.json', summary);
    return { ...summary, logDir: logReady ? turnDir : null };
  }
}
