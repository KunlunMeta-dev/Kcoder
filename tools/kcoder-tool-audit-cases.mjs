// Isolated capability probes. Rejected prerequisites are never successful execution samples.
import path from 'node:path';

export function auditCases({ workspace, root, catalog, repeats = 3, externalConsent = false }) {
  const available = new Set(catalog.map(t => (t.function || t).name));
  const plan = [];
  const blocked = [];
  const probe = (name, input, count = repeats, mode = 'execution') => {
    if (!available.has(name)) return;
    for (let round = 0; round < count; round++) plan.push({ rawName: name, rawInput: input, category: `audit:${name}`, round, mode });
  };
  const defer = (name, reason) => { if (available.has(name)) blocked.push({ name, reason }); };
  const ownedAgent = s => s.ids.agent || 'benchmark-agent-not-created';
  const ownedTask = s => s.ids.task || 'benchmark-task-not-created';
  const ownedShell = s => s.ids.shell || 'benchmark-shell-not-created';
  probe('Config', { setting: 'tool_timeout_ms' });
  probe('CtxInspect', {});
  probe('DiscoverSkills', { description: 'Find the isolated benchmark skill', limit: 3 });
  defer('LocalMemoryRecall', 'Uses the real HOME/USERPROFILE notes namespace instead of the isolated KCODER_CONFIG_DIR; personal notes are excluded.');
  probe('Sleep', { duration_seconds: 0.02 });
  probe('glob', { pattern: '**/*.txt', path: path.join(workspace, 'corpus'), limit: 100 });
  probe('memory_search', { query: 'benchmark', limit: 3 });
  probe('memory_get', { id: 1 });
  probe('remember', { fact: 'Synthetic benchmark note in the isolated profile only.', category: 'benchmark' }, 1);
  probe('skill_curator', { action: 'status' });
  probe('skill_guard', { content: '# Benchmark\nRead only the synthetic fixture.', name: 'benchmark' });
  probe('skill_hub', { action: 'list' });
  probe('skill_manage', { action: 'list' });
  probe('skill', { skill: 'benchmark-latency' });
  probe('TodoWrite', { TodoList: [{ content: 'Measure the synthetic fixture', activeForm: 'Measuring the synthetic fixture', status: 'in_progress' }] });
  probe('TaskCreate', { subject: 'Isolated latency probe', description: 'Synthetic task metadata only; no external work.' }, 1);
  probe('TaskList', {});
  probe('TaskGet', s => ({ taskId: ownedTask(s) }));
  probe('TaskUpdate', s => ({ taskId: ownedTask(s), status: 'in_progress' }));
  probe('bash', { command: 'printf AGENT_BENCH_AUDIT_OK', timeout: 10000 });
  probe('bash', { command: 'sleep 3; printf AGENT_BENCH_BACKGROUND_OK', timeout: 10000, run_in_background: true }, 1, 'background_setup');
  probe('TaskOutput', s => ({ task_id: ownedShell(s), block: false }));
  probe('TaskStop', s => ({ task_id: ownedShell(s) }), 1);
  probe('REPL', { language: 'python', code: 'print("AGENT_BENCH_AUDIT_OK")', timeout: 5 });
  probe('REPL', { language: 'javascript', code: 'console.log("AGENT_BENCH_AUDIT_OK")', timeout: 5 });
  probe('REPL', { language: 'shell', code: 'printf AGENT_BENCH_AUDIT_OK', timeout: 5 });
  probe('read', { file_path: path.join(workspace, 'fixture.txt'), fresh: true, limit: 200 });
  probe('grep', { pattern: 'AGENT_BENCH_NEEDLE_3F27', path: path.join(workspace, 'corpus'), output_mode: 'content' });
  probe('write', s => ({ file_path: path.join(workspace, `audit-write-${s.index}.txt`), content: 'AGENT_BENCH_AUDIT_OK\n' }));
  probe('read', { file_path: path.join(workspace, 'edit-fixture.txt'), fresh: true });
  probe('edit', { file_path: path.join(workspace, 'edit-fixture.txt'), old_string: 'BEFORE', new_string: 'AFTER' }, 1);
  probe('WorkflowDraft', { action: 'list' });
  probe('Workflow', { script: 'log("AGENT_BENCH_WORKFLOW_OK"); 42;', timeout_seconds: 5, max_agent_turns: 1 }, 1, 'background_start');
  probe('get_goal', {});
  probe('cron_list', {});
  // These require an explicit product action, beyond measuring a tool's latency.
  defer('create_goal', 'No long-running user goal is created by a latency benchmark.');
  defer('update_goal', 'No owned active goal exists; a missing-goal error is not execution latency.');
  defer('cron_create', 'No persistent schedule was requested; scheduler creation is excluded.');
  defer('cron_delete', 'No owned scheduled job exists to delete.');
  defer('Snip', 'No production transcript is rewritten; synthetic transcript control needs a dedicated fixture.');
  defer('VerifyPlanExecution', 'No actual execution plan or verified completion exists to certify.');
  probe('SpecStatus', {});
  probe('SpecConfig', { action: 'get' });
  probe('SpecUpdate', { dry_run: true });
  for (const name of ['SpecInit', 'SpecNewChange', 'SpecArchive', 'SpecCheck', 'SpecParallelDraft', 'SpecRecordVerification', 'SpecReview', 'SpecSync']) {
    defer(name, 'Requires the Specs/Superpowers workflow fixture and its activation prerequisites; not measured through a rejected call.');
  }
  probe('spawn_agent', { message: 'Return AGENT_BENCH_CHILD_OK only. Do not use tools.', context_mode: 'none', max_turns: 1, run_in_background: false }, 1);
  probe('SendMessage', s => ({ agent_id: ownedAgent(s), message: 'Return AGENT_BENCH_CHILD_OK only. Do not use tools.', max_turns: 1 }), 1);
  probe('wait', s => ({ agent_id: ownedAgent(s), timeout_ms: 1000 }));
  probe('close_agent', s => ({ agent_id: ownedAgent(s) }), 1);
  probe('explore_agent', { message: 'Return AGENT_BENCH_CHILD_OK only. Do not use tools.', context_mode: 'none', max_turns: 1, run_in_background: false }, 1);
  probe('WorktreeCreate', { path: path.join(root, 'owned-worktree'), newBranch: 'bench-owned' }, 1);
  probe('EnterWorktree', { path: path.join(root, 'owned-worktree') }, 1);
  probe('ExitWorktree', { action: 'keep' }, 1);
  probe('WorktreeRemove', { path: path.join(root, 'owned-worktree') }, 1);
  probe('ocr', { command: 'review', preview: true, path: workspace }, 1);
  // Real public requests are limited to a single known, credential-free page/query.
  if (externalConsent) {
    probe('WebFetch', { url: 'https://example.com/' }, 1, 'external_request');
    probe('WebBrowser', { url: 'https://example.com/', action: 'navigate' }, 1, 'external_request');
    probe('WebSearch', { query: 'IANA example domains', num_results: 3 }, 1, 'external_request');
  } else for (const name of ['WebFetch', 'WebBrowser', 'WebSearch']) {
    defer(name, 'Requires --consent external-provider and KCODER_TEST_SEARCH_EXTERNAL=1 for public requests.');
  }
  probe('TaskUpdate', s => ({ taskId: ownedTask(s), status: 'completed' }), 1, 'fixture_cleanup');
  probe('TodoWrite', { TodoList: [{ content: 'Measure the synthetic fixture', activeForm: 'Measuring the synthetic fixture', status: 'completed' }] }, 1, 'fixture_cleanup');
  const represented = new Set([...plan.map(p => p.rawName), ...blocked.map(p => p.name)]);
  for (const name of available) if (!represented.has(name)) blocked.push({ name, reason: 'No verified isolated scenario is defined; not counted as a successful timing.' });
  return { plan, blocked };
}
