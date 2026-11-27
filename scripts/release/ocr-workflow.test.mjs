import assert from 'node:assert/strict';
import { readFile,mkdtemp,writeFile,mkdir,rm } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync,spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const workflow = await readFile(new URL('../../.github/workflows/ocr-review.yml', import.meta.url), 'utf8');
const block = workflow.split('          script: |\n')[1];
assert.ok(block, 'OCR review workflow must include a GitHub script');
const script = block.split('\n').map(line => line.startsWith('            ') ? line.slice(12) : line).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runScript = new AsyncFunction('require', 'context', 'core', 'github', script);
const runBlock=workflow.split('      - name: Run OpenCodeReview\n')[1].split('      - name: Post review result')[0]
  .split('        run: |\n')[1].split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');

async function gitFixture(t,{format='sha1'}={}){
  const root=await mkdtemp(join(tmpdir(),'owned-ocr-range-')),repo=join(root,'repo'),bin=join(root,'bin');
  await mkdir(repo);await mkdir(bin);await mkdir(join(root,'template'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TEMPLATE_DIR:join(root,'template'),
    GIT_AUTHOR_NAME:'OCR Fixture',GIT_AUTHOR_EMAIL:'ocr-fixture@example.invalid',GIT_COMMITTER_NAME:'OCR Fixture',GIT_COMMITTER_EMAIL:'ocr-fixture@example.invalid'};
  const git=(...args)=>execFileSync('git',args,{cwd:repo,env,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
  git('init','-b','main','--object-format='+format);
  const commit=async path=>{await writeFile(join(repo,path),path+'\n');git('add','--',path);git('commit','-qm','fixture');return git('rev-parse','HEAD');};
  const base=await commit('root.js');git('update-ref','refs/remotes/origin/main',base);
  await writeFile(join(bin,'ocr'),'#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.OWNED_OCR_CALLS,JSON.stringify(process.argv.slice(2)));process.stdout.write(JSON.stringify({status:"success",comments:[]}));\n',{mode:0o700});
  async function run({before='',after=git('rev-parse','HEAD'),event='push',source='feature',defaultBranch='main'}={}){
    const output=join(root,'output'),calls=join(root,'calls');await writeFile(output,'');await rm(calls,{force:true});
    const ownedBlock=runBlock.replaceAll('/tmp/ocr-',join(root,'ocr-'));
    const stdout=execFileSync('bash',['-e','-o','pipefail','-c',ownedBlock],{cwd:repo,env:{...env,PATH:bin+':'+process.env.PATH,
      BEFORE_SHA:before,AFTER_SHA:after,GITHUB_EVENT_NAME:event,SOURCE_BRANCH:source,DEFAULT_BRANCH:defaultBranch,GITHUB_OUTPUT:output,OWNED_OCR_CALLS:calls},encoding:'utf8'});
    const outputs=Object.fromEntries((await readFile(output,'utf8')).trim().split('\n').filter(Boolean).map(line=>line.split('=')));
    let args=null;try{args=JSON.parse(await readFile(calls,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    return {outputs,args,stdout};
  }
  const files=outcome=>{
    if(outcome.args.includes('--commit'))return git('show','--pretty=format:','--name-only',outcome.args[outcome.args.indexOf('--commit')+1]).split('\n').filter(Boolean);
    const from=outcome.args[outcome.args.indexOf('--from')+1],to=outcome.args[outcome.args.indexOf('--to')+1];
    return git('diff','--name-only',git('merge-base',from,to),to).split('\n').filter(Boolean);
  };
  return {git,commit,base,run,files};
}

test('a newly pushed branch reviews every introduced commit instead of HEAD alone',async t=>{
  const f=await gitFixture(t);f.git('checkout','-qb','feature');await f.commit('earlier.js');await f.commit('latest.js');
  const result=await f.run({before:'0'.repeat(40)});
  assert.equal(result.outputs.mode,'range');assert.deepEqual(f.files(result),['earlier.js','latest.js']);
});

test('ordinary pushes keep their original before boundary and dispatch remains one explicit commit',async t=>{
  const f=await gitFixture(t);const before=await f.commit('earlier.js');await f.commit('latest.js');
  assert.deepEqual(f.files(await f.run({before})),['latest.js']);
  const manual=await f.run({event:'workflow_dispatch'});assert.equal(manual.outputs.mode,'single');assert.deepEqual(f.files(manual),['latest.js']);
});

test('force pushes use a verified shared base even if the old head is missing or divergent',async t=>{
  const f=await gitFixture(t);f.git('checkout','-qb','old');const before=await f.commit('old-only.js');f.git('checkout','-qb','feature',f.base);
  await f.commit('earlier.js');await f.commit('latest.js');
  for(const value of [before,'f'.repeat(40)]){
    const result=await f.run({before:value});assert.equal(result.outputs.mode,'range');assert.deepEqual(f.files(result),['earlier.js','latest.js']);
  }
});

test('root commits and SHA-256 all-zero boundaries retain complete initial coverage',async t=>{
  const root=await gitFixture(t);const result=await root.run({before:'0'.repeat(40),source:'main'});
  assert.deepEqual(root.files(result),['root.js']);
  const f=await gitFixture(t,{format:'sha256'});f.git('checkout','-qb','feature');await f.commit('earlier.js');await f.commit('latest.js');
  assert.deepEqual(f.files(await f.run({before:'0'.repeat(64)})),['earlier.js','latest.js']);
});

test('deletion skips OCR and an initial history without a proven base fails closed',async t=>{
  const f=await gitFixture(t);const deleted=await f.run({before:f.base,after:'0'.repeat(40)});
  assert.equal(deleted.args,null);assert.equal(deleted.outputs.skipped,'true');
  const head=await f.commit('initial-history.js');f.git('update-ref','refs/remotes/origin/main',head);
  const unavailable=await f.run({before:'0'.repeat(40),source:'main'});
  assert.equal(unavailable.args,null);assert.notEqual(unavailable.outputs.ocr_rc,'0');assert.equal(unavailable.outputs.mode,'unavailable');
});

test('a history rewind cannot report an empty range as a complete review',async t=>{
  const f=await gitFixture(t);const after=await f.commit('earlier.js');const before=await f.commit('later.js');
  const result=await f.run({before,after});
  assert.equal(result.args,null);assert.equal(result.outputs.mode,'unavailable');assert.equal(result.outputs.ocr_rc,'1');
});

test('a new branch identical to the existing default branch skips model work',async t=>{
  const f=await gitFixture(t);const head=await f.commit('earlier.js');f.git('update-ref','refs/remotes/origin/main',head);
  const result=await f.run({before:'0'.repeat(40),source:'feature'});
  assert.equal(result.args,null);assert.equal(result.outputs.skipped,'true');
});

test('the frozen release commit is the peeled commit of an annotated tag',async t=>{
  const f=await gitFixture(t);f.git('tag','-a','v1.2.3','-m','owned tag');
  assert.notEqual(f.git('rev-parse','refs/tags/v1.2.3'),f.base);
  assert.equal(f.git('rev-parse','HEAD^{commit}'),f.git('rev-parse','refs/tags/v1.2.3^{commit}'));
});

async function runReview({ rc = '0', result, secret = 'fixture-secret-for-redaction' }) {
  const original = { ...process.env };
  Object.assign(process.env, { OCR_RC: rc, REVIEW_MODE: 'single', OCR_LLM_AUTH_TOKEN: secret,
    OCR_LLM_URL: 'https://fixture.invalid/v1' });
  let summary = '', comment = '', failure;
  const core = { summary: { addRaw(value) { summary = value; return this; }, async write() {} },
    info() {}, warning() {}, setFailed(value) { failure = value; } };
  const github = { rest: { repos: { async createCommitComment(value) { comment = value.body; } } } };
  const context = { sha: 'a'.repeat(40), serverUrl: 'https://github.example',
    repo: { owner: 'fixture', repo: 'test' }, runId: 1 };
  try {
    await runScript(name => {
      assert.equal(name, 'fs');
      return { readFileSync: () => typeof result === 'string' ? result : JSON.stringify(result) };
    }, context, core, github);
  } finally {
    for (const name of ['OCR_RC', 'REVIEW_MODE', 'OCR_LLM_AUTH_TOKEN', 'OCR_LLM_URL']) {
      if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name];
    }
  }
  return { summary, comment, failure };
}

test('OCR failures, invalid output and incomplete runs fail the workflow', async () => {
  for (const input of [
    { rc: '1', result: {} }, { rc: '', result: {} }, { rc: '0', result: 'not JSON' },
    { rc: '0', result: { status: 'partial', comments: [] } },
    { rc: '0', result: { status: 'completed_with_warnings', comments: [], warnings: ['timeout'] } },
  ]) {
    const outcome = await runReview(input);
    assert.ok(outcome.failure);
    assert.ok(outcome.comment);
    assert.doesNotMatch(outcome.comment, /LGTM/);
  }
});

test('OCR comments and summary redact configured provider credentials before formatting', async () => {
  const secret = 'fixture<&|secret>token';
  const outcome = await runReview({ secret, result: { status: 'success', comments: [{
    path: `file-${secret}.js`, severity: 'high', content: `provider returned ${secret}`,
    suggestion_code: `value = "${secret}"`,
  }] } });
  assert.equal(outcome.failure, undefined);
  for (const text of [outcome.comment, outcome.summary]) {
    assert.ok(text.includes('REDACTED'));
    assert.ok(!text.includes(secret));
  }
});

test('untrusted findings cannot close report markup or break code blocks', async () => {
  const outcome = await runReview({ result: { status: 'success', comments: [{
    path: 'bad`</details>|file', severity: 'high', content: '</details>\nforged content',
    suggestion_code: '```\n</details>',
  }] } });
  assert.equal(outcome.failure, undefined);
  assert.ok(outcome.comment.includes('&lt;/details&gt;'));
  assert.equal((outcome.comment.match(/<\/details>/g) ?? []).length, 2,
    'only the indented code sample and the report may contain literal closing markup');
  assert.match(outcome.comment, /    ```\n    <\/details>/);
});

test('long reports retain complete markup and Unicode', async () => {
  const outcome = await runReview({ result: { status: 'success', comments: Array.from({ length: 200 }, (_, index) => ({
    path: `path-${index}`, severity: 'medium', content: '😀'.repeat(500), suggestion_code: 'x'.repeat(200),
  })) } });
  assert.ok(outcome.comment.length <= 64000);
  assert.ok(!outcome.comment.includes('<details>'));
  assert.equal(outcome.comment.toWellFormed(), outcome.comment);
});

test('unknown or malformed OCR result shapes cannot become LGTM',async()=>{
  for(const result of [{},null,[],{status:'unknown',comments:[]},{status:'success',comments:'not-an-array'},
    {status:'success',comments:[null]},{status:'success',comments:[],warnings:{}}]){
    const outcome=await runReview({result});assert.ok(outcome.failure);assert.ok(outcome.comment);assert.doesNotMatch(outcome.comment,/LGTM/);
  }
});

test('the pinned CLI skipped status reports no supported files without claiming a review',async()=>{
  const outcome=await runReview({result:{status:'skipped',comments:[],message:'No supported files changed.'}});
  assert.equal(outcome.failure,undefined);assert.doesNotMatch(outcome.comment,/LGTM|✅/);assert.match(outcome.comment,/未执行/);
});

test('untrusted report fields do not create mentions or labelled links',async()=>{
  const outcome=await runReview({result:{status:'success',comments:[{
    path:'@maintainer.js',severity:'high',content:'@all [trusted](https://unapproved.invalid)\r</details>',
  }]}});
  assert.doesNotMatch(outcome.comment,/@all|@maintainer|\[trusted\]\(/);
});

test('common encoded credential forms never enter comments or summaries',async()=>{
  const secret='fixture<&|secret>token',encoded=encodeURIComponent(secret),base64=Buffer.from(secret).toString('base64');
  const outcome=await runReview({secret,result:{status:'success',comments:[{
    path:'fixture.js',severity:'high',content:encoded+' '+base64,
  }]}});
  for(const output of [outcome.comment,outcome.summary]){assert.ok(!output.includes(encoded));assert.ok(!output.includes(base64));}
});

const ci=await readFile(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8');
const release=await readFile(new URL('../../.github/workflows/release.yml',import.meta.url),'utf8');
function nodeStep(source,name){
  const text=source.split('      - name: '+name+'\n')[1];assert.ok(text,'missing workflow step '+name);
  return text.split("node --input-type=module <<'EOF'\n")[1].split('\n          EOF')[0].split('\n').map(line=>line.slice(10)).join('\n');
}

test('protected desktop preflight validates only the selected real-host prerequisites',async t=>{
  const root=await mkdtemp(join(tmpdir(),'owned-ci-preflight-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const script=nodeStep(ci,'Require an explicitly configured owned runner');
  for(const target of ['linux-desktop','macos-desktop','windows-desktop']){
    const env={...process.env,TARGET:target,RUNNERS:JSON.stringify({[target]:['self-hosted','owned-fixture']}),GITHUB_OUTPUT:join(root,'output'),
      KCODER_E2E_KCODER_BIN:'',KCODER_E2E_ELECTRON_BIN:'',KCODER_E2E_PACKAGED_DIR:''};
    assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',script],{env,stdio:'pipe'}));
    env[target==='windows-desktop'?'KCODER_E2E_PACKAGED_DIR':'KCODER_E2E_ELECTRON_BIN']='owned-fixture-path';
    execFileSync(process.execPath,['--input-type=module','-e',script],{env,stdio:'pipe'});
  }
});

test('release upload verifies the final installer bytes rather than only an unpacked tree',async t=>{
  const root=await mkdtemp(join(tmpdir(),'owned-release-integrity-'));await mkdir(join(root,'artifacts'));t.after(()=>rm(root,{recursive:true,force:true}));
  const filename='KCoder-Studio-Setup-1.2.3-win-x64.exe',bytes=Buffer.from('inert signed-artifact fixture');
  const path=join(root,'artifacts',filename);await writeFile(path,bytes);
  const script=nodeStep(release,'Verify downloaded installer identity before publishing');
  const env={...process.env,EXPECTED_INSTALLER:filename,EXPECTED_SHA256:createHash('sha256').update(bytes).digest('hex')};
  execFileSync(process.execPath,['--input-type=module','-e',script],{cwd:root,env,stdio:'pipe'});
  await writeFile(path,Buffer.from('tampered fixture'));
  assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',script],{cwd:root,env,stdio:'pipe'}));
  assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',script],{cwd:root,env:{...env,EXPECTED_INSTALLER:'../foreign.exe'},stdio:'pipe'}));
});

test('root-workspace CI cargo resolutions stay locked without inventing a vendored library lockfile',()=>{
  for(const line of ci.split('\n')){
    if(!/\bcargo (build|test|check|clippy|doc|run)\b/.test(line)||line.includes('--manifest-path third_party/genai/Cargo.toml'))continue;
    assert.match(line,/--locked/,line);
  }
  assert.match(release,/corepack prepare pnpm@11\.24\.0 --activate/);
});

test('the BSD BEGIN-only awk version gate exits without waiting for stdin EOF', {timeout:2000},async t=>{
  const program=ci.split('awk -F. -v version="$rust_version" \'')[1].split("'")[0];
  const child=spawn('awk',['-F.','-v','version=1.95.0',program],{stdio:['pipe','ignore','pipe']});
  t.after(()=>{child.stdin.destroy();if(child.exitCode===null)child.kill();});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  assert.equal(code,0);
});
