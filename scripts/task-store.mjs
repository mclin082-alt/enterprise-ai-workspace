import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const now = () => new Date().toISOString();
export const localActor = () => `local:${process.getuid?.() ?? 'owner'}`;
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};

// Local owner scoping is not enterprise authentication or an OS security boundary.
export class TaskStore {
  constructor(directory, actor = localActor()) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.actor = actor;
    const path = join(directory, 'tasks.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, actor TEXT NOT NULL, workspace TEXT NOT NULL,
        title TEXT NOT NULL, status TEXT NOT NULL, session_dir TEXT NOT NULL,
        thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        accepted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        prompt TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
        pid INTEGER NOT NULL, log_dir TEXT, result TEXT, error TEXT, error_code TEXT,
        usage TEXT, started_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_running_turn ON turns(task_id) WHERE status='running';
      CREATE INDEX IF NOT EXISTS tasks_actor ON tasks(actor, updated_at);
      PRAGMA user_version=1;`);
    this.recover();
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id) {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id=? AND actor=?').get(id, this.actor);
    if (!task) throw new Error('任务不存在或不属于当前本地身份。');
    return task;
  }
  list() {
    return this.db.prepare('SELECT * FROM tasks WHERE actor=? ORDER BY updated_at DESC, rowid DESC').all(this.actor);
  }
  create(workspace, sessionDir, title) {
    const id = randomUUID(), time = now();
    this.db.prepare('INSERT INTO tasks (id,actor,workspace,title,status,session_dir,thread_id,created_at,updated_at,accepted_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, this.actor, workspace, title.slice(0, 120), 'queued', sessionDir, null, time, time, null);
    return this.get(id);
  }
  history(id) {
    this.get(id);
    return this.db.prepare('SELECT * FROM turns WHERE task_id=? ORDER BY rowid').all(id);
  }
  begin(id, prompt, model) {
    return this.transaction(() => {
      this.get(id);
      const turnId = randomUUID(), time = now();
      if (this.db.prepare("SELECT id FROM turns WHERE task_id=? AND status='running'").get(id)) {
        throw new Error('该任务正在另一个入口执行，请等待完成。');
      }
      this.db.prepare('INSERT INTO turns (id,task_id,prompt,model,status,pid,started_at) VALUES (?,?,?,?,?,?,?)')
        .run(turnId, id, prompt, model, 'running', process.pid, time);
      this.db.prepare("UPDATE tasks SET status='running', accepted_at=NULL, updated_at=? WHERE id=?").run(time, id);
      return turnId;
    });
  }
  logDir(id, turnId, path) {
    this.get(id);
    this.db.prepare("UPDATE turns SET log_dir=? WHERE id=? AND task_id=? AND status='running'").run(path, turnId, id);
  }
  bindThread(id, threadId) {
    const task = this.get(id);
    if (task.thread_id && task.thread_id !== threadId) throw new Error('恢复得到不同 thread ID，已停止。');
    this.db.prepare('UPDATE tasks SET thread_id=?, updated_at=? WHERE id=?').run(threadId, now(), id);
  }
  finish(id, turnId, { status, result = '', error = null, errorCode = null, usage = null }) {
    if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(status)) throw new Error('无效的 turn 状态。');
    return this.transaction(() => {
      this.get(id);
      const time = now();
      const update = this.db.prepare(`UPDATE turns SET status=?, result=?, error=?, error_code=?, usage=?, finished_at=?
        WHERE id=? AND task_id=? AND status='running'`).run(status, result, error, errorCode, usage ? JSON.stringify(usage) : null, time, turnId, id);
      if (update.changes !== 1) throw new Error('该 turn 已结束或不属于任务。');
      this.db.prepare('UPDATE tasks SET status=?, updated_at=? WHERE id=?')
        .run(status === 'completed' ? 'awaiting_review' : status, time, id);
    });
  }
  accept(id) {
    return this.transaction(() => {
      if (this.get(id).status !== 'awaiting_review') throw new Error('只有待验收的任务可以标记成功。');
      const time = now();
      this.db.prepare("UPDATE tasks SET status='succeeded', accepted_at=?, updated_at=? WHERE id=?").run(time, time, id);
    });
  }
  recover() {
    this.transaction(() => {
      const turns = this.db.prepare("SELECT turns.* FROM turns JOIN tasks ON tasks.id=turns.task_id WHERE tasks.actor=? AND turns.status='running'").all(this.actor);
      for (const turn of turns) {
        if (alive(turn.pid)) continue;
        const time = now();
        this.db.prepare("UPDATE turns SET status='interrupted', error_code='process_lost', error='上次进程意外退出；未自动重试。', finished_at=? WHERE id=?").run(time, turn.id);
        this.db.prepare("UPDATE tasks SET status='interrupted', updated_at=? WHERE id=?").run(time, turn.task_id);
      }
    });
  }
  close() { this.db.close(); }
}
