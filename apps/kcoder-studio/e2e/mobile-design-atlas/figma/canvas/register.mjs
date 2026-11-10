import { inspectSync, syncNodeHash, syncWalk } from '../sync/core.mjs';

/** Explicit anchor registration only; caller supplies reviewed state IDs/routes.
 * Bundle after sync/core.mjs for the Plugin API. Existing frames are never adopted.
 */
export async function registerReferenceAnchors(figma, checkpoint, definitions, sectionName) {
  if (!definitions.length || !sectionName.startsWith('REF-V3 / ')) throw new Error('Missing explicit REF registration');
  const ids = new Set(definitions.map(state => state.id));
  if (ids.size !== definitions.length || definitions.some(state => !/^[A-Z][A-Z0-9-]+$/.test(state.id)
    || checkpoint.states.some(anchor => anchor.stateId === state.id))) throw new Error('Duplicate/invalid registered state');
  const { root, page, plan } = await inspectSync(figma, checkpoint,
    checkpoint.states.map(anchor => ({ id: anchor.stateId, sourceHash: anchor.sourceHash || '0000000000000000' })));
  if (plan.conflicts.length) throw new Error('Existing REF content changed; registration stopped before writes');
  if (root.children.some(node => node.name === sectionName) || syncWalk(root).some(node => definitions.some(state => node.name.startsWith(`REF-V3 / ${state.id} / `)))) {
    throw new Error('Unrecorded REF registration exists; read its receipt before retrying');
  }
  await figma.loadFontAsync({ family: 'Noto Sans SC', style: 'Regular' });
  await figma.loadFontAsync({ family: 'Noto Sans SC', style: 'Bold' });
  const original = { width: root.width, height: root.height, flows: [...page.flowStartingPoints] };
  const created = [], anchors = [];
  const track = node => { created.push(node.id); return node; };
  let section, committed = false;
  const text = (parent, name, value, x, y, width, size = 16) => {
    const node = track(figma.createText()); parent.appendChild(node); node.name = name;
    node.fontName = { family: 'Noto Sans SC', style: size >= 20 ? 'Bold' : 'Regular' };
    node.fontSize = size; node.characters = value; node.resize(width, size * 1.6); node.textAutoResize = 'HEIGHT';
    node.fills = [{ type: 'SOLID', color: { r: .15, g: .2, b: .28 } }]; node.x = x; node.y = y;
    return node;
  };
  try {
    section = track(figma.createSection()); root.appendChild(section); section.name = sectionName;
    section.x = 32; section.y = original.height;
    section.resizeWithoutConstraints(Math.max(3232, root.width - 64), 152 + Math.ceil(definitions.length / 4) * 956 - 28);
    text(section, 'REF / 新增分区标题', sectionName, 24, 24, 3100, 24);
    text(section, 'REF / 新增分区说明', '当前源码新增状态；点击画板旁注查看入口、条件与去向。', 24, 70, 3100);
    for (const [index, state] of definitions.entries()) {
      const x = 24 + index % 4 * 800, y = 152 + Math.floor(index / 4) * 956;
      text(section, `REF / ${state.id} / 标题`, `${state.id} · ${state.title}`, x, y - 36, 760);
      const frame = track(figma.createFrame()); section.appendChild(frame);
      frame.name = `REF-V3 / ${state.id} / ${state.title}`; frame.resize(390, 844); frame.x = x; frame.y = y;
      frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]; frame.clipsContent = true;
      const notes = track(figma.createFrame()); section.appendChild(notes);
      notes.name = `REF-NOTES / ${state.id} / 触发与去向`; notes.resize(350, 844); notes.x = x + 414; notes.y = y;
      notes.fills = [{ type: 'SOLID', color: { r: .96, g: .97, b: .99 } }]; notes.clipsContent = true;
      anchors.push({ stateId: state.id, nodeId: frame.id, notesNodeId: notes.id, sectionId: section.id,
        hash: syncNodeHash(frame), notesHash: syncNodeHash(notes), sourceHash: null });
    }
    root.resizeWithoutConstraints(original.width, section.y + section.height + 32);
    page.flowStartingPoints = original.flows;
    committed = true;
    return { createdNodeIds: created, mutatedNodeIds: [root.id], sectionId: section.id,
      checkpoint: { ...checkpoint, states: [...checkpoint.states, ...anchors], updatedAt: new Date().toISOString() },
      pendingStates: definitions.map(state => state.id) };
  } finally {
    if (!committed) {
      if (section && !section.removed) section.remove();
      root.resizeWithoutConstraints(original.width, original.height); page.flowStartingPoints = original.flows;
    }
  }
}
