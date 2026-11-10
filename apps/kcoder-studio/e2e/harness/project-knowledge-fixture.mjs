import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const SOURCE = '.kcoder/specs/specs/core/spec.md';
export const PUBLISH_CHANGE = 'confirmed-interface-update';
export const STALE_CHANGE = 'retained-old-interface';
export const V1 = '# Spec: core\n\n## Purpose\n\nProject contract.\n\n## Requirements\n\n### Requirement: Stable interface\nThe interface MUST return version one.\n\n#### Scenario: Read interface\n- WHEN a task reads it\n- THEN it sees version one\n';
export const V2 = V1.replaceAll('version one', 'version two');
export const MARKERS = ['KNOWLEDGE_PREPARE', 'KNOWLEDGE_DENY', 'KNOWLEDGE_ACCEPT', 'KNOWLEDGE_STALE', 'KNOWLEDGE_OLD_SCOPE', 'KNOWLEDGE_NEXT_TASK'];
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function contentText(value) {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value.map(block => typeof block === 'string' ? block : block?.text ?? '').join('\n') : '';
}

export function boundedToolObservation({ id, name, text, isError, errorSource }) {
  const bytes = Buffer.from(text);
  return { id, name, isError, errorSource, text: bytes.subarray(0, 8192).toString('utf8'),
    bytes: bytes.length, sha256: sha256(bytes), truncated: bytes.length > 8192 };
}

export function projectKnowledgeSettings(endpoint) {
  const writePaths = ['interface.json', ...[PUBLISH_CHANGE, STALE_CHANGE].flatMap(name =>
    ['specs/core/spec.md', 'tasks.md', 'plan.md', 'review.md'].map(path => `.kcoder/specs/changes/${name}/${path}`))];
  const allowed = ['SpecInit', 'SpecConfig', 'SpecStatus', 'SpecNewChange', 'SpecCheck', 'SpecReview', 'SpecRecordVerification', 'read'];
  return { active_provider: 'knowledge-fixture', max_tokens: 8192, max_retries: 0, permission_mode: 'ask',
    auto_tool_memory_enabled: false, session_memory: { enabled: false, update_enabled: false },
    permission_rules: [...allowed.map(tool => ({ tool, action: 'allow' })),
      ...writePaths.map(path => ({ tool: 'write', input_pattern: `file_path=${path}`, action: 'allow' }))],
    providers: { 'knowledge-fixture': { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint, default_model: 'knowledge-fixture', no_proxy: true,
      context_window_tokens: 1000000, output_headroom_tokens: 65536, max_output_tokens: 8192,
      request_timeout_secs: 30, extra_body: {} } } };
}

/** Fixed tool choices test Native orchestration, never model quality or an independent spec implementation. */
export function projectKnowledgeFixture(precheck, { readPublished = () => V2 } = {}) {
  const evidence = { requests: 0, calls: [], toolResults: [], failures: [], nextTask: null, oldRead: null, candidate: null };
  const calls = new Map();
  const tool = (name, input, check) => ({ name, input, check });
  const successful = output => assert.doesNotMatch(output, /^(?:Error:|Tool denied)/i);
  const read = path => tool('read', { file_path: path, format: 'raw' }, output =>
    assert.doesNotMatch(output, /not found|cannot read|failed to read|does not exist/i));
  const write = (path, content) => tool('write', () => ({ file_path: path, content: typeof content === 'function' ? content() : content }),
    output => assert.match(output, /^(?:The file .+ has been updated successfully\.|File created successfully at:)/s,
      'Native write must confirm success; an unread-file, TDD, sandbox or permission rejection cannot advance this fixture'));
  const plan = () => {
    const steps = [
      tool('SpecInit', {}, output => assert.match(output, /Initialized spec subsystem/)),
      tool('SpecConfig', { action: 'set', key: 'schema', value: 'spec-driven-superpowers' }),
      tool('SpecConfig', { action: 'set', key: 'precheck', value: precheck }),
      read('interface.json'),
      write('interface.json', '{"version":"two"}\n'),
      tool('SpecStatus', { knowledge: { paths: [SOURCE] } }, output => {
        const view = JSON.parse(output).knowledge;
        assert.equal(view.sources[0].path, SOURCE); assert.equal(view.sources[0].content, V1);
        assert.equal(view.sources[0].revision, sha256(V1)); assert.equal(view.sources[0].kind, 'authoritative_spec');
        evidence.oldRead = view;
      }),
      tool('SpecStatus', () => ({ knowledge: { paths: [SOURCE], scope: evidence.oldRead.scope,
        updates: [{ path: SOURCE, expected_revision: sha256(V1), replacement: V2 }] } }), output => {
        const candidate = JSON.parse(output).candidates[0];
        assert.equal(candidate.status, 'candidate_update'); assert.equal(candidate.base_revision, sha256(V1));
        assert.match(candidate.diff, /version two/); assert.match(candidate.delta, /MODIFIED Requirements/);
        assert.equal(candidate.change_base.scope, evidence.oldRead.scope);
        assert.deepEqual(candidate.change_base.sources, [{ path: SOURCE, revision: sha256(V1) }]);
        evidence.candidate = candidate;
      }),
    ];
    for (const name of [PUBLISH_CHANGE, STALE_CHANGE]) {
      const path = `.kcoder/specs/changes/${name}`;
      steps.push(
        tool('SpecNewChange', () => ({ name, knowledge_base: evidence.candidate.change_base })),
        read(`${path}/specs/core/spec.md`), write(`${path}/specs/core/spec.md`, () => evidence.candidate.delta),
        read(`${path}/tasks.md`), write(`${path}/tasks.md`, '- [x] 1.1 Confirm the interface contract\n'),
        read(`${path}/plan.md`), write(`${path}/plan.md`, '# Plan\n\n## Covers\n\n- 1.1\n'),
        read(`${path}/review.md`), write(`${path}/review.md`, '# Review\n\n## Readiness Decision\n\nready\n\n## Blocked By\n\nnone\n'),
        tool('SpecCheck', { action: 'validate', change: name }, output => assert.match(output, /Validation passed/)),
        tool('SpecReview', { action: 'prepare', name, base_sha: 'HEAD' }, output => assert.match(output, /version two/)),
        tool('SpecReview', { action: 'writeback', name, review_status: 'approved',
          findings_summary: ['Deterministic contract fixture reviewed for explicit archive confirmation.'] }),
        tool('SpecRecordVerification', { name, completion_decision: 'complete',
          evidence: ['Owned deterministic interface contract fixture; archive runs its fixed Node precheck. No model-quality or CI claim.'] }),
        tool('SpecCheck', { action: 'preflight', change: name }, output => assert.equal(JSON.parse(output).ok, true)),
      );
    }
    return steps;
  };
  function selection(body) {
    const messages = body.messages ?? [];
    const index = messages.findLastIndex(message => message.role === 'user' && MARKERS.some(marker => contentText(message.content).startsWith(marker)));
    assert.ok(index >= 0, 'fixture requires this scenario user task, not a later Runtime-role message');
    const marker = MARKERS.find(value => contentText(messages[index].content).startsWith(value));
    const results = messages.slice(index + 1).filter(message => message.role === 'tool');
    return { marker, messages, results };
  }
  function respond(body) {
    const request = ++evidence.requests;
    assert.ok(request <= 64, 'project knowledge provider request budget exceeded');
    const { marker, messages, results } = selection(body);
    for (const result of results) {
      const call = calls.get(result.tool_call_id);
      assert.ok(call, 'Native returned a result for an unknown fixture tool identity');
      if (!call.checked) {
        assert.ok(evidence.toolResults.length < 64, 'Native tool result evidence budget exceeded');
        evidence.toolResults.push(boundedToolObservation({ id: result.tool_call_id, name: call.name,
          text: contentText(result.content), isError: typeof result.is_error === 'boolean' ? result.is_error : 'notPresent', errorSource: 'provider-tool-wire' }));
        call.check(contentText(result.content)); call.checked = true;
      }
    }
    let steps;
    if (marker === 'KNOWLEDGE_PREPARE') steps = plan();
    else if (marker === 'KNOWLEDGE_DENY') steps = [tool('SpecArchive', { name: PUBLISH_CHANGE }, output => assert.match(output, /denied|declin|not approved/i))];
    else if (marker === 'KNOWLEDGE_ACCEPT') steps = [tool('SpecArchive', { name: PUBLISH_CHANGE }, output => assert.match(output, /Archived change/))];
    else if (marker === 'KNOWLEDGE_STALE' || marker === 'KNOWLEDGE_OLD_SCOPE') {
      steps = [tool('SpecStatus', () => ({ knowledge: { paths: [SOURCE], scope: evidence.oldRead.scope,
        updates: [{ path: SOURCE, expected_revision: sha256(V1), replacement: V2 }] } }), output => {
        assert.match(output, marker === 'KNOWLEDGE_STALE' ? /stale_revision/ : /scope_changed/);
      })];
      if (marker === 'KNOWLEDGE_STALE') steps.push(tool('SpecArchive', { name: STALE_CHANGE }, output =>
        assert.ok(output.startsWith(`Tool \`SpecArchive\` execution failed: failed to archive change: failed to sync change '${STALE_CHANGE}' before archiving.`),
          'the retained old change must be rejected at its own sync-before-archive boundary')));
    } else {
      const quoted = messages.flatMap(message => {
        const text = contentText(message.content);
        return text.startsWith('Current task project knowledge ') ? [text] : [];
      });
      assert.equal(quoted.length, 1, 'next task must contain one actual fresh Runtime source projection');
      const current = JSON.parse(quoted[0].split('\n').slice(1).join('\n')).knowledge;
      assert.notEqual(current.scope, evidence.oldRead.scope);
      assert.equal(current.sources[0].path, SOURCE); assert.equal(current.sources[0].kind, 'authoritative_spec');
      const published = readPublished();
      assert.match(published, /version two/); assert.doesNotMatch(published, /version one/);
      assert.equal(current.sources[0].revision, sha256(published)); assert.equal(current.sources[0].content, published);
      assert.ok(!JSON.stringify(messages).includes('version one'), 'next task must not inherit the old contract');
      evidence.nextTask = { scope: current.scope, source: current.sources[0], request, runtimeProjectionCount: quoted.length };
      steps = [];
    }
    assert.ok(results.length <= steps.length, 'unexpected duplicate tool execution');
    if (results.length === steps.length) return [{ delta: { role: 'assistant', content: `${marker}_COMPLETE` }, finishReason: 'stop' }];
    const step = steps[results.length];
    const input = typeof step.input === 'function' ? step.input() : step.input;
    const available = new Set((body.tools ?? []).map(entry => entry.function?.name));
    assert.ok(available.has(step.name), `required registered tool is not attached: ${step.name}`);
    const id = `knowledge-${request}`;
    calls.set(id, { name: step.name, check: step.check ?? successful, checked: false });
    evidence.calls.push({ request, marker, toolCallId: id, name: step.name, input });
    return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name: step.name, arguments: JSON.stringify(input) } }] }, finishReason: 'tool_calls' }];
  }
  return { evidence, responseSteps(input) {
    try { return respond(input.body); }
    catch (error) {
      evidence.failures.push(error.message);
      return [{ delta: { role: 'assistant', content: 'KNOWLEDGE_FIXTURE_ASSERTION_FAILED' }, finishReason: 'stop' }];
    }
  } };
}
