import { Codex } from '@openai/codex-sdk';
import { parse } from 'smol-toml';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function readProvider() {
  const provider = parse(readFileSync(join(root, 'config.local.toml'), 'utf8')).provider;
  if (!provider?.api_key?.trim()) throw new Error('请先在 config.local.toml 填写 API key。');
  if (!provider.model || provider.wire_api !== 'responses') throw new Error('需要 model 和 wire_api = responses。');
  const endpoint = new URL(provider.base_url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('Provider 必须使用不含凭据的 HTTPS URL。');
  return { ...provider, api_key: provider.api_key.trim() };
}

export function workspacePath(input) {
  const path = realpathSync(resolve(input));
  if (!statSync(path).isDirectory()) throw new Error('项目路径必须是目录。');
  return path;
}

// Configuration/context isolation, NOT a filesystem read-denial boundary.
// New tasks use fresh directories; explicit resume reuses only that task's state.
export function isolatedOptions(provider, { stateRoot = join(root, '.runtime'), sessionDir: existingSession, python = '/opt/homebrew/bin/python3' } = {}) {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const sessionDir = existingSession ? realpathSync(existingSession) : mkdtempSync(join(stateRoot, 'session-'));
  if (existingSession && (!sessionDir.startsWith(realpathSync(stateRoot) + '/') || !statSync(join(sessionDir, 'codex')).isDirectory())) {
    throw new Error('任务 runtime 状态不存在或不属于本应用；不能恢复。');
  }
  const homeDir = join(sessionDir, 'home');
  const codexDir = join(sessionDir, 'codex');
  const tempDir = join(sessionDir, 'tmp');
  for (const path of [homeDir, codexDir, tempDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const toolEnv = {
    HOME: homeDir, CODEX_HOME: codexDir, ZDOTDIR: homeDir,
    XDG_CONFIG_HOME: join(homeDir, '.config'), XDG_DATA_HOME: join(homeDir, '.local/share'),
    XDG_CACHE_HOME: join(homeDir, '.cache'), TMPDIR: tempDir,
    PATH: dirname(python) + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8', SHELL: '/bin/zsh', PYTHONDONTWRITEBYTECODE: '1',
  };
  return {
    sessionDir, codexDir,
    options: {
      env: { ...toolEnv, ENTERPRISE_PROVIDER_API_KEY: provider.api_key },
      config: {
        model_provider: 'enterprise_provider',
        model_providers: { enterprise_provider: {
          name: provider.name || 'enterprise_provider', base_url: provider.base_url,
          wire_api: provider.wire_api, env_key: 'ENTERPRISE_PROVIDER_API_KEY', requires_openai_auth: false,
          request_max_retries: 0, stream_max_retries: 0, stream_idle_timeout_ms: 60000,
        } },
        features: { memories: false },
        memories: { use_memories: false, generate_memories: false },
        shell_environment_policy: { inherit: 'none', set: toolEnv, experimental_use_profile: false },
      },
    },
  };
}

export function connectorMcpConfig({ actor, taskId, appDirectory }) {
  if (!actor || !taskId || !appDirectory) throw new Error('Connector MCP 缺少 actor、taskId 或 appDirectory。');
  return {
    enterprise_connectors: {
      command: process.execPath,
      args: [join(root, 'scripts', 'connector-mcp.mjs')],
      cwd: root,
      env: {
        ENTERPRISE_CONNECTOR_ACTOR: actor,
        ENTERPRISE_CONNECTOR_TASK_ID: taskId,
        ENTERPRISE_CONNECTOR_APP_DIR: appDirectory,
      },
      enabled_tools: ['connection_status', 'lark_read_document', 'outlook_search_messages', 'outlook_get_message'],
      default_tools_approval_mode: 'approve',
      required: true,
      startup_timeout_sec: 10,
      tool_timeout_sec: 45,
    },
  };
}

export function createRuntime(provider, settings = {}) {
  const isolated = isolatedOptions(provider, settings);
  if (settings.connectorContext) {
    isolated.options.config.mcp_servers = connectorMcpConfig(settings.connectorContext);
  }
  return { ...isolated, codex: new Codex(isolated.options) };
}

export function threadOptions(provider, workspace, readOnly = false) {
  return {
    model: provider.model, workingDirectory: workspace, skipGitRepoCheck: true,
    sandboxMode: readOnly ? 'read-only' : 'workspace-write',
    approvalPolicy: 'never', networkAccessEnabled: false, webSearchMode: 'disabled',
  };
}
