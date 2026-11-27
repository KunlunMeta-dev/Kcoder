import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, symlink, stat } from 'node:fs/promises';
import { RunContext } from './run-context.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';
import { retainWebReplayWorkspace } from './web-search-history-evidence.mjs';

test('retained replay evidence copies only owned regular fixture data and refuses overwrite', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'retained-web-replay-workspace-boundaries', tier: 'harness-unit', modelPolicy: 'No model/network; fixture data export only' });
  let failure;
  try {
    const fixture = await materializeWorkspace(context, 'minimal', { instanceId: 'retained-web-source' });
    const exported = await retainWebReplayWorkspace(context, fixture);
    assert.deepEqual(await readFile(`${exported}/README.md`), await readFile(`${fixture.path}/README.md`));
    await assert.rejects(retainWebReplayWorkspace(context, fixture), /EEXIST/);
    await symlink(`${fixture.path}/README.md`, `${fixture.path}/refused-link`);
    // A separate target cannot turn a symbolic source into replay evidence.
    await assert.rejects(retainWebReplayWorkspace({ ...context, pathInArtifacts: (...parts) => context.pathInArtifacts('rejected', ...parts), writeArtifactJson: (...args) => context.writeArtifactJson(...args) }, fixture), /symlink/);
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', { retainedFixtureDataOnly: true }, failure); assert.equal(await stat(context.stateDir).then(() => true, () => false), false); }
});

test('registered secrets never become retained replay files', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'retained-web-replay-secret-rejection', tier: 'harness-unit', modelPolicy: 'No model/network; synthetic secret rejection only' });
  let failure;
  try {
    const fixture = await materializeWorkspace(context, 'minimal', { instanceId: 'retained-web-secret' });
    const secret = 'owned-synthetic-private-value'; context.registerSecret(secret);
    await writeFile(`${fixture.path}/README.md`, secret);
    await assert.rejects(retainWebReplayWorkspace(context, fixture), /registered secret/);
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', { rejectedSyntheticSecret: true }, failure); }
});
