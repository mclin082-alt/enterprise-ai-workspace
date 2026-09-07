import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { localActor } from './task-store.mjs';

const providers = new Set(['outlook', 'lark']);
const now = () => new Date().toISOString();

function providerName(provider) {
  if (!providers.has(provider)) throw new Error(`不支持的 connector：${provider}`);
  return provider;
}

export class TokenVault {
  constructor(directory) {
    this.directory = join(directory, 'connector-secrets');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }
  path(actor, provider) {
    providerName(provider);
    const key = createHash('sha256').update(`${actor}\0${provider}`).digest('hex');
    return join(this.directory, `${key}.json`);
  }
  write(actor, provider, value) {
    const path = this.path(actor, provider);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  }
  read(actor, provider) {
    try { return JSON.parse(readFileSync(this.path(actor, provider), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`${provider} 凭据不存在，请重新连接。`);
      throw error;
    }
  }
  remove(actor, provider) { rmSync(this.path(actor, provider), { force: true }); }
}

// This is a single-user spike. Mode 0600 reduces accidental exposure but is not
// an enterprise credential service or an OS isolation boundary.
export class ConnectionStore {
  constructor(directory, actor = localActor()) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.actor = actor;
    this.vault = new TokenVault(directory);
    const path = join(directory, 'connections.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS connections (
        actor TEXT NOT NULL, provider TEXT NOT NULL, account_id TEXT NOT NULL,
        display_name TEXT NOT NULL, account_hint TEXT, scopes TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (actor, provider)
      );
      CREATE TABLE IF NOT EXISTS source_accesses (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, actor TEXT NOT NULL,
        provider TEXT NOT NULL, tool TEXT NOT NULL, source_id TEXT,
        source_url TEXT, outcome TEXT NOT NULL, occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS source_access_task ON source_accesses(actor, task_id, occurred_at);
      PRAGMA user_version=1;`);
  }
  list() {
    return this.db.prepare(`SELECT provider,account_id,display_name,account_hint,scopes,created_at,updated_at
      FROM connections WHERE actor=? ORDER BY provider`).all(this.actor).map(row => ({ ...row, scopes: JSON.parse(row.scopes) }));
  }
  get(provider) {
    providerName(provider);
    const row = this.db.prepare(`SELECT provider,account_id,display_name,account_hint,scopes,created_at,updated_at
      FROM connections WHERE actor=? AND provider=?`).get(this.actor, provider);
    return row ? { ...row, scopes: JSON.parse(row.scopes) } : null;
  }
  bind(provider, profile, tokens) {
    providerName(provider);
    if (!profile?.accountId || !profile?.displayName) throw new Error('授权结果缺少稳定账号身份，拒绝绑定。');
    if (!tokens?.access_token) throw new Error('授权结果缺少 access token，拒绝绑定。');
    const time = now();
    const scopes = [...new Set(profile.scopes ?? [])].sort();
    this.vault.write(this.actor, provider, tokens);
    this.db.prepare(`INSERT INTO connections
      (actor,provider,account_id,display_name,account_hint,scopes,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(actor,provider) DO UPDATE SET
      account_id=excluded.account_id,display_name=excluded.display_name,
      account_hint=excluded.account_hint,scopes=excluded.scopes,updated_at=excluded.updated_at`)
      .run(this.actor, provider, String(profile.accountId), String(profile.displayName),
        profile.accountHint ? String(profile.accountHint) : null, JSON.stringify(scopes), time, time);
    return this.get(provider);
  }
  tokens(provider) {
    if (!this.get(provider)) throw new Error(`${provider} 未连接。`);
    return this.vault.read(this.actor, provider);
  }
  updateTokens(provider, tokens) {
    if (!this.get(provider)) throw new Error(`${provider} 未连接。`);
    this.vault.write(this.actor, provider, tokens);
    this.db.prepare('UPDATE connections SET updated_at=? WHERE actor=? AND provider=?').run(now(), this.actor, provider);
  }
  disconnect(provider) {
    providerName(provider);
    const result = this.db.prepare('DELETE FROM connections WHERE actor=? AND provider=?').run(this.actor, provider);
    this.vault.remove(this.actor, provider);
    return result.changes === 1;
  }
  recordAccess({ taskId, provider, tool, sourceId = null, sourceUrl = null, outcome }) {
    providerName(provider);
    if (!taskId) throw new Error('缺少 task ID，不能记录来源访问。');
    this.db.prepare(`INSERT INTO source_accesses
      (task_id,actor,provider,tool,source_id,source_url,outcome,occurred_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(taskId, this.actor, provider, tool, sourceId, sourceUrl, outcome, now());
  }
  accesses(taskId) {
    return this.db.prepare('SELECT * FROM source_accesses WHERE actor=? AND task_id=? ORDER BY id').all(this.actor, taskId);
  }
  close() { this.db.close(); }
}
