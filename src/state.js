import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

export function loadState(file) {
  if (!existsSync(file)) return { lastProcessedSha: null, sessionId: null, runs: 0 };
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Write-then-rename so a crash never leaves a half-written state file.
export function saveState(file, state) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}
