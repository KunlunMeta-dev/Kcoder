import { unzipSync, strFromU8 } from 'fflate';
import { SaxesParser } from 'saxes';
import { posix } from 'node:path';
import { OfficeError } from './errors.mjs';
import { LIMITS } from './spec.mjs';

const PARTS = Object.freeze({
  docx: ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'],
  xlsx: ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'],
  pptx: ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/slides/slide1.xml']
});
function inspectArchive(bytes, expectedKind, budget, depth) {
  if (depth > 2 || !(bytes instanceof Uint8Array) || bytes.byteLength < 22 || bytes.byteLength > LIMITS.outputBytes) throw Error();
  const names = new Set();
  const parts = unzipSync(bytes, { filter(entry) {
    budget.entries += 1;
    if (budget.entries > LIMITS.archiveEntries || !Number.isSafeInteger(entry.originalSize)
      || entry.originalSize > LIMITS.archivePartBytes) throw Error();
    budget.expandedBytes += entry.originalSize;
    if (budget.expandedBytes > LIMITS.archiveExpandedBytes || names.has(entry.name)
      || entry.name.startsWith('/') || entry.name.includes('\\') || /^[A-Za-z]:/.test(entry.name)
      || entry.name.split('/').some(piece => piece === '..' || piece === '.')) throw Error();
    names.add(entry.name);
    return !entry.name.endsWith('/');
  } });
  const kind = Object.keys(PARTS).find(candidate => PARTS[candidate].every(name => Object.hasOwn(parts, name)));
  if (!kind || (expectedKind && expectedKind !== kind)) throw Error();
  for (const [name, content] of Object.entries(parts)) {
    if (/\.(?:xml|rels)$/i.test(name)) {
      const xml = strFromU8(content);
      if (/<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']External["']/i.test(xml)) throw Error();
      const parser = new SaxesParser({ xmlns: true });
      parser.on('error', () => { throw Error(); });
      parser.on('doctype', () => { throw Error(); });
      if (name.endsWith('.rels')) parser.on('opentag', tag => {
        if (tag.local !== 'Relationship') return;
        const attributes = Object.fromEntries(Object.values(tag.attributes).map(attribute => [attribute.local, attribute.value]));
        if (attributes.TargetMode === 'External' || typeof attributes.Target !== 'string') throw Error();
        const target = decodeURIComponent(attributes.Target.split('#')[0]);
        if (target.includes('\\') || target.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(target)) throw Error();
        const base = name === '_rels/.rels' ? '' : name.slice(0, name.lastIndexOf('/_rels/') + 1);
        const resolved = target.startsWith('/') ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(base, target));
        if (resolved.startsWith('../') || !Object.hasOwn(parts, resolved)) throw Error();
      });
      parser.write(xml).close();
    } else if (/vbaProject|\.exe$|\.dll$|\.bin$/i.test(name)) throw Error();
    else if (/\.(?:xlsx|docx|pptx)$/i.test(name)) inspectArchive(content, name.slice(-4), budget, depth + 1);
  }
  return kind;
}
export function inspectOffice(bytes, expectedKind) {
  try {
    const budget = { entries: 0, expandedBytes: 0 };
    const kind = inspectArchive(bytes, expectedKind, budget, 0);
    return { kind, entryCount: budget.entries, expandedBytes: budget.expandedBytes, structuralStatus: 'passed' };
  } catch {
    throw new OfficeError('OFFICE_INVALID_ARCHIVE', 'office.invalidArchive');
  }
}
