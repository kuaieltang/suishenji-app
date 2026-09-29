/**
 * GitHub Contents API 客户端。
 *
 * 只用到一个接口族：读写仓库里的文件。不引入任何第三方库，
 * fetch 可注入以便测试。
 */

import { decodeBase64Utf8, encodeBase64Utf8 } from './core.js';

const API_ROOT = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status, path) {
    super(message);
    this.name = 'GitHubError';
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

export function createGitHub({ owner, repo, branch = 'main', token, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const base = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`;

  async function request(url, options = {}) {
    const response = await doFetch(url, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers ?? {}),
      },
    });
    return response;
  }

  async function parseError(response, path) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload?.message ?? '';
    } catch {
      detail = '';
    }
    const hint =
      response.status === 401
        ? '令牌无效或已过期'
        : response.status === 403
          ? '令牌权限不足，需要该仓库的 Contents 读写权限'
          : response.status === 404
            ? '仓库或分支不存在，或令牌没有访问该仓库的权限'
            : '';
    return new GitHubError(
      [`HTTP ${response.status}`, detail, hint].filter(Boolean).join(' · '),
      response.status,
      path
    );
  }

  return {
    base,

    async getFile(path) {
      const response = await request(`${base}/${encodePath(path)}?ref=${encodeURIComponent(branch)}`);
      if (response.status === 404) return { exists: false, sha: '', text: '' };
      if (!response.ok) throw await parseError(response, path);
      const payload = await response.json();
      const text = payload.content ? decodeBase64Utf8(payload.content) : '';
      return { exists: true, sha: payload.sha ?? '', text };
    },

    async putFile(path, text, message, sha = '') {
      const body = {
        message,
        content: encodeBase64Utf8(text),
        branch,
      };
      if (sha) body.sha = sha;
      const response = await request(`${base}/${encodePath(path)}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      if (!response.ok) throw await parseError(response, path);
      const payload = await response.json();
      return { commit: payload.commit?.sha ?? '', content: payload.content?.sha ?? '' };
    },

    async listDir(path) {
      const response = await request(`${base}/${encodePath(path)}?ref=${encodeURIComponent(branch)}`);
      if (response.status === 404) return [];
      if (!response.ok) throw await parseError(response, path);
      const payload = await response.json();
      if (!Array.isArray(payload)) return [];
      return payload.map((entry) => ({ name: entry.name, path: entry.path, type: entry.type }));
    },

    async whoAmI() {
      const response = await request(`${API_ROOT}/user`);
      if (!response.ok) throw await parseError(response, 'user');
      const payload = await response.json();
      return payload.login ?? '';
    },
  };
}
