import { createRuntime } from './runtime.mjs';
import { parse } from 'smol-toml';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
if (!['smoke', 'repair'].includes(mode)) throw new Error('Usage: npm run smoke | npm run repair -- /absolute/fixture');
const fixture = resolve(process.argv[3] || '/Users/lll/Desktop/rollout-fixture');
const python = process.env.FIXTURE_PYTHON || '/opt/homebrew/bin/python3';
const provider = parse(readFileSync(join(root, 'config.local.toml'), 'utf8')).provider;
const key = provider.api_key?.trim();
if (!key) throw new Error('Fill api_key in config.local.toml locally.');
if (provider.wire_api !== 'responses') throw new Error('This adapter requires wire_api = responses.');
const endpoint = new URL(provider.base_url);
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('Use an HTTPS provider URL without credentials.');
const redact = (value) => String(value).split(key).join('[REDACTED]');
const runDir = join(root, 'runs', new Date().toISOString().replaceAll(':', '-') + '-' + mode);
mkdirSync(runDir, { recursive: true, mode: 0o700 });
const save = (name, data) => writeFileSync(join(runDir, name), redact(typeof data === 'string' ? data : JSON.stringify(data, null, 2)), { mode: 0o600 });
const hash = (b) => createHash('sha256').update(b).digest('hex');
function snapshot(dir, prefix = '') {
  const result = {};
  for (const name of readdirSync(dir).sort()) {
    if (name === '.git') continue;
    const path = join(dir, name), relative = prefix + name;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('Fixture symlinks are not supported: ' + relative);
    if (stat.isDirectory()) Object.assign(result, snapshot(path, relative + '/'));
    else if (stat.isFile()) result[relative] = hash(readFileSync(path));
  }
  return result;
}
function test() {
  const r = spawnSync(python, ['-B', '-m', 'unittest', '-v'], { cwd: fixture, encoding: 'utf8', timeout: 30000 });
  return { exitCode: r.status, output: (r.stdout || '') + (r.stderr || ''), error: r.error?.message };
}

const summary = { mode, fixture, model: provider.model, baseUrl: provider.base_url, startedAt: new Date().toISOString(), status: 'running' };
save('summary.json', summary);
let before, baseline, cartBefore;
let completed = false;
try {
  before = snapshot(fixture);
  if (mode === 'repair') {
    for (const file of ['AGENTS.md', 'cart.py', 'test_cart.py']) {
      if (!(file in before)) throw new Error('Missing fixture file: ' + file);
    }
    baseline = test();
    save('tests-before.txt', baseline.output);
    if (baseline.exitCode !== 1 || !baseline.output.includes('FAILED (failures=2)') || !baseline.output.includes('Ran 4 tests')) {
      throw new Error('Expected baseline: 4 tests, exactly 2 failures. Inspect tests-before.txt before running repair.');
    }
    cartBefore = readFileSync(join(fixture, 'cart.py'));
    save('cart.before.py', cartBefore.toString());
    save('hashes-before.json', before);
  }
  const { codex, sessionDir } = createRuntime({ ...provider, api_key: key }, { python });
  summary.runtimeSessionDir = sessionDir;
  const thread = codex.startThread({
    model: provider.model, workingDirectory: fixture, skipGitRepoCheck: true,
    sandboxMode: mode === 'repair' ? 'workspace-write' : 'read-only',
    approvalPolicy: 'never', networkAccessEnabled: false, webSearchMode: 'disabled',
  });
  const prompt = mode === 'smoke'
    ? 'Reply with exactly OK. Do not use tools or read or modify any files.'
    : `Fix the cart calculation bug in this working directory. Read and follow AGENTS.md. Only modify cart.py. Do not alter, delete, rename or bypass test_cart.py or AGENTS.md. Do not create other files. Run ${python} -B -m unittest -v before and after the repair. Do not commit or push. Report the change and actual test results. Stay within this fixture directory.`;
  save('prompt.txt', prompt);
  console.log(`Started ${mode}; evidence: ${runDir}`);
  const { events } = await thread.runStreamed(prompt, { signal: AbortSignal.timeout(mode === 'repair' ? 180000 : 90000) });
  for await (const event of events) {
    writeFileSync(join(runDir, 'events.jsonl'), redact(JSON.stringify(event)) + '\n', { flag: 'a', mode: 0o600 });
    console.log(redact(event.type + (event.item?.type ? ' ' + event.item.type : '')));
    if (event.type === 'thread.started') summary.threadId = event.thread_id;
    if (event.type === 'item.completed' && event.item.type === 'agent_message') summary.finalResponse = event.item.text;
    if (event.type === 'turn.completed') { completed = true; summary.usage = event.usage; }
    if (event.type === 'turn.failed') throw new Error(event.error.message);
    if (event.type === 'error') throw new Error(event.message);
  }
  if (!completed) throw new Error('Stream ended without turn.completed.');
  if (mode === 'smoke' && summary.finalResponse?.trim() !== 'OK') throw new Error('Smoke response was not exactly OK.');
  summary.status = 'passed';
} catch (error) {
  summary.status = 'failed';
  summary.error = redact(error.message);
  process.exitCode = 1;
} finally {
  if (before) {
    try {
      const after = snapshot(fixture);
      summary.changedFiles = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(p => before[p] !== after[p]);
      save('hashes-after.json', after);
      if (mode === 'repair' && baseline) {
        const result = test();
        save('tests-after.txt', result.output);
        summary.testsBeforeExitCode = baseline.exitCode;
        summary.testsAfterExitCode = result.exitCode;
        summary.testFileUnchanged = before['test_cart.py'] === after['test_cart.py'];
        const allowed = summary.changedFiles.length === 1 && summary.changedFiles[0] === 'cart.py';
        if (!completed || result.exitCode !== 0 || !result.output.includes('Ran 4 tests') || !allowed) {
          summary.status = 'failed'; process.exitCode = 1;
        }
        if (cartBefore) {
          save('cart.after.py', readFileSync(join(fixture, 'cart.py'), 'utf8'));
          const diff = spawnSync('git', ['diff', '--no-index', '--', join(runDir, 'cart.before.py'), join(runDir, 'cart.after.py')], { encoding: 'utf8' });
          save('changes.diff', diff.stdout || diff.stderr || '');
        }
      } else if (summary.changedFiles.length) { summary.status = 'failed'; process.exitCode = 1; }
    } catch (error) { summary.status = 'failed'; summary.verificationError = redact(error.message); process.exitCode = 1; }
  }
  summary.finishedAt = new Date().toISOString();
  save('summary.json', summary);
  console.log(redact(JSON.stringify(summary, null, 2)));
}
