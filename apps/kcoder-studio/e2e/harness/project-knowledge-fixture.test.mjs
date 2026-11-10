import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { MARKERS, SOURCE, V1, V2, boundedToolObservation, projectKnowledgeFixture, projectKnowledgeSettings, sha256 } from './project-knowledge-fixture.mjs';
import { modelIndependentSuites } from '../suite-registry.mjs';
import { suiteEnvironmentNames } from './runner-options.mjs';

const tools = ['SpecInit', 'SpecConfig', 'SpecStatus', 'SpecNewChange', 'read', 'write', 'SpecCheck', 'SpecReview', 'SpecRecordVerification', 'SpecArchive'];
const call = (fixture, marker, results = [], extra = []) => fixture.responseSteps({ body: {
  messages: [{ role: 'user', content: marker + '\nUse ' + SOURCE }, ...results, ...extra],
  tools: tools.map(name => ({ type: 'function', function: { name } })),
} });
const asResult = (step, content) => ({ role: 'tool', tool_call_id: step.delta.tool_calls[0].id, content });

test('fixture never invents current source provenance and requires the registered Native tool', () => {
  const fixture = projectKnowledgeFixture('owned precheck');
  assert.equal(call(fixture, MARKERS[0])[0].delta.tool_calls[0].function.name, 'SpecInit');
  const next = projectKnowledgeFixture('owned precheck');
  const failed = next.responseSteps({ body: { messages: [{ role: 'user', content: MARKERS[0] }], tools: [] } });
  assert.equal(failed[0].delta.content, 'KNOWLEDGE_FIXTURE_ASSERTION_FAILED');
  assert.match(next.evidence.failures[0], /registered tool/);
  assert.equal(next.evidence.calls.length, 0);
});

test('candidate guard comes from the actual source result and Runtime-role messages cannot replace the task', () => {
  const fixture = projectKnowledgeFixture('owned precheck'); const results = [];
  for (const output of ['Initialized spec subsystem', 'configured schema', 'configured precheck', '{"version":"one"}', 'The file interface.json has been updated successfully.']) {
    const step = call(fixture, MARKERS[0], results, [{ role: 'user', content: 'Current task project knowledge quoted data' }])[0];
    results.push(asResult(step, output));
  }
  const read = call(fixture, MARKERS[0], results)[0];
  assert.deepEqual(JSON.parse(read.delta.tool_calls[0].function.arguments), { knowledge: { paths: [SOURCE] } });
  results.push(asResult(read, JSON.stringify({ knowledge: { scope: 'native-scope-1',
    sources: [{ path: SOURCE, kind: 'authoritative_spec', revision: sha256(V1), content: V1 }] } })));
  const proposal = call(fixture, MARKERS[0], results)[0];
  assert.deepEqual(JSON.parse(proposal.delta.tool_calls[0].function.arguments), { knowledge: { paths: [SOURCE], scope: 'native-scope-1',
    updates: [{ path: SOURCE, expected_revision: sha256(V1), replacement: V2 }] } });
  assert.deepEqual(fixture.evidence.failures, []);
});

test('every existing file is read before write, and an unprefixed Native write refusal is retained and stops the fixture', () => {
  const fixture = projectKnowledgeFixture('owned precheck'), results = [];
  for (const output of ['Initialized spec subsystem', 'configured schema', 'configured precheck']) {
    const step = call(fixture, MARKERS[0], results)[0]; results.push(asResult(step, output));
  }
  const read = call(fixture, MARKERS[0], results)[0];
  assert.equal(read.delta.tool_calls[0].function.name, 'read');
  results.push(asResult(read, '{"version":"one"}'));
  const write = call(fixture, MARKERS[0], results)[0];
  assert.equal(write.delta.tool_calls[0].function.name, 'write');
  const refusal = 'File has not been read this session. Read it before attempting to write: interface.json';
  const failed = call(fixture, MARKERS[0], [...results, asResult(write, refusal)])[0];
  assert.equal(failed.delta.content, 'KNOWLEDGE_FIXTURE_ASSERTION_FAILED');
  assert.equal(fixture.evidence.toolResults.at(-1).text, refusal);
  assert.equal(fixture.evidence.toolResults.at(-1).isError, 'notPresent');
  assert.equal(fixture.evidence.toolResults.at(-1).id, write.delta.tool_calls[0].id);
  assert.equal(fixture.evidence.calls.length, 5);
});

test('Native error observations preserve identity, typed status and full-content hash within an 8KiB text budget', () => {
  const text = 'x'.repeat(12000);
  const result = boundedToolObservation({ id: 'knowledge-5', name: 'write', text, isError: true, errorSource: 'Native item/completed status' });
  assert.equal(result.isError, true); assert.equal(result.id, 'knowledge-5');
  assert.equal(result.bytes, 12000); assert.equal(result.sha256, sha256(text));
  assert.equal(Buffer.byteLength(result.text), 8192); assert.equal(result.truncated, true);
});

test('next task provider assertion requires actual new content, SHA and scope without the old contract', () => {
  for (const damage of [null, 'scope', 'revision', 'content', 'old-transcript', 'missing']) {
    const fixture = projectKnowledgeFixture('owned precheck', { readPublished: () => V2 });
    fixture.evidence.oldRead = { scope: 'old-scope' };
    const knowledge = { scope: damage === 'scope' ? 'old-scope' : 'new-scope', sources: [{ path: SOURCE,
      kind: 'authoritative_spec', content: damage === 'content' ? V1 : V2, revision: damage === 'revision' ? sha256(V1) : sha256(V2) }] };
    const data = [{ role: 'user', content: 'Current task project knowledge (quoted):\n' + JSON.stringify({ knowledge }) }];
    if (damage === 'old-transcript') data.push({ role: 'assistant', content: 'version one' });
    const response = call(fixture, MARKERS[5], [], damage === 'missing' ? [] : data);
    if (damage === null) {
      assert.equal(response[0].delta.content, MARKERS[5] + '_COMPLETE');
      assert.equal(fixture.evidence.nextTask.source.revision, sha256(V2));
      assert.equal(fixture.evidence.calls.length, 0);
    } else {
      assert.equal(response[0].delta.content, 'KNOWLEDGE_FIXTURE_ASSERTION_FAILED');
      assert.equal(fixture.evidence.failures.length, 1);
    }
  }
});

test('denied archive and stale proof require Native rejection, not fixture success text', () => {
  for (const [marker, output, accepted] of [[MARKERS[1], 'Tool denied by user', true], [MARKERS[1], 'Archived change', false],
    [MARKERS[3], 'project_knowledge_stale_revision', true], [MARKERS[3], 'fresh candidate', false]]) {
    const fixture = projectKnowledgeFixture('owned precheck'); fixture.evidence.oldRead = { scope: 'old-scope' };
    const first = call(fixture, marker)[0];
    call(fixture, marker, [asResult(first, output)]);
    assert.equal(fixture.evidence.failures.length, accepted ? 0 : 1);
  }
});

test('old-change archive accepts only its exact sync refusal after an explicit stale source result', () => {
  const exact = "Tool `SpecArchive` execution failed: failed to archive change: failed to sync change 'retained-old-interface' before archiving.";
  for (const [output, expectedFailure] of [[exact, false], [exact.replace('retained-old-interface', 'another-change'), true],
    ['Tool `SpecArchive` execution failed: arbitrary error', true], ['Archived change to retained-old-interface', true]]) {
    const fixture = projectKnowledgeFixture('owned precheck'); fixture.evidence.oldRead = { scope: 'old-scope' };
    const source = call(fixture, MARKERS[3])[0];
    const results = [asResult(source, 'Tool `SpecStatus` execution failed: project_knowledge_stale_revision')];
    const archive = call(fixture, MARKERS[3], results)[0];
    assert.equal(archive.delta.tool_calls[0].function.name, 'SpecArchive');
    const final = call(fixture, MARKERS[3], [...results, asResult(archive, output)])[0];
    assert.equal(fixture.evidence.failures.length, expectedFailure ? 1 : 0);
    assert.equal(final.delta.content, expectedFailure ? 'KNOWLEDGE_FIXTURE_ASSERTION_FAILED' : MARKERS[3] + '_COMPLETE');
  }
});

test('formal suite is model-independent and its fixed artifact inputs survive runner filtering', () => {
  const suite = 'suites/gateway/project-knowledge-publication.e2e.mjs';
  assert.ok(modelIndependentSuites.includes(suite));
  const names = suiteEnvironmentNames(suite);
  for (const key of ['KCODER_E2E_STATE_NATIVE_SHA256', 'KCODER_E2E_PACKAGED_MANIFEST_SHA256', 'KCODER_E2E_PROCESS_SUPERVISOR_BIN', 'KCODER_E2E_GIT_SH_SHA256']) assert.ok(names.includes(key));
});

test('fixture permissions never allow or bypass archive approval and only permit exact candidate writes', () => {
  const settings = projectKnowledgeSettings('http://127.0.0.1:12345/v1');
  assert.equal(settings.permission_mode, 'ask');
  assert.ok(settings.permission_rules.every(rule => rule.action === 'allow'));
  assert.equal(settings.permission_rules.some(rule => rule.tool === 'SpecArchive'), false);
  assert.ok(settings.permission_rules.filter(rule => rule.tool === 'write').every(rule =>
    rule.input_pattern === 'file_path=interface.json' || /^file_path=\.kcoder\/specs\/changes\/(confirmed-interface-update|retained-old-interface)\/(specs\/core\/spec\.md|tasks\.md|plan\.md|review\.md)$/.test(rule.input_pattern)));
  assert.equal(settings.providers['knowledge-fixture'].authentication.mode, 'none');
  assert.equal(settings.providers['knowledge-fixture'].api_format, 'openai_chat_completions');
  assert.equal(settings.max_tokens, 8192);
});

async function gitIsolationFixture(t, kind) {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-git-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const malicious = join(root, 'ambient-template'), hooks = join(root, 'ambient-hooks'), empty = join(root, 'empty-template');
  for (const path of [malicious, hooks, empty, join(malicious, 'hooks')]) await mkdir(path, { recursive: true });
  // These inert failing hooks belong only to this test. There is no external command to run.
  await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 91\n', { mode: 0o700 });
  await writeFile(join(malicious, 'hooks/pre-commit'), '#!/bin/sh\nexit 92\n', { mode: 0o700 });
  await writeFile(join(malicious, 'ambient-template-marker'), 'must never enter the owned repository\n');
  const global = join(root, 'ambient.gitconfig');
  const text = `[core]\n\thooksPath = ${JSON.stringify(hooks.replaceAll('\\', '/'))}\n[init]\n\ttemplateDir = ${JSON.stringify(malicious.replaceAll('\\', '/'))}\n`;
  await writeFile(global, text);
  const module = new URL('./workspace-fixture.mjs', import.meta.url).href;
  const code = `
    import assert from 'node:assert/strict';
    import { execFile } from 'node:child_process';
    import { access } from 'node:fs/promises';
    import { join } from 'node:path';
    import { promisify } from 'node:util';
    import { materializeWorkspace } from ${JSON.stringify(module)};
    const run=promisify(execFile), root=process.argv[1], empty=process.argv[2];
    const key=${JSON.stringify(kind === 'hook' ? 'core.hooksPath' : 'init.templateDir')};
    const ambient=(await run('git',['config','--get',key],{encoding:'utf8'})).stdout.trim();
    assert.ok(ambient.startsWith(root),'the adversarial config must belong only to this temporary test');
    const isolation={GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_COUNT:'0',GIT_TEMPLATE_DIR:empty};
    Object.assign(process.env,isolation);
    const context={pathInState:(...parts)=>join(root,'state',...parts),registerTemporaryDirectory(){},registerWorkspaceFixture(){}};
    const value=await materializeWorkspace(context,'git-history',{instanceId:'isolated'});
    const effective=await run('git',['-C',value.path,'config','--get','core.hooksPath'],{encoding:'utf8'}).catch(error=>error);
    assert.equal(effective.code,1,'the hostile hooksPath must not remain active');
    assert.equal(await access(join(value.path,'.git/ambient-template-marker')).then(()=>true,()=>false),false);
    assert.equal(await access(join(value.path,'.git/hooks/pre-commit')).then(()=>true,()=>false),false);
    console.log(JSON.stringify({ambientObserved:true,gitHead:value.gitHead,commitsSucceededWithoutHook:true,templateAbsent:true,isolation}));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, root, empty], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, HOME: root, USERPROFILE: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: global,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks,
      GIT_TEMPLATE_DIR: malicious },
  });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.ambientObserved, true); assert.equal(result.commitsSucceededWithoutHook, true);
  assert.equal(result.templateAbsent, true); assert.match(result.gitHead, /^[a-f0-9]{40}$/);
  assert.equal(await readFile(global, 'utf8'), text, 'the test must preserve its ambient config instead of editing it');
}

test('owned Git materialization ignores an ambient global/config-count hooksPath without invoking its hook', async t => {
  await gitIsolationFixture(t, 'hook');
});

test('owned Git materialization uses its empty template instead of ambient global/template files', async t => {
  await gitIsolationFixture(t, 'template');
});
