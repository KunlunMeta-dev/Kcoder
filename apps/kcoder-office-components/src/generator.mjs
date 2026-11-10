import { OfficeError } from './errors.mjs';
import { validateSpec } from './spec.mjs';

const FONT = 'Noto Sans SC';

async function docx(spec) {
  const lib = await import('docx');
  const children = [new lib.Paragraph({ text: spec.title, heading: lib.HeadingLevel.TITLE })];
  for (const item of spec.paragraphs ?? []) {
    children.push(new lib.Paragraph({
      children: [new lib.TextRun({ text: item.text, font: FONT })],
      ...(item.heading ? { heading: [null, lib.HeadingLevel.HEADING_1, lib.HeadingLevel.HEADING_2, lib.HeadingLevel.HEADING_3][item.heading] } : {}),
      ...(item.bullet ? { bullet: { level: 0 } } : {})
    }));
  }
  for (const table of spec.tables ?? []) {
    const rows = [table.headers, ...table.rows].map((row, rowIndex) => new lib.TableRow({
      children: row.map(value => new lib.TableCell({
        children: [new lib.Paragraph({ children: [new lib.TextRun({ text: value, font: FONT, bold: rowIndex === 0 })] })]
      }))
    }));
    children.push(new lib.Table({ rows, width: { size: 100, type: lib.WidthType.PERCENTAGE } }));
  }
  const document = new lib.Document({
    creator: 'KWorker',
    title: spec.title,
    description: 'Generated from the explicitly provided structured task material.',
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{ properties: { page: { margin: { top: spec.template === 'letter' ? 1440 : 1134, bottom: 1134, left: 1440, right: 1440 } } }, children }]
  });
  return lib.Packer.toBuffer(document);
}

async function xlsx(spec) {
  const imported = await import('exceljs');
  const lib = imported.default ?? imported;
  const book = new lib.Workbook();
  book.creator = 'KWorker';
  book.title = spec.title;
  book.calcProperties.fullCalcOnLoad = true;
  for (const source of spec.sheets) {
    const sheet = book.addWorksheet(source.name);
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.columns = source.columns.map(column => ({ header: column.unit ? `${column.title} (${column.unit})` : column.title, key: column.key, width: 24 }));
    sheet.getRow(1).font = { name: FONT, bold: true };
    for (const row of source.rows) {
      sheet.addRow(row.map((value, index) => value !== null && source.columns[index].type === 'date'
        ? new Date(value + 'T00:00:00.000Z') : value));
    }
    source.columns.forEach((column, index) => {
      if (column.type === 'date') sheet.getColumn(index + 1).numFmt = 'yyyy-mm-dd';
      else if (column.numberFormat) sheet.getColumn(index + 1).numFmt = column.numberFormat;
    });
    for (const item of source.formulas ?? []) {
      const formula = item.formula.startsWith('=') ? item.formula.slice(1) : item.formula;
      sheet.getCell(item.cell).value = { formula };
    }
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: source.columns.length } };
  }
  return book.xlsx.writeBuffer();
}

async function pptx(spec) {
  const imported = await import('pptxgenjs');
  const Pptx = imported.default ?? imported;
  const presentation = new Pptx();
  presentation.layout = 'LAYOUT_WIDE';
  presentation.author = 'KWorker';
  presentation.subject = 'Structured task material';
  presentation.title = spec.title;
  presentation.company = 'KunlunMeta';
  presentation.lang = 'zh-CN';
  presentation.theme = { headFontFace: FONT, bodyFontFace: FONT, lang: 'zh-CN' };
  for (const source of spec.slides) {
    const slide = presentation.addSlide();
    slide.background = { color: 'FFFFFF' };
    if (spec.template === 'briefing') slide.addShape(presentation.ShapeType.line, { x: 0.6, y: 1.22, w: 12.1, h: 0, line: { color: 'C9CDD2', width: 1 } });
    slide.addText(source.title, { x: 0.6, y: 0.4, w: 12.1, h: 0.7, fontFace: FONT, fontSize: 28, color: '202124', bold: true, margin: 0 });
    const paragraphs = source.paragraphs.map(text => ({
      text,
      options: { breakLine: true, paraSpaceAfter: 8, bullet: { indent: 20 } }
    }));
    slide.addText(paragraphs, { x: 0.75, y: 1.5, w: source.chart ? 4.0 : 11.8, h: source.images?.length ? 1.4 : 5.2, fontFace: FONT, fontSize: 20, color: '303134', margin: 0.05, valign: 'top' });
    if (source.chart) {
      slide.addChart(presentation.ChartType[source.chart.type], source.chart.series.map(series => ({ name: series.name, labels: source.chart.labels, values: series.values })), {
        x: 5.1, y: 1.5, w: 7.5, h: 4.9, showLegend: source.chart.series.length > 1, showValue: true,
        showCatName: source.chart.type === 'pie', showTitle: Boolean(source.chart.unit), title: source.chart.unit,
        chartColors: ['376A9C','848D97','B5BDC5','515C67'], showBorder: false, catAxisLabelFontFace: FONT,
        catAxisLabelFontSize: 12, valAxisLabelFontFace: FONT, valAxisLabelFontSize: 12, legendFontFace: FONT, legendFontSize: 12
      });
    }
    for (const [index, image] of (source.images ?? []).entries()) {
      const x = 0.75 + index * 6.1; const w = source.images.length === 1 ? 11.8 : 5.7;
      slide.addImage({ data: image.data, x, y: 3.0, w, h: 3.7, sizing: { type: 'contain', w, h: 3.7 }, altText: image.alt });
    }
    if (source.notes) slide.addNotes(source.notes);
  }
  return presentation.write({ outputType: 'nodebuffer', compression: true });
}

export async function generateBytes(input) {
  const spec = validateSpec(input);
  try {
    return new Uint8Array(await ({ docx, xlsx, pptx })[spec.kind](spec));
  } catch (error) {
    if (error instanceof OfficeError) throw error;
    if (error?.code === 'ERR_MODULE_NOT_FOUND') throw new OfficeError('OFFICE_DEPENDENCY_UNAVAILABLE', 'office.dependencyUnavailable');
    throw new OfficeError('OFFICE_GENERATION_FAILED', 'office.generationFailed');
  }
}
