import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';
import { repoRoot } from './run-context.mjs';
const { JSDOM } = createRequire(resolve(repoRoot, 'apps/kcoder-studio/renderer/package.json'))('jsdom');
export const OFFICE_SOURCE_FILES = Object.freeze(['meeting.md', 'sales.csv', 'pilot-a.md', 'pilot-b.md', 'presentation.md'].map(name => `sources/${name}`));
export const OFFICE_PRESENTATION = Object.freeze({ version: 1, studioWorkMode: 'kworker', inlineWidgets: true });
const base = 'Work only in the current owned workspace. Preserve all sources. No internet, network, installation, credential access, schedules or subagents. This test requests real deliverable files, not just a chat description. Use available file tools. Any inline visualization must use the attached show_widget tool in managed mode. Finish with concise results and the returned widget references.';
export function officeCases(marker) {
  return [
    { id: 'documents', requiredSources: ['sources/meeting.md'], files: ['meeting-summary.md', 'meeting.json'], prompt: `${base}\nRead sources/meeting.md. Create deliverables/meeting-summary.md and deliverables/meeting.json. Summarize decisions, owners, deadlines and uncertainty. JSON fields: marker (the source marker), pilotDate, publicRelease (undecided), pendingQuoteAmount (null), actions:[{owner,due}]. Keep the source's exact ISO dates and owner names. Include marker ${marker} in both deliverables.` },
    { id: 'sheets', requiredSources: ['sources/sales.csv'], files: ['sales-analysis.md', 'sales.json'], prompt: `${base}\nAnalyze sources/sales.csv, whose money unit is 10000 CNY. Write deliverables/sales-analysis.md and deliverables/sales.json with fields marker, annualRevenue, annualCost, annualProfit, profitMargin (a fraction, keep enough decimal precision), quarterRevenue (array in Q1..Q4 order). Explain units and distinguish source YoY values from calculations. Include marker ${marker}.` },
    { id: 'research', requiredSources: ['sources/pilot-a.md','sources/pilot-b.md'], files: ['research.md', 'research.json'], prompt: `${base}\nUse only sources/pilot-a.md and sources/pilot-b.md. Write deliverables/research.md with both source filenames cited, measured facts, uncertainty and next evidence needed. Write deliverables/research.json: marker, timeReductionPercent, causalConclusion (boolean), externalCustomersSupported (boolean), limitations (at least two strings), citations:[{source,quote}] with nonempty exact quotes from each original file. Include marker ${marker}.` },
    { id: 'presentation', requiredSources: ['sources/presentation.md','sources/pilot-a.md','sources/pilot-b.md','sources/sales.csv'], files: ['presentation.html', 'presentation.json'], prompt: `${base}\nRead sources/presentation.md, sources/pilot-a.md, sources/pilot-b.md and sources/sales.csv. Create an offline HTML presentation deliverables/presentation.html with three clearly titled sections for observed results, limits and next steps. Include original source filenames and marker ${marker}. Also write deliverables/presentation.json: marker, sectionCount (3), principal (560000), annualRate (8.5 percent), years (7), total and earnings (calculated CNY). Create three inline managed views: an SVG relation diagram, a Chart.js quarterly bar chart whose revenue series is Q1..Q4, and the registered compound-interest recipe with those sample parameters. These are illustrative parameters, not forecasts. Use only local managed declarations, no model JavaScript or external resources.` },
  ];
}
export async function officeSourceHashes(workspace) {
  const rows = await Promise.all(OFFICE_SOURCE_FILES.map(async path => [path, createHash('sha256').update(await readFile(resolve(workspace, path))).digest('hex')]));
  return Object.fromEntries(rows);
}
export async function readOfficeOutput(workspace, name) {
  const file = resolve(workspace, 'deliverables', name), root = await realpath(workspace);
  const actual = await realpath(file), stat = await lstat(file);
  assert.ok(actual.startsWith(root + sep) && stat.isFile() && !stat.isSymbolicLink(), 'deliverable must be a contained regular file');
  assert.ok(stat.size > 0 && stat.size <= 65536, 'deliverable size must be bounded');
  return readFile(file, 'utf8');
}
export async function validateOfficeCase(workspace, task, marker) {
  const artifacts = Object.fromEntries(await Promise.all(task.files.map(async file => [file, await readOfficeOutput(workspace, file)])));
  const json = JSON.parse(artifacts[task.files.find(name => name.endsWith('.json'))]);
  assert.equal(json.marker, marker);
  if (task.id === 'documents') {
    assert.equal(json.pilotDate, '2026-10-01'); assert.equal(json.publicRelease, 'undecided'); assert.equal(json.pendingQuoteAmount, null);
    assert.ok(json.actions.some(item => item.owner === 'Lin Lan' && item.due === '2026-09-25'));
    assert.ok(json.actions.some(item => item.owner === 'Xu Chen' && item.due === '2026-09-28'));
  } else if (task.id === 'sheets') {
    assert.equal(json.annualRevenue, 615); assert.equal(json.annualCost, 372); assert.equal(json.annualProfit, 243);
    assert.ok(Number.isFinite(json.profitMargin) && Math.abs(json.profitMargin - 243 / 615) < 1e-7); assert.deepEqual(json.quarterRevenue, [128,156,142,189]);
  } else if (task.id === 'research') {
    assert.equal(json.timeReductionPercent, 30); assert.equal(json.causalConclusion, false); assert.equal(json.externalCustomersSupported, false);
    assert.ok(Array.isArray(json.limitations) && json.limitations.length >= 2 && json.limitations.every(item => typeof item === 'string' && item.trim()));
    for (const file of ['sources/pilot-a.md', 'sources/pilot-b.md']) {
      const source = await readFile(resolve(workspace, file), 'utf8');
      assert.ok(json.citations.some(citation => citation.source === file && typeof citation.quote === 'string' && citation.quote.trim().length >= 12 && source.includes(citation.quote)));
      assert.ok(artifacts['research.md'].includes(file.split('/').at(-1)));
    }
  } else {
    assert.equal(json.sectionCount, 3); assert.equal(json.principal, 560000); assert.equal(json.annualRate, 8.5); assert.equal(json.years, 7);
    const total = 560000 * 1.085 ** 7;
    assert.ok(Number.isFinite(json.total) && Math.abs(json.total - total) < 0.02); assert.ok(Number.isFinite(json.earnings) && Math.abs(json.earnings - (total - 560000)) < 0.02);
    const doc = new JSDOM(artifacts['presentation.html']).window.document;
    assert.ok(doc.querySelectorAll('section').length === 3 || doc.querySelectorAll('h1,h2').length >= 3);
    assert.equal(doc.querySelectorAll('script:not([type="application/json"]),iframe,form,link[href]').length, 0);
    assert.ok(artifacts['presentation.html'].includes(marker));
    assert.ok(artifacts['presentation.html'].includes('pilot-a.md') && artifacts['presentation.html'].includes('pilot-b.md'));
    doc.defaultView.close();
  }
  return { files: task.files.map(name => ({ name, bytes: Buffer.byteLength(artifacts[name]), sha256: createHash('sha256').update(artifacts[name]).digest('hex') })), arithmeticAndProvenanceValidated: true };
}
export function validateOfficeWidgets(widgets) {
  const svg = widgets.find(item => item.widget.format === 'svg' && item.source.includes('<svg'));
  assert.ok(svg, 'real model must create an actual SVG artifact');
  let chart = false, compound = false;
  for (const { widget, source } of widgets) {
    assert.equal(widget.executionMode, 'managed');
    const doc = new JSDOM(source).window.document;
    for (const script of doc.querySelectorAll('script[data-kcoder-chart][type="application/json"]')) {
      const value = JSON.parse(script.textContent);
      if (widget.libraries.includes('chart_js') && value.data?.labels?.join(',') === 'Q1,Q2,Q3,Q4' && value.data?.datasets?.some(series => JSON.stringify(series.data) === '[128,156,142,189]')) chart = true;
    }
    for (const element of doc.querySelectorAll('[data-kcoder-recipe="compound-interest"]')) {
      const config = JSON.parse(element.querySelector('script[data-kcoder-config][type="application/json"]')?.textContent ?? 'null');
      if (config?.principal === 560000 && config.annualRate === 8.5 && config.years === 7 && config.currency === 'CNY') compound = true;
    }
    doc.defaultView.close();
  }
  assert.ok(chart, 'real model chart must preserve the source series/quarter order');
  assert.ok(compound, 'real model calculator must use the requested parameters and currency');
  return { svg: true, chart: true, compound: true, claimBoundary: 'committed model-generated source/data validated; rendering/interaction requires separate real browser/native evidence' };
}
