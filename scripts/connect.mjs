import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { ConnectionStore } from './connection-store.mjs';
import { root } from './runtime.mjs';

const appDirectory = join(root, '.runtime', 'app');

function config(provider) {
  const all = parse(readFileSync(join(root, 'config.local.toml'), 'utf8'));
  const value = all.connectors?.[provider];
  if (!value) throw new Error(`config.local.toml 缺少 [connectors.${provider}]。`);
  return value;
}
async function body(response) {
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : {}; } catch { value = { message: text.slice(0, 300) }; }
  if (!response.ok || (value.code && value.code !== 0)) {
    throw new Error(`授权服务返回 HTTP ${response.status}：${value.error_description || value.msg || value.message || response.statusText}`);
  }
  return value;
}
const expiry = value => new Date(Date.now() + Math.max(0, Number(value.expires_in ?? 3600) - 60) * 1000).toISOString();

async function connectOutlook(store) {
  const settings = config('outlook');
  if (!settings.client_id?.trim()) throw new Error('请先填写 connectors.outlook.client_id。');
  const tenant = settings.tenant?.trim() || 'common';
  const scope = 'offline_access openid profile User.Read Mail.Read';
  const form = new URLSearchParams({ client_id: settings.client_id, scope });
  const device = await body(await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/devicecode`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form,
  }));
  console.log(device.message || `请打开 ${device.verification_uri} 并输入代码 ${device.user_code}`);
  const deadline = Date.now() + Number(device.expires_in) * 1000;
  let token;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.max(2, Number(device.interval ?? 5)) * 1000));
    const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
        client_id: settings.client_id, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code,
      }),
    });
    const value = await response.json();
    if (response.ok) { token = value; break; }
    if (value.error === 'authorization_pending') continue;
    if (value.error === 'slow_down') { device.interval = Number(device.interval ?? 5) + 5; continue; }
    throw new Error(`Outlook 授权失败：${value.error_description || value.error}`);
  }
  if (!token) throw new Error('Outlook 授权已超时，请重新运行。');
  const profile = await body(await fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', {
    headers: { authorization: `Bearer ${token.access_token}` },
  }));
  const saved = store.bind('outlook', {
    accountId: profile.id, displayName: profile.displayName,
    accountHint: profile.mail || profile.userPrincipalName,
    scopes: String(token.scope || scope).split(/\s+/).filter(Boolean),
  }, { ...token, client_id: settings.client_id, tenant, scope, expires_at: expiry(token) });
  console.log(`Outlook 已连接：${saved.display_name}${saved.account_hint ? ` (${saved.account_hint})` : ''}`);
}

function waitForCode(redirectUri, expectedState) {
  const target = new URL(redirectUri);
  if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.protocol !== 'http:' || !target.port) {
    throw new Error('飞书 redirect_uri 必须是带端口的本机 HTTP 地址。');
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { server.close(); reject(new Error('飞书授权等待超时。')); }, 300000);
    const server = createServer((request, response) => {
      const incoming = new URL(request.url, target.origin);
      if (incoming.pathname !== target.pathname) { response.writeHead(404).end(); return; }
      const code = incoming.searchParams.get('code');
      const state = incoming.searchParams.get('state');
      const error = incoming.searchParams.get('error');
      if (error || !code || state !== expectedState) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('授权失败，可关闭此页面。');
        clearTimeout(timer); server.close(); reject(new Error(error || '飞书授权回调无效。')); return;
      }
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('授权成功，可返回终端。');
      clearTimeout(timer); server.close(); resolve(code);
    });
    server.on('error', error => { clearTimeout(timer); reject(error); });
    server.listen(Number(target.port), target.hostname);
  });
}

async function connectLark(store) {
  const settings = config('lark');
  for (const key of ['app_id', 'app_secret', 'redirect_uri']) if (!settings[key]?.trim()) throw new Error(`请先填写 connectors.lark.${key}。`);
  const state = randomBytes(24).toString('hex');
  const callback = waitForCode(settings.redirect_uri, state);
  const scope = 'offline_access docx:document:readonly wiki:wiki:readonly';
  const authorize = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
  authorize.search = new URLSearchParams({ client_id: settings.app_id, response_type: 'code',
    redirect_uri: settings.redirect_uri, scope, state }).toString();
  console.log(`请在浏览器打开并完成飞书授权：\n${authorize}`);
  const code = await callback;
  const token = await body(await fetch('https://accounts.feishu.cn/oauth/v3/token', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      grant_type: 'authorization_code', client_id: settings.app_id, client_secret: settings.app_secret,
      code, redirect_uri: settings.redirect_uri,
    }),
  }));
  const profileBody = await body(await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
    headers: { authorization: `Bearer ${token.access_token}` },
  }));
  const profile = profileBody.data ?? profileBody;
  const saved = store.bind('lark', {
    accountId: profile.open_id || profile.user_id || profile.union_id,
    displayName: profile.name || profile.en_name,
    accountHint: profile.email || profile.mobile,
    scopes: String(token.scope || '').split(/\s+/).filter(Boolean),
  }, { ...token, client_id: settings.app_id, client_secret: settings.app_secret,
    expires_at: expiry(token) });
  console.log(`飞书已连接：${saved.display_name}${saved.account_hint ? ` (${saved.account_hint})` : ''}`);
}

async function main() {
  const [command, provider] = process.argv.slice(2);
  const store = new ConnectionStore(appDirectory);
  try {
    if (command === 'status') {
      const rows = store.list();
      console.log(rows.length ? rows.map(x => `${x.provider}: ${x.display_name}${x.account_hint ? ` (${x.account_hint})` : ''} [${x.scopes.join(', ')}]`).join('\n') : 'Outlook：未连接\n飞书：未连接');
    } else if (command === 'disconnect') {
      if (!['outlook', 'lark'].includes(provider)) throw new Error('用法：connect.mjs disconnect outlook|lark');
      console.log(store.disconnect(provider) ? `${provider} 已断开并删除本地 token。` : `${provider} 原本未连接。`);
    } else if (command === 'outlook') await connectOutlook(store);
    else if (command === 'lark') await connectLark(store);
    else throw new Error('用法：connect.mjs status|outlook|lark|disconnect <provider>');
  } finally { store.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
