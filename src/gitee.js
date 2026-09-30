/**
 * Gitee / GitCode Contents API 客户端。
 *
 * 与 GitHub 客户端（github.js）提供同一套接口：getFile / putFile / listDir / whoAmI，
 * 所以 sync.js 一行都不用改。两者的差别集中在三处：
 *
 *   1. 鉴权走 access_token 查询参数，而不是 Authorization 头；
 *   2. 新建文件用 POST、更新用 PUT（GitHub 两种都是 PUT）；
 *   3. 读单个文件同样返回 base64 的 content 与 sha，这点与 GitHub 一致。
 *
 * 同一份实现同时服务 Gitee 与 GitCode：后者是 Gitee 的衍生实现，接口族相同，
 * 只是域名不同，因此 apiRoot 可注入。
 */

import { decodeBase64Utf8, encodeBase64Utf8 } from './core.js';

export const GITEE_API_ROOT = 'https://gitee.com/api/v5';
export const GITCODE_API_ROOT = 'https://api.gitcode.com/api/v5';

export class GiteeError extends Error {
  constructor(message, status, path) {
    super(message);
    this.name = 'GiteeError';
    this.status = status;
    this.path = path;
  }
}

function encodePath(path) {
  return String(path)
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function createGitee({
  owner,
  repo,
  branch = 'main',
  token,
  fetchImpl,
  apiRoot = GITEE_API_ROOT,
} = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const base = `${apiRoot}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`;

  function withToken(url) {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}access_token=${encodeURIComponent(token ?? '')}`;
  }

  function requestHeaders(hasBody) {
    return hasBody ? { 'Content-Type': 'application/json' } : { Accept: 'application/json' };
  }

  async function parseError(response, path) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload?.message ?? payload?.error_message ?? '';
    } catch {
      detail = '';
    }
    const hint =
      response.status === 401
        ? '令牌无效或已过期'
        : response.status === 403
          ? '令牌权限不足，需要该仓库的内容（Contents / projects）读写权限'
          : response.status === 404
            ? '仓库或分支不存在，或令牌没有访问该仓库的权限'
            : '';
    return new GiteeError(
      [`HTTP ${response.status}`, detail, hint].filter(Boolean).join(' · '),
      response.status,
      path
    );
  }

  async function write(path, text, message, sha, method) {
    const body = {
      access_token: token ?? '',
      content: encodeBase64Utf8(text),
      message,
      branch,
    };
    if (sha) body.sha = sha;
    return doFetch(withToken(`${base}/${encodePath(path)}`), {
      method,
      headers: requestHeaders(true),
      body: JSON.stringify(body),
    });
  }

  async function freshSha(path) {
    const response = await doFetch(
      withToken(`${base}/${encodePath(path)}?ref=${encodeURIComponent(branch)}`),
      { headers: requestHeaders(false) }
    );
    if (!response.ok) return '';
    try {
      const payload = await response.json();
      return Array.isArray(payload) ? '' : payload?.sha ?? '';
    } catch {
      return '';
    }
  }

  return {
    base,

    async getFile(path) {
      const response = await doFetch(
        withToken(`${base}/${encodePath(path)}?ref=${encodeURIComponent(branch)}`),
        { headers: requestHeaders(false) }
      );
      if (response.status === 404) return { exists: false, sha: '', text: '' };
      if (!response.ok) throw await parseError(response, path);
      const payload = await response.json();
      if (Array.isArray(payload)) return { exists: false, sha: '', text: '' };
      const text = payload?.content ? decodeBase64Utf8(payload.content) : '';
      return { exists: true, sha: payload?.sha ?? '', text };
    },

    async putFile(path, text, message, sha = '') {
      let response = await write(path, text, message, sha, sha ? 'PUT' : 'POST');
      if (!response.ok && !sha && (response.status === 400 || response.status === 409)) {
        // 读取之后文件被别人创建了：取一次 sha，改按更新处理再试一次
        const latest = await freshSha(path);
        if (latest) response = await write(path, text, message, latest, 'PUT');
      }
      if (!response.ok) throw await parseError(response, path);
      const payload = await response.json().catch(() => ({}));
      return {
        commit: payload?.commit?.sha ?? '',
        content: payload?.content?.sha ?? payload?.sha ?? '',
      };
    },

    async listDir(path) {
      const response = await doFetch(
        withToken(`${base}/${encodePath(path)}?ref=${encodeURIComponent(branch)}`),
        { headers: requestHeaders(false) }
      );
      if (response.status === 404) return [];
      if (!response.ok) throw await parseError(response, path);
      const payload = await response.json().catch(() => []);
      if (!Array.isArray(payload)) return [];
      return payload.map((entry) => ({ name: entry.name, path: entry.path, type: entry.type }));
    },

    async whoAmI() {
      const response = await doFetch(withToken(`${apiRoot}/user`), {
        headers: requestHeaders(false),
      });
      if (!response.ok) throw await parseError(response, 'user');
      const payload = await response.json().catch(() => ({}));
      return payload?.login ?? payload?.name ?? '';
    },
  };
}
