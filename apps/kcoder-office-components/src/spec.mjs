import { validatePngData } from './png.mjs';
import { fail } from './errors.mjs';

export const LIMITS = Object.freeze({
  inputBytes: 1024 * 1024,
  outputBytes: 20 * 1024 * 1024,
  // The encoded specification remains the shared 1 MiB authority. A second
  // lower aggregate text cap must not reject otherwise valid long documents.
  textCharacters: 1024 * 1024,
  paragraphs: 500,
  tables: 20,
  rows: 10_000,
  columns: 128,
  cells: 100_000,
  sheets: 16,
  slides: 60,
  archiveEntries: 512,
  archiveExpandedBytes: 64 * 1024 * 1024,
  archivePartBytes: 16 * 1024 * 1024,
  waitMs: 30_000
});

function object(value, allowed, required) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail();
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) fail();
  }
}

function text(value, max = 10_000, nonempty = true) {
  if (typeof value !== 'string' || Array.from(value).length > max || (nonempty && !value.trim())
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail();
}

function list(value, max, min = 0) {
  if (!Array.isArray(value) || value.length < min || Array.from(value).length > max) fail();
}

function scalar(value, column) {
  if (value === null) return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)) || column?.type === 'string' || column?.type === 'boolean' || column?.type === 'date') fail();
    return;
  }
  if (typeof value === 'boolean') {
    if (column && column.type !== 'boolean') fail();
    return;
  }
  text(value, 32_000, false);
  if (column?.type === 'number' || column?.type === 'boolean') fail();
  if (column?.type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')
    || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) fail();
}

export function validateFormula(value) {
  text(value, 1024);
  const expression = value.startsWith('=') ? value.slice(1) : value;
  if (!/^[A-Z0-9_.$:+*/^(),\s-]+$/i.test(expression)) fail('OFFICE_UNSAFE_FORMULA', 'office.unsafeFormula');
  const functions = [...expression.matchAll(/([A-Z_][A-Z0-9_.]*)\s*\(/gi)].map(match => match[1].toUpperCase());
  if (functions.some(name => !['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'ABS', 'ROUND'].includes(name))) {
    fail('OFFICE_UNSAFE_FORMULA', 'office.unsafeFormula');
  }
  return expression;
}

export function validateSpec(spec) {
  object(spec, ['schemaVersion','kind','title','sourceRefs','paragraphs','tables','sheets','slides','template'],
    ['schemaVersion','kind','title']);
  if (spec.schemaVersion !== 1 || !['docx', 'xlsx', 'pptx'].includes(spec.kind)) fail();
  text(spec.title, 200);
  if (spec.template !== undefined && !(spec.kind === 'docx' ? ['report','letter'] : spec.kind === 'pptx' ? ['briefing','minimal'] : []).includes(spec.template)) fail();
  if (spec.sourceRefs !== undefined) {
    list(spec.sourceRefs, 128);
    for (const value of spec.sourceRefs) text(value, 1024);
  }
  let textCount = spec.title.length;
  let cellCount = 0;
  const paragraphs = (items, max) => {
    list(items, max);
    for (const item of items) {
      object(item, ['text','heading','bullet'], ['text']);
      text(item.text, 10_000, false);
      textCount += item.text.length;
      if (item.heading !== undefined && (!Number.isInteger(item.heading) || item.heading < 1 || item.heading > 3)) fail();
      if (item.bullet !== undefined && typeof item.bullet !== 'boolean') fail();
    }
  };
  if (spec.kind === 'docx') {
    if (spec.sheets !== undefined || spec.slides !== undefined) fail();
    paragraphs(spec.paragraphs ?? [], LIMITS.paragraphs);
    list(spec.tables ?? [], LIMITS.tables);
    for (const table of spec.tables ?? []) {
      object(table, ['headers','rows'], ['headers','rows']);
      list(table.headers, LIMITS.columns, 1);
      for (const title of table.headers) { text(title, 200); textCount += title.length; }
      list(table.rows, 1000);
      for (const row of table.rows) {
        list(row, table.headers.length);
        if (row.length !== table.headers.length) fail();
        for (const value of row) { text(value, 10_000, false); textCount += value.length; }
        cellCount += row.length;
      }
    }
  } else if (spec.kind === 'xlsx') {
    if (spec.paragraphs !== undefined || spec.tables !== undefined || spec.slides !== undefined) fail();
    list(spec.sheets, LIMITS.sheets, 1);
    const names = new Set();
    for (const sheet of spec.sheets) {
      object(sheet, ['name','columns','rows','formulas'], ['name','columns','rows']);
      text(sheet.name, 31);
      if (/[*?:[\]\\/]/.test(sheet.name) || names.has(sheet.name.toLocaleLowerCase('en-US'))) fail();
      names.add(sheet.name.toLocaleLowerCase('en-US'));
      list(sheet.columns, LIMITS.columns, 1);
      const columnKeys = new Set();
      for (const column of sheet.columns) {
        object(column, ['key','title','type','numberFormat','unit'], ['key','title','type']);
        text(column.key, 100); text(column.title, 200);
        if (['__proto__','prototype','constructor'].includes(column.key) || columnKeys.has(column.key) || !['string','number','boolean','date'].includes(column.type)) fail();
        columnKeys.add(column.key);
        if (column.unit !== undefined) text(column.unit, 100);
        if (column.numberFormat !== undefined) {
          text(column.numberFormat, 64);
          if (!/^[0#.,% ()+;@:/-]+$/.test(column.numberFormat)) fail();
        }
      }
      list(sheet.rows, LIMITS.rows);
      for (const row of sheet.rows) {
        list(row, sheet.columns.length);
        if (row.length !== sheet.columns.length) fail();
        row.forEach((value, index) => scalar(value, sheet.columns[index]));
        cellCount += row.length;
      }
      list(sheet.formulas ?? [], 1000);
      const formulaCells = new Set();
      for (const item of sheet.formulas ?? []) {
        object(item, ['cell','formula'], ['cell','formula']);
        text(item.cell, 12);
        if (!/^[A-Z]{1,3}[1-9]\d{0,5}$/.test(item.cell) || formulaCells.has(item.cell) || Number(item.cell.match(/\d+$/)[0]) < 2 || Number(item.cell.match(/\d+$/)[0]) > LIMITS.rows + 1) fail();
        formulaCells.add(item.cell);
        validateFormula(item.formula);
      }
    }
  } else {
    if (spec.paragraphs !== undefined || spec.tables !== undefined || spec.sheets !== undefined) fail();
    list(spec.slides, LIMITS.slides, 1);
    for (const slide of spec.slides) {
      object(slide, ['title','paragraphs','notes','chart','images'], ['title','paragraphs']);
      text(slide.title, 200); textCount += slide.title.length;
      list(slide.paragraphs, 8);
      for (const paragraph of slide.paragraphs) { text(paragraph, 2000, false); textCount += paragraph.length; }
      const visibleCharacters = slide.paragraphs.reduce((total, value) => total + Array.from(value).length, 0);
      if (visibleCharacters > (slide.chart || slide.images?.length ? 160 : 400)) fail('OFFICE_LAYOUT_LIMIT', 'office.layoutLimit');
      if (slide.chart !== undefined) {
        if (slide.images?.length) fail();
        object(slide.chart, ['type','labels','series','unit'], ['type','labels','series']);
        if (!['bar','line','pie'].includes(slide.chart.type)) fail();
        list(slide.chart.labels, 20, 1); for (const label of slide.chart.labels) text(label, 50);
        list(slide.chart.series, slide.chart.type === 'pie' ? 1 : 4, 1);
        for (const series of slide.chart.series) {
          object(series, ['name','values'], ['name','values']); text(series.name, 80);
          list(series.values, slide.chart.labels.length); if (series.values.length !== slide.chart.labels.length) fail();
          for (const value of series.values) if (typeof value !== 'number' || !Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)) || (slide.chart.type === 'pie' && value < 0)) fail();
        }
        if (slide.chart.unit !== undefined) text(slide.chart.unit, 40);
      }
      if (slide.images !== undefined) {
        list(slide.images, 2);
        for (const image of slide.images) {
          object(image, ['data','alt'], ['data','alt']); text(image.alt, 200);
          validatePngData(image.data);
        }
      }
      if (slide.notes !== undefined) { text(slide.notes, 10_000, false); textCount += slide.notes.length; }
    }
  }
  if (textCount > LIMITS.textCharacters || cellCount > LIMITS.cells) fail('OFFICE_INPUT_TOO_LARGE', 'office.inputTooLarge');
  const encoded = JSON.stringify(spec);
  if (Buffer.byteLength(encoded) > LIMITS.inputBytes) fail('OFFICE_INPUT_TOO_LARGE', 'office.inputTooLarge');
  return spec;
}
