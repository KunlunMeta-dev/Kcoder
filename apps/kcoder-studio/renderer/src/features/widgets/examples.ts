/** Deterministic examples shared by browser acceptance and the office skill. */
export const WIDGET_EXAMPLES = {
  overview: {
    title: '可视化类型',
    format: 'svg' as const,
    summary: '图示、图表、地图、交互组件、界面原型与插画演示。',
    libraries: [],
    source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 840 260" role="img"><title>六种可视化类型</title><desc>两排三列：图示、图表、地图、交互组件、界面原型、插画演示。点击可把追问放入输入框。</desc><style>.label{fill:var(--foreground);font-family:var(--font-ui);text-anchor:middle}.box{fill:var(--background);stroke:var(--border)}.tile:focus .box{stroke:var(--primary);stroke-width:2}</style><g class="tile" data-kcoder-prompt="画一个检索流程图" aria-label="图示"><rect class="box" x="24" y="20" width="240" height="90" rx="12"/><text class="label" x="144" y="58">图示 Diagram</text><text class="label" x="144" y="84">流程 · 架构 · 关系</text></g><g class="tile" data-kcoder-prompt="用示例数据制作一个组合图" aria-label="图表"><rect class="box" x="300" y="20" width="240" height="90" rx="12"/><text class="label" x="420" y="58">图表 Chart</text><text class="label" x="420" y="84">柱 · 折线 · 饼 · 散点</text></g><g class="tile" data-kcoder-prompt="展示一张有真实拓扑来源的地图" aria-label="地图"><rect class="box" x="576" y="20" width="240" height="90" rx="12"/><text class="label" x="696" y="58">地图 Map</text><text class="label" x="696" y="84">真实地理拓扑</text></g><g class="tile" data-kcoder-prompt="做一个复利试算器" aria-label="交互组件"><rect class="box" x="24" y="150" width="240" height="90" rx="12"/><text class="label" x="144" y="188">交互组件</text><text class="label" x="144" y="214">滑块 · 步进 · 开关</text></g><g class="tile" data-kcoder-prompt="展示一个办公界面原型" aria-label="界面原型"><rect class="box" x="300" y="150" width="240" height="90" rx="12"/><text class="label" x="420" y="188">界面原型</text><text class="label" x="420" y="214">网页与 App 外观</text></g><g class="tile" data-kcoder-prompt="用动画解释一个原理" aria-label="插画演示"><rect class="box" x="576" y="150" width="240" height="90" rx="12"/><text class="label" x="696" y="188">插画演示</text><text class="label" x="696" y="214">原理与动画</text></g></svg>`,
  },
  revenue: {
    title: '季度营收与同比增速',
    format: 'html' as const,
    summary: '季度营收为128、156、142、189万元；同比增速为8%、21%、-9%、33%。蓝色柱对应左轴，红色虚线及方形点对应右轴。示例数据。',
    libraries: ['chart_js'],
    source: `<script type="application/json" data-kcoder-chart aria-label="季度营收（万元，左轴）和同比增速（%，右轴）；示例数据">${JSON.stringify({
      type: 'bar',
      data: { labels: ['Q1', 'Q2', 'Q3', 'Q4'], datasets: [
        { label: '季度营收（万元，柱）', data: [128, 156, 142, 189], backgroundColor: '#3589df', yAxisID: 'revenue', borderRadius: 3, order: 2 },
        { type: 'line', label: '同比增速（%，折线与方点）', data: [8, 21, -9, 33], borderColor: '#e84a4a', backgroundColor: '#e84a4a', borderDash: [6, 4], pointStyle: 'rect', pointRadius: 5, yAxisID: 'growth', order: 1 },
      ] },
      options: { scales: { revenue: { type: 'linear', position: 'left', beginAtZero: true, title: { display: true, text: '营收（万元）' } }, growth: { type: 'linear', position: 'right', min: -10, max: 35, grid: { drawOnChartArea: false }, title: { display: true, text: '同比增速（%）' } } } },
    })}</script>`,
  },
  compound: {
    title: '复利试算器',
    format: 'html' as const,
    summary: '本金56万元，年化8.5%，投资7年；滑块与数值输入同步，收益按本金×(1+年化收益率)^年数计算。',
    libraries: [],
    source: '<div id="savings" data-kcoder-recipe="compound-interest"><script type="application/json" data-kcoder-config>{"principal":560000,"annualRate":8.5,"years":7,"currency":"CNY"}</script></div>',
  },
  world: {
    title: '世界地区示例数据',
    format: 'html' as const,
    summary: '使用Natural Earth真实拓扑；中国10、美国20为示例值，其余地区无数据。支持缩放、复位和经纬度标注。',
    libraries: ['d3', 'topojson'],
    source: '<script id="world" type="application/json" data-kcoder-map>{"values":{"156":10,"840":20},"unit":" 示例值","markers":[{"label":"零度交点","longitude":0,"latitude":0}]}</script>',
  },
  prototype: {
    title: '文档整理界面原型',
    format: 'html' as const,
    summary: '文档列表与整理入口的静态界面示意；点击入口只将建议放入输入框。',
    libraries: [],
    source: '<section><h2>我的资料</h2><p>待整理 3 份 · 已完成 12 份</p><table><thead><tr><th>文档</th><th>状态</th></tr></thead><tbody><tr><td>会议纪要</td><td>待整理</td></tr><tr><td>季度总结</td><td>已完成</td></tr></tbody></table><p data-kcoder-prompt="帮我整理选中的会议纪要">整理会议纪要 →</p></section>',
  },
  animation: {
    title: '资料流转演示',
    format: 'svg' as const,
    summary: '圆点从资料进入检索再到回答；遵循减少动画设置。',
    libraries: [],
    source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 120" role="img"><title>资料流转演示</title><desc>资料经过检索得到回答</desc><style>@keyframes travel{from{transform:translateX(0)}to{transform:translateX(400px)}}.flow{animation:travel 4s linear infinite}</style><path d="M80 60H500" stroke="var(--border)" stroke-width="2"/><circle class="flow" cx="80" cy="60" r="8" fill="var(--primary)"/><g fill="var(--foreground)" text-anchor="middle"><text x="80" y="100">资料</text><text x="300" y="100">检索</text><text x="500" y="100">回答</text></g></svg>',
  },
}
