// Ported from Octop skillhub_market.py, dd9dce4; MIT, third_party/octop/LICENSE.
// Preview metadata never creates a task or grants execution authority.
const colors = ['#e8f4ff', '#fef3c7', '#dcfce7', '#f1f5f9', '#fff1f2', '#eef2ff']
const defaults = [
  [
    '开始处理任务',
    'Start a task',
    '描述目标与上下文，马上开始',
    'Describe the goal and start now',
    'zap',
  ],
  [
    '先制定计划',
    'Make a plan',
    '先拆步骤、材料与交付物',
    'Break down steps and deliverables',
    'list-todo',
  ],
  [
    '分析现状',
    'Analyze status',
    '梳理问题、风险与优先级',
    'Review issues, risks, and priorities',
    'activity',
  ],
  [
    '产出结果',
    'Produce result',
    '直接生成可交付成果',
    'Generate a ready-to-use deliverable',
    'presentation',
  ],
  ['优化修改', 'Refine output', '基于反馈迭代改进', 'Iterate based on feedback', 'sparkles'],
  [
    '答疑澄清',
    'Ask & clarify',
    '先问清关键细节再继续',
    'Clarify key details before continuing',
    'message-square',
  ],
]
function clip(value: string, length: number) {
  const chars = Array.from(value.replace(/\s+/g, ' ').trim())
  return chars.length <= length
    ? chars.join('')
    : chars
        .slice(0, length - 1)
        .join('')
        .trimEnd() + '…'
}
function cleanLine(line: string) {
  return line
    .trim()
    .replace(/^\s*[-*]\s+/, '- ')
    .replaceAll('**', '')
    .replaceAll('`', '')
    .trim()
}
function outputTarget(section: string) {
  for (const line of section.split(/\r?\n/)) {
    const clean = cleanLine(line)
    if (/^输出/.test(clean))
      return clean.replace(/^输出物?/, '').replace(/^[ ：:。]+|[ ：:。]+$/g, '')
  }
  return ''
}
function description(section: string) {
  const output = outputTarget(section)
  if (output) return /^(生成|输出|给出|形成|交付)/.test(output) ? output : `生成${output}`
  for (const line of section.split(/\r?\n/)) {
    const clean = cleanLine(line)
    if (clean.startsWith('- ')) return clean.slice(2).trim().replace(/。+$/, '')
  }
  return ''
}
function icon(title: string, section: string, index: number) {
  const text = `${title}\n${section}`
  const groups: [string[], string][] = [
    [['巡检', '健康', '诊断', '异常', '日志', '监控', '分析'], 'activity'],
    [['评分', '指标', '数据', '统计', '预算', '投研', '经营', '趋势'], 'trending-up'],
    [['修复', '调试', '排查', '配置', '风险'], 'wrench'],
    [['云', '实例', 'OS', '服务器', '集群', '节点'], 'server'],
    [['代码', '测试', '脚本', '命令', '自动化'], 'terminal'],
    [['视频', '分镜', '镜头', '画面', '剪辑', '脚本'], 'video'],
    [['合同', '文书', '报告', '纪要', '简历', '法条'], 'file-text'],
    [['检索', '搜索', '法规', '跨境', '市场'], 'globe'],
    [['计划', '方案', '策略', 'SOP', '流程', '清单'], 'list-todo'],
    [['输出', '生成', '导出', 'PPT', 'PDF', '交付'], 'presentation'],
  ]
  return (
    groups.find(([words]) => words.some(word => text.includes(word)))?.[1] ??
    [
      'zap',
      'list-todo',
      'activity',
      'file-text',
      'presentation',
      'sparkles',
      'message-square',
      'book-open',
      'globe',
    ][index % 9]
  )
}
export function marketQuickPrompts(content: string, language = 'zh-CN') {
  // Native may return English headings when English content is selected.
  const matches = [...content.matchAll(/^##\s*(?:步骤|Step)\s*(\d+)\s*[：:]\s*(.+?)\s*$/gim)]
  const cards = matches
    .slice(0, 6)
    .map((match, index) => {
      const title = match[2]
        .replace(/[（(][^）)]*层[）)]/g, '')
        .trim()
        .replace(/^[ ：:-]+|[ ：:-]+$/g, '')
      const section = content
        .slice(match.index! + match[0].length, matches[index + 1]?.index ?? content.length)
        .trim()
      const output = outputTarget(section)
      return {
        zhTitle: clip(title, 16),
        enTitle: /[\u3400-\u9fff]/.test(title) ? `Workflow step ${index + 1}` : clip(title, 24),
        zhDescription: clip(description(section), 28) || `完成「${clip(title, 16)}」`,
        enDescription: clip(
          output && !/[\u3400-\u9fff]/.test(output) ? output : 'Share context for a ready result',
          40
        ),
        icon: icon(title, section, index),
        color: colors[index % colors.length],
      }
    })
    .filter(card => card.zhTitle)
  for (const [
    index,
    [zhTitle, enTitle, zhDescription, enDescription, glyph],
  ] of defaults.entries()) {
    if (cards.length >= 6) break
    if (!cards.some(card => card.zhTitle === zhTitle && card.enTitle === enTitle))
      cards.push({
        zhTitle,
        enTitle,
        zhDescription,
        enDescription,
        icon: glyph,
        color: colors[index],
      })
  }
  return cards.map(card => ({
    title: language.startsWith('zh') ? card.zhTitle : card.enTitle,
    description: language.startsWith('zh') ? card.zhDescription : card.enDescription,
    icon: card.icon,
    color: card.color,
  }))
}
