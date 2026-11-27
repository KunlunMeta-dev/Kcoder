#!/usr/bin/env node
import { configureFixtureGit, runGh } from './forge.mjs';
try {
  const args = process.argv.slice(2);
  if (args[0] === '--fixture-git') {
    configureFixtureGit({ path: args[1], sha256: args[2] }); args.splice(0, 3);
  }
  const result = runGh(process.cwd(), args); process.stdout.write(`${typeof result === 'string' ? result : JSON.stringify(result)}\n`);
}
catch (error) { process.stderr.write(`owned forge fixture rejected request: ${error.message}\n`); process.exitCode = 2; }
