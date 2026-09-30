/**
 * 远端仓库客户端工厂：把"用哪家托管"收敛成一个 provider 字段。
 *
 * 上层（app.js / sync.js）只依赖各客户端共有的那套接口——getFile / putFile /
 * listDir / whoAmI——所以换托管不用改同步逻辑，只改设置里的一个下拉框。
 *
 * 选型背景见 docs/network.md：GitHub 在国内需要代理，早晚两个计划任务无人值守，
 * 因此默认仍兼容 GitHub，但推荐把主力放在国内可直连的托管上。
 */

import { createGitHub } from './github.js';
import { GITCODE_API_ROOT, GITEE_API_ROOT, GiteeError, createGitee } from './gitee.js';

export const DEFAULT_PROVIDER = 'github';

export const PROVIDERS = {
  github: {
    id: 'github',
    label: 'GitHub',
    host: 'github.com',
    tokenPlaceholder: 'github_pat_…',
    tokenHelp: '需要一个 fine-grained token，只勾选这一个仓库的 Contents: Read and write。',
    create: (options) => createGitHub(options),
  },
  gitee: {
    id: 'gitee',
    label: 'Gitee 码云',
    host: 'gitee.com',
    tokenPlaceholder: '私人令牌',
    tokenHelp: '设置 → 私人令牌 → 生成新令牌，勾选 projects（仓库读写）即可，只勾这一个仓库。',
    create: (options) => createGitee({ ...options, apiRoot: GITEE_API_ROOT }),
  },
  gitcode: {
    id: 'gitcode',
    label: 'GitCode',
    host: 'gitcode.com',
    tokenPlaceholder: '访问令牌',
    tokenHelp: '个人设置 → 访问令牌，勾选仓库读写权限即可，只勾这一个仓库。',
    create: (options) => createGitee({ ...options, apiRoot: GITCODE_API_ROOT }),
  },
};

export function providerInfo(id) {
  return PROVIDERS[id] ?? PROVIDERS[DEFAULT_PROVIDER];
}

export function createRemote({ provider, ...options } = {}) {
  return providerInfo(provider).create(options);
}

export { GiteeError };
