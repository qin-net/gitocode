import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function createGit(repoPath) {
  async function git(...args) {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoPath,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
  }

  return {
    raw: git,

    fetch: (remote, branch) => git('fetch', '--quiet', remote, branch),

    revParse: (ref) => git('rev-parse', ref),

    isClean: async () => (await git('status', '--porcelain')) === '',

    // Commits in (from, to] touching any of the given paths, oldest first.
    async commitsTouching(from, to, paths) {
      const out = await git(
        'log', '--reverse', '--format=%H%x1f%an%x1f%ae%x1f%s', `${from}..${to}`, '--', ...paths,
      );
      if (!out) return [];
      return out.split('\n').map((line) => {
        const [sha, name, email, subject] = line.split('\x1f');
        return { sha, name, email, subject };
      });
    },

    // Patch introduced by a single commit, limited to the given paths.
    show: (sha, paths) => git('show', '--format=', sha, '--', ...paths),

    pullRebase: (remote, branch) => git('pull', '--rebase', '--quiet', remote, branch),

    async commitAll(message, bot) {
      await git('add', '-A');
      if ((await git('diff', '--cached', '--name-only')) === '') return false;
      await git(
        '-c', `user.name=${bot.name}`,
        '-c', `user.email=${bot.email}`,
        'commit', '--quiet', '-m', message,
      );
      return true;
    },

    push: (remote, branch) => git('push', '--quiet', remote, `HEAD:${branch}`),
  };
}
