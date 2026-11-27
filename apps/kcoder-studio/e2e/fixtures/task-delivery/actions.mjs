#!/usr/bin/env node
import assert from 'node:assert/strict';
import { configureFixtureGit, git, publishIntent } from './forge.mjs';
try {
  const action = process.argv[2]; assert.ok(['publish', 'candidate', 'fix'].includes(action));
  const payload = process.argv[3]; assert.ok(payload && payload.length < 64 * 1024);
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (process.argv[4]) {
    assert.ok(process.argv[4].length < 64 * 1024);
    configureFixtureGit(JSON.parse(Buffer.from(process.argv[4], 'base64url').toString('utf8')));
  }
  if (action === 'publish') process.stdout.write(`${publishIntent(process.cwd(), data)}\nOWNED_LOCAL_PUBLICATION_COMPLETE\n`);
  else {
    if (action === 'candidate') assert.ok(['b', 'c'].includes(data.variant));
    git(process.cwd(), ['add', '--', 'alternative.txt']);
    git(process.cwd(), ['-c', 'commit.gpgsign=false', 'commit', '-m', action === 'fix'
      ? 'fix: selected owned CI failure' : `feat: owned alternative ${data.variant.toUpperCase()}`]);
    if (action === 'candidate') {
      process.stdout.write(`OWNED_CHECK_${data.variant.toUpperCase()}\n`);
      process.exitCode = data.variant === 'b' ? 7 : 0;
    }
  }
} catch (error) { process.stderr.write(`owned task-delivery fixture rejected action: ${error.message}\n`); process.exitCode = 2; }
