import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const SYSTEM_PROMPT = `You are running unattended inside a git repository, driven by an automation tool.
A collaborator writes tasks into prompt file(s) in this repo; each run you receive what changed.
Rules:
- Carry out the new/changed instructions by editing files in the repository.
- Do NOT edit the prompt file(s) themselves.
- Do NOT run git commit / push / reset; the automation commits your changes afterwards.
- Finish with a short summary (first line <= 72 chars, usable as a commit subject).`;

// Runs one turn of the repo's Claude session. Returns { sessionId, result, isError, costUsd }.
export function runClaude({ cwd, prompt, sessionId, options }) {
  const args = ['-p', '--output-format', 'json', '--append-system-prompt', SYSTEM_PROMPT];

  let newSessionId = sessionId;
  if (sessionId) {
    args.push('--resume', sessionId);
  } else {
    newSessionId = randomUUID();
    args.push('--session-id', newSessionId);
  }

  if (options.model) args.push('--model', options.model);
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode);
  if (options.allowedTools?.length) args.push('--allowedTools', ...options.allowedTools);
  if (options.disallowedTools?.length) args.push('--disallowedTools', ...options.disallowedTools);
  if (options.extraArgs?.length) args.push(...options.extraArgs);

  return new Promise((resolve, reject) => {
    // Prompt goes through stdin so large diffs don't hit argv limits.
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`claude timed out after ${options.timeoutMin} min`));
    }, (options.timeoutMin ?? 30) * 60_000);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(new Error(`claude exited ${code}, unparseable output:\n${stderr || stdout}`));
        return;
      }
      resolve({
        sessionId: parsed.session_id ?? newSessionId,
        result: parsed.result ?? '',
        isError: Boolean(parsed.is_error) || code !== 0,
        costUsd: parsed.total_cost_usd,
      });
    });

    child.stdin.end(prompt);
  });
}
