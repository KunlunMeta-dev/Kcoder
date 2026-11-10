import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { applySync, captureSyncCheckpoint, inspectSync, syncNodeHash, syncSourceHash, syncWalk } from '../sync/core.mjs';
import { registerReferenceAnchors } from '../canvas/register.mjs';
import { buildEditableScreens } from '../canvas/builder.mjs';

function fixture() {
  let next = 0;
  const nodes = new Map();
  class Node {
    constructor(type, name = '') { this.id = `test:${++next}`; this.type = type; this.name = name; this.children = []; this.reactions = [];
      this.x = 0; this.y = 0; this.width = 390; this.height = 844; this.visible = true; this.fills = []; this.layoutMode = 'NONE';
      this.characters = ''; this.fontName = { family: 'Noto Sans SC', style: 'Regular' }; nodes.set(this.id, this); }
    appendChild(n) { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); this.children.push(n); n.parent = this; }
    remove() { for (const n of [...this.children]) n.remove(); if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); nodes.delete(this.id); this.removed = true; }
    resize(w, h) { this.width = w; this.height = h; }
    resizeWithoutConstraints(w, h) { this.resize(w, h); }
    getStyledTextSegments() { return [{ fontName: this.fontName, start: 0, end: this.characters.length }]; }
    async setReactionsAsync(reactions) { this.reactions = reactions; }
    findAll(fn) { return syncWalk(this).filter(fn); }
  }
  const page = new Node('PAGE', 'Page 1'); page.flowStartingPoints = [];
  const root = new Node('SECTION', 'REF · V3'); page.appendChild(root);
  const original = new Node('FRAME', 'Designer original'); page.appendChild(original);
  const section = new Node('SECTION', 'REF-V3 / selection'); root.appendChild(section);
  const screen = new Node('FRAME', 'REF-V3 / A / screen'); section.appendChild(screen); screen.x = 24; screen.y = 152;
  const old = new Node('FRAME', '按钮 / Open'); screen.appendChild(old);
  const notes = new Node('FRAME', 'REF-NOTES / A / 触发与去向'); section.appendChild(notes);
  notes.appendChild(new Node('TEXT', 'Legacy annotation'));
  const destination = new Node('FRAME', 'REF-V3 / B / destination'); section.appendChild(destination);
  destination.appendChild(new Node('TEXT', 'existing target'));
  old.reactions = [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: destination.id, navigation: 'NAVIGATE', transition: null }] }];
  page.flowStartingPoints = [{ nodeId: screen.id, name: 'REF / Start' }, { nodeId: original.id, name: 'Designer start' }];
  const figma = { fileKey: 'file', currentPage: page, getNodeByIdAsync: async id => nodes.get(id), setCurrentPageAsync: async p => { figma.currentPage = p; },
    loadFontAsync: async () => {}, createFrame: () => new Node('FRAME'), createText: () => new Node('TEXT'), createSection: () => new Node('SECTION') };
  const manifest = { fileKey: 'file', rootNodeId: root.id, states: [
    { stateId: 'A', nodeId: screen.id, sectionId: section.id }, { stateId: 'B', nodeId: destination.id, sectionId: section.id },
  ] };
  const state = { id: 'A', title: 'updated', scene: { content: 'new' }, condition: 'ready', transition: { next: [{ id: 'B', text: 'Open destination' }] } };
  const build = async (api, states, targets) => {
    const ids = [], controls = [];
    for (const s of states) {
      const stage = await api.getNodeByIdAsync(targets.find(t => t.stateId === s.id).nodeId), n = api.createFrame(); stage.appendChild(n);
      n.name = '按钮 / Open'; ids.push(n.id); controls.push({ stateId: s.id, nodeId: n.id, testId: 'open', disabled: !!s.disabled });
    }
    return { createdNodeIds: ids, controls };
  };
  return { figma, root, page, screen, old, notes, destination, original, manifest, state, build, nodes };
}

async function ready() {
  const f = fixture(), checkpoint = await captureSyncCheckpoint(f.figma, f.manifest);
  return { ...f, checkpoint, bundle: { schema: 1, checkpoint, states: [f.state], componentSourceHash: 'source' } };
}

test('explicit source registration preserves existing frames/flows and refuses duplicate or edited references', async () => {
  const f = await ready(), before = syncNodeHash(f.original), screen = syncNodeHash(f.screen), flows = [...f.page.flowStartingPoints];
  const oldHeight = f.root.height;
  const result = await registerReferenceAnchors(f.figma, f.checkpoint, [{ id: 'PLAN-02', title: 'Collapsed' }], 'REF-V3 / new');
  assert.equal(result.checkpoint.states.length, 3); assert.equal(result.checkpoint.states[2].sourceHash, null);
  assert.equal(syncNodeHash(f.original), before); assert.equal(syncNodeHash(f.screen), screen);
  assert.deepEqual(f.page.flowStartingPoints, flows); assert.ok(f.root.height > oldHeight);
  assert.equal((await f.figma.getNodeByIdAsync(result.checkpoint.states[2].nodeId)).width, 390);
  await assert.rejects(() => registerReferenceAnchors(f.figma, f.checkpoint, [{ id: 'PLAN-02', title: 'Again' }], 'REF-V3 / new'), /Unrecorded/);
  const g = await ready(); g.old.name = 'Designer edit'; const count = g.nodes.size;
  await assert.rejects(() => registerReferenceAnchors(g.figma, g.checkpoint, [{ id: 'PLAN-02' }], 'REF-V3 / new'), /changed/);
  assert.equal(g.nodes.size, count);
});

test('registration rolls back partial anchors and its MCP script executes the same mechanism', async () => {
  const f = await ready(), count = f.nodes.size, height = f.root.height;
  f.figma.createFrame = () => { throw new Error('Injected registration failure'); };
  await assert.rejects(() => registerReferenceAnchors(f.figma, f.checkpoint, [{ id: 'PLAN-02', title: 'New' }], 'REF-V3 / new'), /Injected/);
  assert.equal(f.nodes.size, count); assert.equal(f.root.height, height);
  const { makeRegistrationScript } = await import('../transport/registration.mjs');
  const g = await ready(), code = await makeRegistrationScript(g.checkpoint, { states: [{ id: 'PLAN-02', title: '新状态' }], sectionName: 'REF-V3 / 新增' });
  assert.ok(code.length < 50000);
  const result = await vm.runInNewContext(`(async()=>{${code}})()`, { figma: { ...g.figma, base64Decode: value => Buffer.from(value, 'base64') } });
  assert.equal(result.pendingStates[0], 'PLAN-02'); assert.equal(result.anchors.length, 1);
  assert.equal(result.checkpoint, undefined); assert.ok(JSON.stringify(result).length < 48000);
});

test('update preserves stable frames, designer placement, unrelated content and routes; second apply is a no-op', async () => {
  const f = await ready(), originalHash = syncNodeHash(f.original), oldChildId = f.old.id;
  f.screen.x = 950; f.screen.name = 'REF-V3 / designer label';
  const first = await applySync(f.figma, f.bundle, f.build);
  assert.equal(first.status, 'updated'); assert.deepEqual(first.updated, ['A']);
  assert.equal(f.screen.x, 950); assert.equal(f.screen.name, 'REF-V3 / designer label');
  assert.equal(syncNodeHash(f.original), originalHash); assert.equal(f.nodes.has(oldChildId), false);
  assert.equal(f.screen.children[0].reactions[0].actions[0].destinationId, f.destination.id);
  assert.equal(first.checkpoint.routes[0].selector.testId, 'open');
  assert.deepEqual(f.page.flowStartingPoints, [{ nodeId: f.screen.id, name: 'REF / Start' }, { nodeId: f.original.id, name: 'Designer start' }]);
  assert.match(f.notes.children[0].children[0].characters, /A · updated/);
  const childIds = syncWalk(f.screen).map(n => n.id), count = f.nodes.size;
  const second = await applySync(f.figma, { ...f.bundle, checkpoint: first.checkpoint }, f.build);
  assert.equal(second.status, 'unchanged'); assert.equal(f.nodes.size, count); assert.deepEqual(syncWalk(f.screen).map(n => n.id), childIds);
});

test('manual UI or annotation edits stop updates before writes', async () => {
  for (const area of ['old', 'notes']) {
    const f = await ready(); f[area].children.length ? f[area].children[0].characters = 'designer edit' : f[area].fills = [{ color: 'manual' }];
    const size = f.nodes.size;
    const result = await applySync(f.figma, f.bundle, f.build);
    assert.equal(result.status, 'conflict'); assert.equal(result.plan.conflicts[0].reason, 'designer-edit'); assert.equal(f.nodes.size, size);
  }
});

test('unmapped new states and duplicate IDs fail closed; omissions retain existing pages', async () => {
  const f = await ready();
  const added = await inspectSync(f.figma, f.checkpoint, [...f.bundle.states, { ...f.state, id: 'NEW' }]);
  assert.equal(added.plan.conflicts[0].reason, 'missing-anchor'); assert.ok(added.plan.retained.includes('B'));
  await assert.rejects(() => inspectSync(f.figma, f.checkpoint, [f.state, f.state]), /Duplicate/);
});

test('failed staging and unresolved route remove staging nodes and preserve old content', async () => {
  for (const mode of ['builder', 'route']) {
    const f = await ready(), before = syncNodeHash(f.screen), size = f.nodes.size;
    const build = async (...args) => { const result = await f.build(...args); if (mode === 'builder') throw new Error('Injected build failure');
      const node = await f.figma.getNodeByIdAsync(result.controls[0].nodeId); node.name = 'unrelated control'; return result; };
    await assert.rejects(() => applySync(f.figma, f.bundle, build), mode === 'builder' ? /Injected/ : /Unresolved route/);
    assert.equal(syncNodeHash(f.screen), before); assert.equal(f.nodes.size, size);
  }
});

test('commit-time failure rolls back both UI and notes, then retry succeeds', async () => {
  const f = await ready(), before = syncNodeHash(f.screen), notesBefore = syncNodeHash(f.notes), count = f.nodes.size;
  const append = f.notes.appendChild.bind(f.notes); let fail = true;
  f.notes.appendChild = n => { if (fail && n !== f.notes.children[0]) { fail = false; throw new Error('Injected swap failure'); } return append(n); };
  await assert.rejects(() => applySync(f.figma, f.bundle, f.build), /Injected/);
  assert.equal(syncNodeHash(f.screen), before); assert.equal(syncNodeHash(f.notes), notesBefore); assert.equal(f.nodes.size, count);
  assert.equal((await applySync(f.figma, f.bundle, f.build)).status, 'updated');
});

test('wrong file, moved-out frame and unsafe destination are rejected', async () => {
  const f = await ready(); f.figma.fileKey = 'other';
  await assert.rejects(() => inspectSync(f.figma, f.checkpoint, f.bundle.states), /Wrong Figma file/);
  f.figma.fileKey = 'file'; f.page.appendChild(f.screen);
  assert.equal((await inspectSync(f.figma, f.checkpoint, f.bundle.states)).plan.conflicts[0].reason, 'unsafe-or-missing-frame');
  f.checkpoint.routes[0].destinationId = f.original.id;
  delete f.checkpoint.routes[0].targetStateId;
  await assert.rejects(() => inspectSync(f.figma, f.checkpoint, f.bundle.states), /unsafe route destination/);
});

test('stable test ID preserves route when visible label changes; disabled control never navigates', async () => {
  const f = await ready(); f.checkpoint.routes[0].selector = { testId: 'open', occurrence: 0 };
  const build = async (...args) => { const result = await f.build(...args); (await f.figma.getNodeByIdAsync(result.controls[0].nodeId)).name = '按钮 / New label'; return result; };
  const result = await applySync(f.figma, f.bundle, build); assert.equal(result.status, 'updated'); assert.ok(f.screen.children[0].reactions.length);
  const g = await ready(); g.state.disabled = true;
  const disabled = await applySync(g.figma, g.bundle, g.build); assert.equal(disabled.skippedDisabled.length, 1); assert.equal(g.screen.children[0].reactions.length, 0);
});

test('source metadata changes require refresh; key order does not', () => {
  assert.equal(syncSourceHash({ scene: { a: 1, b: 2 } }), syncSourceHash({ scene: { b: 2, a: 1 } }));
  assert.notEqual(syncSourceHash({ scene: {}, title: 'old' }), syncSourceHash({ scene: {}, title: 'new' }));
  assert.equal(syncSourceHash({ scene: {} }), syncSourceHash({ scene: {}, renderRevision: undefined }));
  assert.notEqual(syncSourceHash({ scene: {} }), syncSourceHash({ scene: {}, renderRevision: 'strikethrough-1' }));
});

test('editable text preserves completed-item strikethrough and link underlines', async () => {
  for (const [decoration, expected] of [['line-through', 'STRIKETHROUGH'], ['underline', 'UNDERLINE']]) {
    const f = await ready(); f.old.remove();
    await buildEditableScreens(f.figma, [{ id: 'A', scene: { tag: 'text', n: 'Completed', text: 'Completed', b: { x: 0, y: 0, w: 150, h: 20 },
      s: { size: 14, line: 20, font: 'Noto Sans SC', decoration }, c: [] } }], [{ stateId: 'A', nodeId: f.screen.id }], { pageReady: true });
    assert.equal(f.screen.children[0].textDecoration, expected);
  }
});

test('DOM traversal serial changes do not refresh rendered content; real text changes do', () => {
  const state = { title: 'Title', scene: { tag: 'div', k: 1, c: [{ tag: 'text', k: 2, text: 'Hello' }] } };
  const reordered = { ...state, scene: { ...state.scene, k: 30, c: [{ ...state.scene.c[0], k: 40 }] } };
  assert.equal(syncSourceHash(state), syncSourceHash(reordered));
  reordered.scene.c[0].text = 'Changed';
  assert.notEqual(syncSourceHash(state), syncSourceHash(reordered));
});

test('digest-only previews inspect real frames but cannot perform writes', async () => {
  const f = await ready(), digest = { id: f.state.id, sourceHash: syncSourceHash(f.state) };
  assert.equal((await inspectSync(f.figma, f.checkpoint, [digest])).plan.entries[0].action, 'update');
  const size = f.nodes.size;
  await assert.rejects(() => applySync(f.figma, { ...f.bundle, states: [digest] }, f.build), /full scenes required/);
  assert.equal(f.nodes.size, size);
});

test('removed source controls retain route definitions; conversion failures still roll back', async () => {
  for (const stableId of [true, false]) {
    const f = await ready();
    if (stableId) f.checkpoint.routes[0].selector = { testId: 'open', occurrence: 0 };
    f.state.scene = { tag: 'div', n: 'root', c: [] };
    const missingBuilder = async (...args) => {
      const result = await f.build(...args);
      (await f.figma.getNodeByIdAsync(result.controls[0].nodeId)).name = '布局 / Different';
      result.controls = [];
      return result;
    };
    const result = await applySync(f.figma, f.bundle, missingBuilder);
    assert.equal(result.skippedAbsent.length, 1);
    assert.deepEqual(result.checkpoint.routes, f.checkpoint.routes);
    assert.equal(f.screen.children[0].reactions.length, 0);
    const g = await ready();
    if (stableId) g.checkpoint.routes[0].selector = { testId: 'open', occurrence: 0 };
    g.state.scene = { tag: 'div', c: [{ tag: 'button', l: 'Open', t: 'open' }] };
    const brokenBuilder = async (...args) => { const r = await g.build(...args); (await g.figma.getNodeByIdAsync(r.controls[0].nodeId)).name = 'Wrong'; r.controls = []; return r; };
    const hash = syncNodeHash(g.screen), size = g.nodes.size;
    await assert.rejects(() => applySync(g.figma, g.bundle, brokenBuilder), /Unresolved route/);
    assert.equal(syncNodeHash(g.screen), hash); assert.equal(g.nodes.size, size);
  }
});

test('native plugin UI only permits apply after successful preview', async () => {
  const html = await readFile(new URL('../transport/plugin.html', import.meta.url), 'utf8');
  const elements = new Map(), sent = [];
  const document = { getElementById: id => { if (!elements.has(id)) elements.set(id, { disabled: id !== 'preview', dataset: {} }); return elements.get(id); } };
  const context = { document, parent: { postMessage: m => sent.push(m.pluginMessage) }, window: {} };
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  assert.equal(sent[0].type, 'preview');
  context.window.onmessage({ data: { pluginMessage: { type: 'preview', stateCount: 1, plan: { entries: [{ action: 'update', stateId: 'A' }], conflicts: [], retained: [] } } } });
  context.window.onmessage({ data: { pluginMessage: { type: 'ready' } } }); assert.equal(elements.get('apply').disabled, false);
  context.window.onmessage({ data: { pluginMessage: { type: 'error', text: 'Conflict' } } });
  context.window.onmessage({ data: { pluginMessage: { type: 'ready' } } }); assert.equal(elements.get('apply').disabled, true);
});

test('MCP transport round-trips Unicode and large payloads and merges only selected checkpoint states', async () => {
  const { packSyncData, syncDecoderSource, mergeSyncCheckpoint, makeMcpSyncScript } = await import('../transport/mcp.mjs');
  const data = { text: '中文 🙂 <script> & ~'.repeat(12000), random: Array.from({ length: 20000 }, (_, i) => String.fromCharCode(32 + ((i * 41) % 90))).join('') };
  const context = { figma: { base64Decode: value => Buffer.from(value, 'base64') }, encoded: packSyncData(data), result: null };
  vm.runInNewContext(`${syncDecoderSource}; result=unpackSyncData(encoded);`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.result)), data);
  const f = await ready(), changed = { ...f.checkpoint.states[0], sourceHash: 'new' };
  const next = mergeSyncCheckpoint(f.checkpoint, { states: [changed], routes: f.checkpoint.routes, updatedAt: 'now' });
  assert.equal(next.states[0].sourceHash, 'new'); assert.equal(next.states[1], f.checkpoint.states[1]);
  const script = await makeMcpSyncScript(f.bundle, { mode: 'preview' }); assert.ok(script.length < 49000);
  const plan = await vm.runInNewContext(`(async()=>{${script}})()`, { figma: { ...f.figma, base64Decode: value => Buffer.from(value, 'base64') } });
  assert.equal(plan.conflicts.length, 0); assert.equal(plan.entries[0].action, 'update');
});

test('native plugin persists checkpoints across reloads and returns a recovery checkpoint if storage fails', async () => {
  const main = await readFile(new URL('../transport/plugin.js', import.meta.url), 'utf8');
  const f = await ready(), storage = new Map(), sent = [];
  f.bundle.interfaceVersion = 'V3';
  f.figma.showUI = () => {}; f.figma.ui = { postMessage: message => sent.push(message) };
  f.figma.clientStorage = { getAsync: async key => storage.get(key), setAsync: async (key, value) => storage.set(key, value) };
  const context = { figma: f.figma, __html__: '', bundledSyncPackage: f.bundle, inspectSync, applySync, buildEditableScreens: f.build };
  vm.runInNewContext(main, context);
  await f.figma.ui.onmessage({ type: 'apply' });
  assert.equal(sent.find(m => m.type === 'result').result.status, 'updated'); assert.equal(storage.size, 1);
  sent.length = 0; vm.runInNewContext(main, { ...context });
  await f.figma.ui.onmessage({ type: 'apply' }); assert.equal(sent.find(m => m.type === 'result').result.status, 'unchanged');
  const g = await ready(), warnings = [];
  g.figma.showUI = () => {}; g.figma.ui = { postMessage: message => warnings.push(message) };
  g.figma.clientStorage = { getAsync: async () => undefined, setAsync: async () => { throw new Error('storage full'); } };
  vm.runInNewContext(main, { figma: g.figma, __html__: '', bundledSyncPackage: g.bundle, inspectSync, applySync, buildEditableScreens: g.build });
  await g.figma.ui.onmessage({ type: 'apply' });
  assert.ok(warnings.some(m => m.type === 'warning')); assert.equal(warnings.find(m => m.type === 'result').result.checkpoint.states[0].sourceHash, syncSourceHash(g.state));
});
