export function sample(kind) {
  const common = { schemaVersion: 1, kind, title: '专项工作核对报告', sourceRefs: ['material-01@1'] };
  if (kind === 'docx') return { ...common, paragraphs: [
    { text: '一、已确认事项', heading: 1 },
    { text: '核对金额为 1234.56 元；责任人待确认。' },
    { text: '材料包含 <原文> & 特殊字符，应保持文字。' }
  ], tables: [{ headers: ['事项', '金额', '状态'], rows: [['项目A', '1234.56', '待确认']] }] };
  if (kind === 'xlsx') return { ...common, sheets: [{
    name: '核对明细',
    columns: [{ key: 'item', title: '事项', type: 'string' }, { key: 'amount', title: '金额', type: 'number' }],
    rows: [['项目A', 1234.56], ['项目B', 200], ['=这是普通文本', null]],
    formulas: [{ cell: 'B5', formula: 'SUM(B2:B3)' }]
  }] };
  return { ...common, template: 'briefing', slides: [
    { title: '专项工作汇报', paragraphs: ['核对金额：1234.56 元', '责任人和日期：待确认'] },
    { title: '下一步', paragraphs: ['复核原始材料', '确认后形成正式版本'], chart: { type: 'bar', labels: ['项目A','项目B'], series: [{ name: '金额', values: [1234.56,200] }], unit: '元' } }
  ] };
}
