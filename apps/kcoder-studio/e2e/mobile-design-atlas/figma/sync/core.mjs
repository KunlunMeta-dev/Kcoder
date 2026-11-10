// Shared by Node tests, the native development plugin and Figma MCP.
// This digest detects accidental edits; it is not an authentication boundary.
export function syncDigest(value) {
  const sorted = v => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])]));
    return typeof v === 'number' ? Math.round(v * 10000) / 10000 : v;
  };
  const text = JSON.stringify(sorted(value));
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

export function syncRenderScene(value) {
  if (Array.isArray(value)) return value.map(syncRenderScene);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k])=>k!=='k').map(([k,v])=>[k,syncRenderScene(v)]));
  return value;
}

export function syncSourceHash(state) {
  // DOM traversal serials are neither rendered nor stable component identities.
  return syncDigest({ scene: syncRenderScene(state.scene), title: state.title, condition: state.condition,
    transition: state.transition, renderRevision: state.renderRevision });
}

export function syncNodeHash(node) {
  const keys = ['name', 'type', 'x', 'y', 'width', 'height', 'visible', 'opacity', 'fills', 'strokes', 'strokeWeight',
    'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight', 'strokeAlign', 'effects',
    'cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius', 'clipsContent',
    'layoutMode', 'layoutPositioning', 'layoutSizingHorizontal', 'layoutSizingVertical', 'itemSpacing',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'primaryAxisAlignItems', 'counterAxisAlignItems',
    'primaryAxisSizingMode', 'counterAxisSizingMode', 'constraints', 'overflowDirection', 'rotation', 'blendMode',
    'characters', 'fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textAutoResize', 'textAlignHorizontal',
    'textDecoration', 'paragraphSpacing', 'paragraphIndent', 'vectorPaths', 'vectorNetwork', 'reactions'];
  const read = n => {
    const out = {};
    for (const k of keys) if (k in n && typeof n[k] !== 'symbol' && n[k] !== undefined) out[k] = n[k];
    if (n.type === 'TEXT' && n.characters && n.getStyledTextSegments) {
      out.segments = n.getStyledTextSegments(['fontName', 'fontSize', 'fills', 'textDecoration', 'hyperlink']);
    }
    // IDs catch replacement of a managed child even when it looks identical.
    out.id = n.id;
    if ('children' in n) out.children = n.children.map(read);
    return out;
  };
  // Placement and name of the stable outer frame belong to the designer.
  return syncDigest(node.children.map(read));
}

export function syncIsInside(node, ancestor) {
  for (let n = node; n; n = n.parent) if (n.id === ancestor.id) return true;
  return false;
}

export function syncWalk(node) {
  return 'children' in node ? node.children.flatMap(n => [n, ...syncWalk(n)]) : [];
}

export function syncResolveControl(controls, selector) {
  const items = controls.filter(c => selector.testId ? c.testId === selector.testId : c.name === selector.name);
  return items[selector.occurrence || 0] || null;
}

export function syncPlan(checkpoint, states, current) {
  const seen = new Set(), entries = [], conflicts = [];
  for (const state of states) {
    if (!state.id || seen.has(state.id)) throw new Error(`Duplicate/missing state ID: ${state.id}`);
    seen.add(state.id);
    const baseline = checkpoint.states.find(s => s.stateId === state.id);
    if (!baseline) { conflicts.push({ stateId: state.id, reason: 'missing-anchor', message: 'New state needs an explicitly assigned REF frame and route definitions.' }); continue; }
    const actual = current.find(s => s.stateId === state.id);
    if (!actual?.safe) { conflicts.push({ stateId: state.id, reason: 'unsafe-or-missing-frame' }); continue; }
    if (actual.hash !== baseline.hash || actual.notesHash !== baseline.notesHash) {
      conflicts.push({ stateId: state.id, reason: 'designer-edit', nodeId: baseline.nodeId }); continue;
    }
    const sourceHash = state.scene ? syncSourceHash(state) : state.sourceHash;
    if (!/^[a-f0-9]{16}$/.test(sourceHash || '')) throw new Error(`Missing render digest: ${state.id}`);
    entries.push({ stateId: state.id, action: baseline.sourceHash === sourceHash ? 'unchanged' : 'update' });
  }
  return { entries, conflicts, retained: checkpoint.states.filter(s => !seen.has(s.stateId)).map(s => s.stateId) };
}

export async function inspectSync(figma, checkpoint, states) {
  if (checkpoint.schema !== 1 || !checkpoint.rootNodeId || !Array.isArray(checkpoint.routes)) throw new Error('Unsupported checkpoint');
  if (figma.fileKey && figma.fileKey !== checkpoint.fileKey) throw new Error('Wrong Figma file');
  const root = await figma.getNodeByIdAsync(checkpoint.rootNodeId);
  if (!root || root.type !== 'SECTION' || !root.name.startsWith('REF')) throw new Error('REF root missing or renamed outside its namespace');
  const page = root.parent;
  if (!page || page.type !== 'PAGE' || page.id !== checkpoint.pageNodeId) throw new Error('REF page mismatch');
  if (figma.currentPage.id !== page.id) await figma.setCurrentPageAsync(page);
  const current = [];
  const requestedIds = new Set(states.map(s => s.id));
  for (const state of checkpoint.states.filter(s => requestedIds.has(s.stateId))) {
    const frame = await figma.getNodeByIdAsync(state.nodeId);
    const notes = state.notesNodeId ? await figma.getNodeByIdAsync(state.notesNodeId) : null;
    const safe = !!frame && frame.type === 'FRAME' && syncIsInside(frame, root) && frame.name.startsWith('REF-V3 / ')
      && (!state.notesNodeId || (!!notes && notes.type === 'FRAME' && syncIsInside(notes, root) && notes.name.startsWith('REF-NOTES / ')));
    current.push({ stateId: state.stateId, safe, hash: safe ? syncNodeHash(frame) : null, notesHash: safe && notes ? syncNodeHash(notes) : null });
  }
  // Route destinations are restricted to this reference region, never the designer's source area.
  for (const route of checkpoint.routes.filter(r => requestedIds.has(r.stateId))) {
    const destinationId = route.targetStateId ? checkpoint.states.find(s => s.stateId === route.targetStateId)?.nodeId : route.destinationId;
    if (route.type === 'NODE' && !destinationId) throw new Error(`Missing route target ${route.targetStateId}`);
    if (destinationId) {
      const dest = await figma.getNodeByIdAsync(destinationId);
      if (!dest || !syncIsInside(dest, root)) throw new Error(`Missing/unsafe route destination ${destinationId}`);
    }
  }
  return { root, page, plan: syncPlan(checkpoint, states, current) };
}

/** Read-only adoption is explicit, and never re-runs implicitly on conflict. */
export async function captureSyncCheckpoint(figma, manifest) {
  const root = await figma.getNodeByIdAsync(manifest.rootNodeId);
  if (!root || root.type !== 'SECTION' || !root.name.startsWith('REF') || root.parent.type !== 'PAGE') throw new Error('Unsafe root');
  const page = root.parent;
  if (figma.currentPage.id !== page.id) await figma.setCurrentPageAsync(page);
  const states = [], routes = [];
  const byFrame = new Map(manifest.states.map(s => [s.nodeId, s.stateId]));
  for (const item of manifest.states) {
    const frame = await figma.getNodeByIdAsync(item.nodeId);
    if (!frame || frame.type !== 'FRAME' || !syncIsInside(frame, root) || !frame.name.startsWith('REF-V3 / ')) throw new Error(`Unsafe frame ${item.nodeId}`);
    const notes = frame.parent.children.find(n => n.name.startsWith(`REF-NOTES / ${item.stateId} / `));
    const counts = new Map();
    for (const n of syncWalk(frame)) {
      const occurrence = counts.get(n.name) || 0; counts.set(n.name, occurrence + 1);
      if (!('reactions' in n)) continue;
      for (const r of n.reactions) {
        const actions = r.actions || (r.action ? [r.action] : []);
        if (r.trigger?.type !== 'ON_CLICK' || actions.length !== 1 || !['NODE', 'BACK'].includes(actions[0].type)) throw new Error(`Unsupported prototype ${n.id}`);
        const action = actions[0], destination = action.destinationId;
        if (destination) {
          const dest = await figma.getNodeByIdAsync(destination);
          if (!dest || !syncIsInside(dest, root)) throw new Error(`External destination ${destination}`);
        }
        routes.push({ stateId: item.stateId, selector: { name: n.name, occurrence }, type: action.type,
          ...(destination ? (byFrame.has(destination) ? { targetStateId: byFrame.get(destination) } : { destinationId: destination }) : {}) });
      }
    }
    states.push({ stateId: item.stateId, nodeId: item.nodeId, sectionId: item.sectionId, notesNodeId: notes?.id || null,
      hash: syncNodeHash(frame), notesHash: notes ? syncNodeHash(notes) : null, sourceHash: null });
  }
  return { schema: 1, fileKey: manifest.fileKey, pageNodeId: page.id, rootNodeId: root.id, states, routes,
    flowStartingPoints: page.flowStartingPoints.filter(f => syncWalk(root).some(n => n.id === f.nodeId)), capturedAt: new Date().toISOString() };
}

async function syncLoadExistingFonts(figma, nodes) {
  const fonts = new Map();
  for (const root of nodes) for (const n of syncWalk(root)) if (n.type === 'TEXT') {
    for (const s of n.getStyledTextSegments(['fontName'])) fonts.set(JSON.stringify(s.fontName), s.fontName);
  }
  for (const font of fonts.values()) await figma.loadFontAsync(font);
}

async function syncBuildNotes(figma, state, target, checkpoint) {
  const ids = [], controls = [];
  target.layoutMode = 'VERTICAL'; target.itemSpacing = 12;
  target.paddingTop = target.paddingBottom = target.paddingLeft = target.paddingRight = 16;
  target.primaryAxisSizingMode = 'FIXED'; target.counterAxisSizingMode = 'FIXED';
  target.fills = [{ type: 'SOLID', color: { r: .96, g: .97, b: .99 } }];
  target.clipsContent = true; target.overflowDirection = 'VERTICAL';
  const add = (text, bold = false, destinationId = null) => {
    const n = figma.createText(); target.appendChild(n); ids.push(n.id);
    n.name = destinationId ? `REF-LINK / ${state.id} / ${destinationId}` : 'REF-SYNC / 说明';
    n.fontName = { family: 'Noto Sans SC', style: bold ? 'Bold' : 'Regular' }; n.fontSize = bold ? 16 : 13;
    n.lineHeight = { unit: 'PIXELS', value: bold ? 24 : 21 };
    n.characters = text; n.resize(Math.max(1, target.width - 32), 20); n.textAutoResize = 'HEIGHT';
    n.fills = [{ type: 'SOLID', color: destinationId ? { r: .15, g: .3, b: .65 } : { r: .2, g: .24, b: .22 } }];
    if (destinationId) controls.push({ n, destinationId });
  };
  const t = state.transition || {};
  add(`${state.id} · ${state.title}`, true);
  add('入口与触发', true);
  add((t.from || []).map(f => `${f.id || ''} · ${f.label || ''}`).join('\n') || '组件独立标本');
  add((t.trigger?.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n') || '无固定触发步骤');
  if (state.condition) add(`当前条件：${state.condition}`);
  if (t.requires?.length) add(`前提：${t.requires.join('；')}`);
  add('后续分支 · 非必经顺序', true);
  for (const next of t.next || []) {
    const destinationId = checkpoint.states.find(s => s.stateId === next.id)?.nodeId;
    const kind = next.kind === 'event' || next.kind === 'system' ? '系统事件' : '操作/分支';
    add(`${kind} · ${next.text || next.label || ''}${next.id ? `\n→ ${next.id} · ${next.label || ''}` : '\n未采样，仅说明'}`, false, destinationId);
  }
  if (t.note) add(`边界：${t.note}`);
  add('来源：真实组件 fixture。此原型不执行后端操作。');
  for (const { n, destinationId } of controls) await n.setReactionsAsync([{ trigger: { type: 'ON_CLICK' }, actions: [
    { type: 'NODE', destinationId, navigation: 'NAVIGATE', transition: null, resetScrollPosition: true },
  ] }]);
  return ids;
}

/** Stage a complete update before replacing any managed content; roll back failed swaps. */
export async function applySync(figma, bundle, buildEditableScreens, options = {}) {
  if (bundle.schema !== 1 || !Array.isArray(bundle.states) || bundle.states.some(s => !s.scene)) throw new Error('Invalid sync package: full scenes required for writes');
  const checkpoint = JSON.parse(JSON.stringify(bundle.checkpoint));
  const { root, page, plan } = await inspectSync(figma, checkpoint, bundle.states);
  if (plan.conflicts.length) return { status: 'conflict', plan, createdNodeIds: [], mutatedNodeIds: [], checkpoint };
  const requested = options.stateIds ? new Set(options.stateIds) : null;
  if (requested && [...requested].some(id => !bundle.states.some(s => s.id === id))) throw new Error('Unknown selected state');
  const changed = plan.entries.filter(s => s.action === 'update' && (!requested || requested.has(s.stateId)));
  if (!changed.length) return { status: 'unchanged', plan, createdNodeIds: [], mutatedNodeIds: [], checkpoint };
  const createdNodeIds = [], mutatedNodeIds = [], staging = [], replacements = [], routeUpdates = [], skippedDisabled = [], skippedAbsent = [];
  const originalFlows = [...page.flowStartingPoints];
  const findState = id => checkpoint.states.find(s => s.stateId === id);
  let committed = false;
  try {
    const targets = [];
    for (const { stateId } of changed) {
      const anchor = findState(stateId), frame = await figma.getNodeByIdAsync(anchor.nodeId);
      const stage = figma.createFrame(); root.appendChild(stage); stage.name = `REF-V3 / staging / ${stateId}`;
      stage.visible = false; stage.resize(frame.width, frame.height); staging.push(stage);
      targets.push({ stateId, nodeId: stage.id });
      replacements.push({ anchor, frame, stage, old: [...frame.children] });
    }
    const result = await buildEditableScreens(figma, changed.map(s => bundle.states.find(b => b.id === s.stateId)), targets, { pageReady: true });
    createdNodeIds.push(...result.createdNodeIds);
    for (const replacement of replacements) {
      const { anchor, stage } = replacement;
      const all = syncWalk(stage), counts = new Map();
      const controls = all.map(n => {
        const occurrence = counts.get(n.name) || 0; counts.set(n.name, occurrence + 1);
        const control = result.controls.find(c => c.nodeId === n.id);
        return { n, name: n.name, occurrence, ...control };
      });
      for (const route of checkpoint.routes.filter(r => r.stateId === anchor.stateId)) {
        const matches = controls.filter(c => route.selector.testId ? c.testId === route.selector.testId : c.name === route.selector.name);
        const selected = matches[route.selector.occurrence || 0];
        if (!selected) {
          const scene = bundle.states.find(s => s.id === anchor.stateId).scene;
          const name = n => (n.tag==='text'?'文字 / ':n.tag==='svg'?'图标 / ':n.r==='button'||n.tag==='button'?'按钮 / ':'布局 / ')+(n.l||n.t||n.n);
          const hasSource = n => (route.selector.testId ? n.t === route.selector.testId : name(n) === route.selector.name) || (n.c || []).some(hasSource);
          if (typeof scene.tag === 'string' && !hasSource(scene)) {
            // Keep the route definition for a future reappearance, but do not
            // invent a clickable layer for a control absent from current source.
            skippedAbsent.push({ stateId: anchor.stateId, selector: route.selector });
            continue;
          }
          throw new Error(`Unresolved route: ${anchor.stateId} / ${JSON.stringify(route.selector)}. Update the explicit route map; no click behavior is guessed.`);
        }
        if (selected.disabled) { skippedDisabled.push({ stateId: anchor.stateId, name: selected.name }); continue; }
        const destinationId = route.targetStateId ? findState(route.targetStateId)?.nodeId : route.destinationId;
        if (route.type === 'NODE' && !destinationId) throw new Error(`Missing route target for ${anchor.stateId}`);
        const action = route.type === 'BACK' ? { type: 'BACK' } : { type: 'NODE', destinationId, navigation: 'NAVIGATE', transition: null, resetScrollPosition: true };
        await selected.n.setReactionsAsync([{ trigger: { type: 'ON_CLICK' }, actions: [action] }]);
        const same = controls.filter(c => selected.testId ? c.testId === selected.testId : c.name === selected.name);
        routeUpdates.push({ route, selector: { name: selected.name, ...(selected.testId ? { testId: selected.testId } : {}), occurrence: same.indexOf(selected) } });
      }
      if (anchor.notesNodeId) {
        const notes = await figma.getNodeByIdAsync(anchor.notesNodeId), noteStage = figma.createFrame(); root.appendChild(noteStage);
        noteStage.name = 'REF-SYNC / staging notes'; noteStage.visible = false; noteStage.resize(notes.width, notes.height); staging.push(noteStage);
        const content = figma.createFrame(); noteStage.appendChild(content); content.resize(notes.width, notes.height); createdNodeIds.push(content.id);
        createdNodeIds.push(...await syncBuildNotes(figma, bundle.states.find(s => s.id === anchor.stateId), content, checkpoint));
        replacement.notes = { frame: notes, stage: noteStage, old: [...notes.children] };
      }
    }
    await syncLoadExistingFonts(figma, replacements.flatMap(r => [r.frame, ...(r.notes ? [r.notes.frame] : [])]));
    for (const r of replacements) for (const slot of [r, ...(r.notes ? [r.notes] : [])]) {
      slot.new = [...slot.stage.children]; slot.backup = figma.createFrame(); root.appendChild(slot.backup); staging.push(slot.backup); slot.backup.visible = false;
      for (const old of slot.old) slot.backup.appendChild(old);
      for (const fresh of slot.new) slot.frame.appendChild(fresh);
      mutatedNodeIds.push(slot.frame.id);
    }
    for (const { anchor, frame, notes } of replacements) {
      anchor.hash = syncNodeHash(frame); anchor.notesHash = notes ? syncNodeHash(notes.frame) : null;
      anchor.sourceHash = syncSourceHash(bundle.states.find(s => s.id === anchor.stateId));
    }
    for (const { route, selector } of routeUpdates) route.selector = selector;
    // Reaction writes may introduce automatic flow points; preserve all original starts.
    page.flowStartingPoints = originalFlows;
    checkpoint.updatedAt = new Date().toISOString(); checkpoint.componentSourceHash = bundle.componentSourceHash;
    committed = true;
    const survivorIds = new Set(replacements.flatMap(r => [r.frame, ...(r.notes ? [r.notes.frame] : [])]).flatMap(syncWalk).map(n => n.id));
    return { status: 'updated', plan, updated: changed.map(s => s.stateId), skippedDisabled, skippedAbsent,
      createdNodeIds: createdNodeIds.filter(id => survivorIds.has(id)), mutatedNodeIds, checkpoint };
  } finally {
    if (!committed) {
      for (const r of [...replacements].reverse()) for (const slot of [r.notes, r].filter(Boolean)) if (slot.backup) {
        for (const n of slot.new || []) if (!n.removed) slot.stage.appendChild(n);
        for (const n of slot.old) if (!n.removed) slot.frame.appendChild(n);
      }
      page.flowStartingPoints = originalFlows;
    }
    for (const node of staging) if (!node.removed) node.remove();
  }
}
