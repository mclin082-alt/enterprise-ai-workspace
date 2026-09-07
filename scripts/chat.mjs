import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { readProvider, root, workspacePath } from './runtime.mjs';
import { TaskStore } from './task-store.mjs';
import { TaskService } from './task-service.mjs';
import { ConnectionStore } from './connection-store.mjs';

const help = `/tasks 历史任务 · /resume <完整ID> 继续任务 · /history 当前对话
/status 当前状态 · /done 标记验收通过 · /connections 连接状态
/new 新任务 · /exit 退出 · Ctrl+C 取消并退出`;
const labels = { queued: '未开始', running: '运行中', awaiting_review: '待验收', succeeded: '已验收',
  failed: '失败', cancelled: '已取消', interrupted: '意外中断' };
function displayEvent(event) {
  const item = event.item;
  if (event.type === 'item.started' && item.type === 'command_execution') console.log(`\n执行 > ${item.command}`);
  if (event.type !== 'item.completed') return;
  if (item.type === 'agent_message') console.log(`\nAgent > ${item.text}`);
  if (item.type === 'command_execution') console.log(`${item.aggregated_output || ''}\n[退出码 ${item.exit_code ?? '?'}]`);
  if (item.type === 'file_change') console.log(`文件变更 [${item.status}] > ${item.changes.map(c => c.path).join(', ')}`);
  if (item.type === 'error') console.log(`Runtime 提示 > ${item.message}`);
}

async function main() {
  if (process.argv.includes('--help')) { console.log(`npm start [-- /absolute/project]\n${help}`); return; }
  if (process.argv.length > 3) throw new Error('最多指定一个项目目录；任务请在界面中输入。');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  const lines = rl[Symbol.asyncIterator]();
  const controller = new AbortController();
  let interrupted = false, store, connections;
  const cancel = () => { interrupted = true; controller.abort(); rl.close(); };
  rl.on('SIGINT', cancel);
  process.on('SIGINT', cancel);
  const ask = async label => { process.stdout.write(label); const line = await lines.next(); return line.done ? null : line.value; };
  try {
    console.log('\nEnterprise AI · 本地 CLI\n');
    const inputPath = process.argv[2] ?? await ask('项目目录（绝对路径）：');
    if (inputPath === null || interrupted) return;
    let workspace = workspacePath(inputPath.trim());
    const appDirectory = join(root, '.runtime', 'app');
    store = new TaskStore(appDirectory);
    connections = new ConnectionStore(appDirectory, store.actor);
    // History and local commands work even when provider configuration is unavailable.
    let service, currentId;
    const getService = () => service ??= new TaskService(store, readProvider(), { appDirectory });
    console.log(`\n项目：${workspace}\n身份：${store.actor}\n${help}\n运行 npm run connect:outlook / connect:lark 可连接只读账号。\n`);
    while (!interrupted) {
      const prompt = await ask('你 > ');
      if (prompt === null || interrupted || prompt.trim() === '/exit') break;
      const command = prompt.trim();
      if (!command) continue;
      try {
        if (command === '/help') { console.log(help); continue; }
        if (command === '/new') { currentId = undefined; console.log('下条输入将新建任务。'); continue; }
        if (command === '/tasks') {
          const tasks = store.list();
          console.log(tasks.map(t => `${t.id} | ${labels[t.status]} | ${t.title.replaceAll('\n', ' ')} | ${t.workspace}`).join('\n') || '暂无任务。');
          continue;
        }
        if (command.startsWith('/resume ')) {
          const task = store.get(command.slice(8).trim());
          if (task.status === 'running') throw new Error('该任务仍在运行，暂不能继续。');
          workspace = workspacePath(task.workspace);
          currentId = task.id;
          console.log(`已选择任务：${task.id}\n项目：${workspace}\n状态：${labels[task.status]}\n输入新指令继续；不会自动重放上次指令。`);
          continue;
        }
        if (command === '/connections') {
          const byProvider = Object.fromEntries(connections.list().map(item => [item.provider, item]));
          const line = (provider, label) => byProvider[provider]
            ? `${label}：已连接 ${byProvider[provider].display_name}${byProvider[provider].account_hint ? ` (${byProvider[provider].account_hint})` : ''}`
            : `${label}：未连接`;
          console.log(`身份：${store.actor}\n${line('outlook', 'Outlook')}\n${line('lark', '飞书')}`);
          continue;
        }
        if (['/history', '/status', '/done'].includes(command)) {
          if (!currentId) throw new Error('请先输入任务或用 /resume 选择历史任务。');
          if (command === '/done') { store.accept(currentId); console.log('已记录你的验收：succeeded。此操作不会批准或执行外部写入。'); }
          if (command === '/status') {
            const task = store.get(currentId);
            console.log(`任务：${task.id}\n状态：${labels[task.status]}\n身份：${task.actor}\n项目：${task.workspace}`);
          }
          if (command === '/history') for (const turn of store.history(currentId)) {
            console.log(`\n[${turn.started_at}] turn=${turn.status}\n你 > ${turn.prompt}\nAgent > ${turn.result || '（无完整回复）'}${turn.error ? `\n错误 [${turn.error_code}]：${turn.error}` : ''}`);
          }
          continue;
        }
        if (command.startsWith('/')) throw new Error('未知命令。输入 /help 查看可用命令；自然语言任务请直接输入。');
        const app = getService();
        currentId ??= app.create(workspace, prompt).id;
        console.log(`任务：${currentId}`);
        const heartbeat = setInterval(() => console.log('…仍在运行，Ctrl+C 可取消并退出。'), 20000);
        let result;
        try { result = await app.run(currentId, prompt, { signal: controller.signal, onEvent: displayEvent }); }
        finally { clearInterval(heartbeat); }
        if (result.status === 'completed') console.log('\n本轮结束；任务待验收。可继续追问，或 /done 标记验收通过。');
        else {
          console.error(`\n${labels[result.taskStatus]} [${result.errorCode}]：${result.error}`);
          console.log('已发生的文件修改保留，请检查现场。');
          if (!process.stdin.isTTY) process.exitCode = 1;
        }
        console.log(`\n记录：${result.logDir ?? '见任务历史'}\n`);
      } catch (error) {
        console.error(error.message);
        if (!process.stdin.isTTY) process.exitCode = 1;
      }
    }
  } finally {
    connections?.close();
    store?.close();
    rl.close();
    process.removeListener('SIGINT', cancel);
    if (interrupted) process.exitCode = 130;
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
