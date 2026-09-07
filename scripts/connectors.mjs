const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';
const LARK_ROOT = 'https://open.feishu.cn/open-apis';

function safeMessage(response, body) {
  const detail = body?.error?.message || body?.msg || body?.message || response.statusText;
  return `远端返回 HTTP ${response.status}${detail ? `：${String(detail).slice(0, 300)}` : ''}`;
}

async function jsonRequest(fetcher, url, options = {}) {
  const response = await fetcher(url, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { body = { message: text.slice(0, 300) }; }
  if (!response.ok) throw new Error(safeMessage(response, body));
  if (typeof body.code === 'number' && body.code !== 0) throw new Error(`远端业务错误 ${body.code}：${body.msg || body.message || '请求失败'}`);
  return body;
}

function tokenExpiry(body) {
  return new Date(Date.now() + Math.max(0, Number(body.expires_in ?? 3600) - 60) * 1000).toISOString();
}

export function parseLarkDocumentUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('请提供完整的飞书 Docx 或 Wiki URL。'); }
  if (url.protocol !== 'https:' || !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname)) {
    throw new Error('只接受 feishu.cn 或 larksuite.com 的 HTTPS 文档链接。');
  }
  const match = url.pathname.match(/\/(docx|wiki)\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error('链接中没有可识别的 Docx/Wiki token。');
  return { kind: match[1], token: match[2], sourceUrl: `${url.origin}/${match[1]}/${match[2]}` };
}

export class ConnectorClient {
  constructor(store, { fetcher = globalThis.fetch } = {}) {
    this.store = store;
    this.fetcher = fetcher;
    this.refreshing = new Map();
  }
  async accessToken(provider) {
    const tokens = this.store.tokens(provider);
    if (!tokens.expires_at || Date.parse(tokens.expires_at) > Date.now()) return tokens.access_token;
    if (!tokens.refresh_token) throw new Error(`${provider} 授权已过期且不能刷新，请重新连接。`);
    if (!this.refreshing.has(provider)) this.refreshing.set(provider, (async () => {
      const refreshed = provider === 'outlook' ? await this.refreshOutlook(tokens) : await this.refreshLark(tokens);
      this.store.updateTokens(provider, refreshed);
      return refreshed.access_token;
    })().finally(() => this.refreshing.delete(provider)));
    return this.refreshing.get(provider);
  }
  async refreshOutlook(tokens) {
    const form = new URLSearchParams({ client_id: tokens.client_id, grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token, scope: tokens.scope });
    const body = await jsonRequest(this.fetcher,
      `https://login.microsoftonline.com/${encodeURIComponent(tokens.tenant)}/oauth2/v2.0/token`,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
    return { ...tokens, ...body, refresh_token: body.refresh_token ?? tokens.refresh_token, expires_at: tokenExpiry(body) };
  }
  async refreshLark(tokens) {
    const body = await jsonRequest(this.fetcher, 'https://accounts.feishu.cn/oauth/v3/token', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        grant_type: 'refresh_token', client_id: tokens.client_id, client_secret: tokens.client_secret,
        refresh_token: tokens.refresh_token,
      }),
    });
    return { ...tokens, ...body, refresh_token: body.refresh_token ?? tokens.refresh_token, expires_at: tokenExpiry(body) };
  }
  async request(provider, url, options = {}) {
    const token = await this.accessToken(provider);
    try {
      return await jsonRequest(this.fetcher, url, { ...options, headers: {
        accept: 'application/json', authorization: `Bearer ${token}`, ...options.headers,
      } });
    } catch (error) {
      throw new Error(`${provider === 'lark' ? '飞书' : 'Outlook'}只读请求失败：${error.message}`);
    }
  }
  async connectionStatus() { return this.store.list(); }
  async larkReadDocument({ url }) {
    const source = parseLarkDocumentUrl(url);
    let documentId = source.token;
    if (source.kind === 'wiki') {
      const node = await this.request('lark', `${LARK_ROOT}/wiki/v2/spaces/get_node?token=${encodeURIComponent(source.token)}`);
      if (node.code && node.code !== 0) throw new Error(`飞书 Wiki 解析失败：${node.msg || node.code}`);
      if (node.data?.node?.obj_type !== 'docx' || !node.data?.node?.obj_token) {
        throw new Error(`该 Wiki 节点类型为 ${node.data?.node?.obj_type || 'unknown'}，当前只支持 Docx。`);
      }
      documentId = node.data.node.obj_token;
    }
    const [metadata, raw] = await Promise.all([
      this.request('lark', `${LARK_ROOT}/docx/v1/documents/${encodeURIComponent(documentId)}`),
      this.request('lark', `${LARK_ROOT}/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`),
    ]);
    return {
      provider: 'lark', sourceUrl: source.sourceUrl, sourceId: documentId,
      title: metadata.data?.document?.title ?? null,
      revisionId: metadata.data?.document?.revision_id ?? null,
      content: raw.data?.content ?? '', retrievedAt: new Date().toISOString(),
    };
  }
  async outlookSearchMessages({ query, receivedAfter, limit = 10 }) {
    if (!query?.trim()) throw new Error('邮件搜索词不能为空。');
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('limit 必须是 1–25 的整数。');
    const receivedDate = receivedAfter ? new Date(receivedAfter) : null;
    if (receivedDate && Number.isNaN(receivedDate.valueOf())) throw new Error('receivedAfter 必须是有效日期。');
    const search = `\"${query.replaceAll('"', ' ')}\"${receivedDate ? ` received>=${receivedDate.toISOString().slice(0, 10)}` : ''}`;
    const params = new URLSearchParams({
      '$search': search, '$top': String(limit),
      '$select': 'id,conversationId,subject,from,receivedDateTime,bodyPreview,webLink',
    });
    const body = await this.request('outlook', `${GRAPH_ROOT}/me/messages?${params}`, {
      headers: { Prefer: 'outlook.body-content-type="text"' },
    });
    return { provider: 'outlook', query, messages: (body.value ?? []).map(message => ({
      id: message.id, conversationId: message.conversationId, subject: message.subject,
      from: message.from?.emailAddress ?? null, receivedDateTime: message.receivedDateTime,
      bodyPreview: message.bodyPreview, sourceUrl: message.webLink ?? null,
    })), retrievedAt: new Date().toISOString() };
  }
  async outlookGetMessage({ messageId }) {
    if (!messageId?.trim()) throw new Error('messageId 不能为空。');
    const params = new URLSearchParams({ '$select': 'id,conversationId,subject,from,toRecipients,receivedDateTime,body,webLink' });
    const message = await this.request('outlook', `${GRAPH_ROOT}/me/messages/${encodeURIComponent(messageId)}?${params}`, {
      headers: { Prefer: 'outlook.body-content-type="text"' },
    });
    return {
      provider: 'outlook', sourceId: message.id, sourceUrl: message.webLink ?? null,
      conversationId: message.conversationId, subject: message.subject,
      from: message.from?.emailAddress ?? null, to: (message.toRecipients ?? []).map(x => x.emailAddress),
      receivedDateTime: message.receivedDateTime, contentType: message.body?.contentType,
      content: message.body?.content ?? '', retrievedAt: new Date().toISOString(),
    };
  }
}

export const connectorInternals = { jsonRequest, tokenExpiry, GRAPH_ROOT, LARK_ROOT };
