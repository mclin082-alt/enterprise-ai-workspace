import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stringify } from 'smol-toml';
import { isolatedOptions, root } from '../scripts/runtime.mjs';

const provider = { name: 'test', model: 'kimi-k3', api_key: 'TEST_SECRET_DO_NOT_INJECT', base_url: 'https://example.invalid/v1', wire_api: 'responses' };
function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), 'enterprise-cli-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('fresh launches use distinct state; shell receives no provider credential', t => {
  const stateRoot = temporary(t);
  const a = isolatedOptions(provider, { stateRoot });
  const b = isolatedOptions(provider, { stateRoot });
  assert.notEqual(a.codexDir, b.codexDir);
  assert.notEqual(a.options.env.HOME, process.env.HOME);
  assert.equal(a.options.env.ENTERPRISE_PROVIDER_API_KEY, provider.api_key);
  const policy = a.options.config.shell_environment_policy;
  assert.equal(policy.inherit, 'none');
  assert.ok(!JSON.stringify(policy).includes(provider.api_key));
  assert.equal(a.options.env.ZDOTDIR, a.options.env.HOME);
  assert.equal(a.options.env.CODEX_THREAD_ID, undefined);
});

test('real runtime prompt keeps project rules and literal user text, excludes memory', t => {
  const stateRoot = temporary(t);
  const r = isolatedOptions(provider, { stateRoot });
  const project = join(stateRoot, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'AGENTS.md'), 'PROJECT_RULE_CANARY: do not edit tests.');
  mkdirSync(join(r.codexDir, 'memories'));
  writeFileSync(join(r.codexDir, 'memories', 'memory_summary.md'), 'MEMORY_CANARY_MUST_NOT_APPEAR');
  writeFileSync(join(r.codexDir, 'config.toml'), stringify({ ...r.options.config, model: provider.model }));
  const target = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
  const binary = join(root, 'node_modules', '@openai', `codex-${process.platform}-${process.arch}`, 'vendor', target, 'bin', 'codex');
  const prompt = '修复错误，不可以改 test。保留原话 $(echo hello) `literal`';
  const result = spawnSync(binary, ['debug', 'prompt-input', prompt], { cwd: project, env: r.options.env, encoding: 'utf8', timeout: 30000, maxBuffer: 4000000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const messages = JSON.parse(result.stdout);
  assert.ok(messages.some(m => m.role === 'user' && m.content?.some(c => c.text === prompt)));
  assert.ok(result.stdout.includes('PROJECT_RULE_CANARY'));
  assert.ok(!result.stdout.includes('MEMORY_CANARY_MUST_NOT_APPEAR'));
  assert.ok(!result.stdout.includes(provider.api_key));
  assert.ok(!result.stdout.includes(`${process.env.HOME}/.codex/memories`));
  assert.ok(!result.stdout.includes(`${process.env.HOME}/.agents/skills`));
});

test('CLI accepts project selection and exit without submitting a model task', () => {
  const result = spawnSync(process.execPath, ['scripts/chat.mjs'], { cwd: root, input: `${root}\n/exit\n`, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('你 >'));
  assert.ok(!result.stdout.includes('记录：'));
});
