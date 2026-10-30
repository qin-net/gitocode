#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createGit } from './git.js';
import { runClaude } from './claude.js';
import { loadState, saveState } from './state.js';

const MAX_CONSECUTIVE_FAILURES = 3;

const { values: cli } = parseArgs({
  options: {
    config: { type: 'string', short: 'c', default: 'config.json' },
    once: { type: 'boolean', default: false },
  },
});

const configPath = resolve(cli.config);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const stateFile = resolve(dirname(configPath), config.stateFile ?? './state.json');
const git = createGit(config.repoPath);
const { remote = 'origin', branch = 'main', promptFiles, bot } = config;
const watchAuthors = (config.watchAuthors ?? []).map((a) => a.toLowerCase());

let state = loadState(stateFile);
let stopping = false;
let busy = false;

const log = (...args) => console.log(new Date().toISOString(), ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isWatched(commit) {
  if (commit.email.toLowerCase() === bot.email.toLowerCase()) return false;
  if (watchAuthors.length === 0) return true;
  return watchAuthors.includes(commit.email.toLowerCase())
    || watchAuthors.includes(commit.name.toLowerCase());
}

function setState(patch) {
  state = { ...state, ...patch };
  saveState(stateFile, state);
}

// Wait until the remote stops moving for debounceSec, so a burst of pushes becomes one task.
async function waitForQuiet(remoteRef, sha) {
  const debounceMs = (config.debounceSec ?? 0) * 1000;
  while (debounceMs > 0 && !stopping) {
    await sleep(debounceMs);
    await git.fetch(remote, branch);
    const latest = await git.revParse(remoteRef);
    if (latest === sha) break;
    log(`remote moved again (${latest.slice(0, 7)}), extending debounce`);
    sha = latest;
  }
  return sha;
}

async function buildPrompt(commits) {
  const sections = [];
  for (const c of commits) {
    const patch = await git.show(c.sha, promptFiles);
    sections.push(`### ${c.sha.slice(0, 7)} by ${c.name} <${c.email}>: ${c.subject}\n\`\`\`diff\n${patch}\n\`\`\``);
  }
  return [
    `The collaborator updated the prompt file(s): ${promptFiles.join(', ')}.`,
    'Below are the new commits and the changes they made. The full current file is in the repo if you need context.',
    'Carry out the new or changed instructions.',
    '',
    ...sections,
  ].join('\n');
}

function commitMessage(result, commits, sessionId) {
  const lines = result.trim().split('\n');
  const subject = (lines[0] || 'Apply collaborator prompt update').slice(0, 72);
  const body = lines.slice(1).join('\n').trim();
  return [
    subject,
    '',
    body,
    body ? '' : null,
    'Prompt commits:',
    ...commits.map((c) => `- ${c.sha.slice(0, 7)} ${c.subject}`),
    '',
    `Claude-Session: ${sessionId}`,
  ].filter((l) => l !== null).join('\n');
}

async function pushWithRetry() {
  try {
    await git.push(remote, branch);
  } catch {
    log('push rejected, rebasing onto remote and retrying');
    await git.pullRebase(remote, branch);
    await git.push(remote, branch);
  }
}

async function cycle() {
  const remoteRef = `${remote}/${branch}`;
  try {
    await git.fetch(remote, branch);
  } catch (err) {
    log(`fetch failed, will retry: ${err.message.split('\n')[0]}`);
    return;
  }
  let remoteSha = await git.revParse(remoteRef);

  if (!state.lastProcessedSha) {
    // First run: start watching from the current tip instead of replaying history.
    await git.pullRebase(remote, branch);
    setState({ lastProcessedSha: remoteSha });
    log(`initialized at ${remoteSha.slice(0, 7)}, watching ${promptFiles.join(', ')}`);
    return;
  }
  if (remoteSha === state.lastProcessedSha) return;

  let commits = (await git.commitsTouching(state.lastProcessedSha, remoteSha, promptFiles)).filter(isWatched);
  if (commits.length === 0) {
    await git.pullRebase(remote, branch);
    setState({ lastProcessedSha: remoteSha });
    return;
  }

  log(`detected ${commits.length} prompt commit(s), debouncing`);
  remoteSha = await waitForQuiet(remoteRef, remoteSha);
  if (stopping) return;
  commits = (await git.commitsTouching(state.lastProcessedSha, remoteSha, promptFiles)).filter(isWatched);

  if (!(await git.isClean())) {
    throw new Error(`working tree of ${config.repoPath} is dirty; clean it up before the watcher can continue`);
  }
  await git.pullRebase(remote, branch);

  const prompt = await buildPrompt(commits);
  log(`running claude (${state.sessionId ? `resume ${state.sessionId}` : 'new session'})`);
  const res = await runClaude({ cwd: config.repoPath, prompt, sessionId: state.sessionId, options: config.claude ?? {} });
  setState({ sessionId: res.sessionId });

  if (res.isError) {
    if (!(await git.isClean())) {
      throw new Error(`claude failed and left changes in the working tree:\n${res.result}`);
    }
    const failures = (state.failures ?? 0) + 1;
    setState({ failures });
    log(`claude failed (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${res.result}`);
    if (failures >= MAX_CONSECUTIVE_FAILURES) throw new Error('too many consecutive claude failures');
    return; // lastProcessedSha unchanged -> retried next cycle
  }

  const committed = await git.commitAll(commitMessage(res.result, commits, res.sessionId), bot);
  if (committed) {
    await pushWithRetry();
    log(`committed and pushed: ${res.result.split('\n')[0]}`);
  } else {
    log('claude made no file changes, nothing to commit');
  }
  // Mark the collaborator's tip as processed (not our HEAD), so anything pulled in during
  // a push retry is still examined next cycle. Our own bot commit is filtered by isWatched.
  setState({ lastProcessedSha: remoteSha, failures: 0, runs: (state.runs ?? 0) + 1 });
  if (res.costUsd != null) log(`cost: $${res.costUsd.toFixed(4)}`);
}

async function main() {
  process.on('SIGINT', () => {
    if (stopping || !busy) process.exit(130);
    stopping = true;
    log('stopping after the current task (Ctrl-C again to force)');
  });

  log(`watching ${config.repoPath} ${remote}/${branch}`);
  do {
    busy = true;
    try {
      await cycle();
    } catch (err) {
      log(`fatal: ${err.message}`);
      process.exitCode = 1;
      return;
    } finally {
      busy = false;
    }
    if (cli.once || stopping) return;
    await sleep((config.pollIntervalSec ?? 60) * 1000);
  } while (!stopping);
}

main();
