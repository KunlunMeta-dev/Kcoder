// Self-contained so the same renderer can be embedded in the offline browser viewer.
export function transitionHtml(state, standalone = false) {
  if (!state.transition) return "";
  const h = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const t = state.transition;
  const node = item => item.id
    ? `<a class="state-link" href="${standalone ? "./" + h(item.id) + ".html" : "#" + h(item.id)}" ${standalone ? "" : `data-state="${h(item.id)}"`} aria-label="查看 ${h(item.id)} ${h(item.label)} 的状态说明">${h(item.label)} <small>${h(item.id)}</small></a>`
    : `<span class="unsampled">${h(item.label)} <small>未采样／无独立截图</small></span>`;
  const kind = { action: "用户操作", event: "系统事件", mixed: "操作 + 条件／事件" };
  return `<section class="transition" aria-label="状态触发链" data-transition="${h(state.id)}"><h3>这个状态怎么出现</h3><p class="transition-summary">入口 → 触发 → 当前状态 → 后续去向</p><div class="transition-part"><h4>从哪里进入</h4><div class="state-links">${t.from.map(node).join("")}</div></div><div class="transition-part"><h4><span class="trigger-kind ${h(t.trigger.kind)}">${kind[t.trigger.kind]}</span></h4><ol>${t.trigger.steps.map(text => `<li>${h(text)}</li>`).join("")}</ol>${t.requires.length ? `<p class="trigger-requires"><b>前提：</b>${t.requires.map(h).join("；")}</p>` : ""}</div><div class="transition-current"><small>当前状态</small><strong>${h(state.id)} · ${h(state.title)}</strong></div><div class="transition-part"><h4>之后可以去哪里</h4><ul class="next-states">${t.next.map(item => `<li><span class="trigger-kind ${h(item.kind)}">${kind[item.kind]}</span><span>${h(item.text)}<br>→ ${node(item)}</span></li>`).join("")}</ul></div>${t.note ? `<p class="transition-note">${h(t.note)}</p>` : ""}<p class="transition-boundary">链接只切换图册说明，不执行截图里的操作。分支按实际条件发生。</p></section>`;
}

export function transitionMarkdown(state) {
  if (!state.transition) return "";
  const t = state.transition;
  const link = node => node.id ? `[${node.label}（${node.id}）](../states/${node.id}.html)` : `${node.label}（未采样／无独立截图）`;
  const kind = { action: "用户操作", event: "系统事件", mixed: "操作 + 条件／事件" };
  return ["## 入口与触发链", "", "从哪里进入：", ...t.from.map(node => `- ${link(node)}`), "", `触发类型：${kind[t.trigger.kind]}`,
    ...t.trigger.steps.map((text, i) => `${i + 1}. ${text}`), ...(t.requires.length ? ["", `前提：${t.requires.join("；")}`] : []),
    "", `当前状态：${state.id} · ${state.title}`, "", "后续去向（条件分支，不是必经顺序）：", ...t.next.map(node => `- ${kind[node.kind]}：${node.text} → ${link(node)}`),
    "", t.note, "", "图册链接只跳转状态说明，不执行业务操作。", ""].join("\n");
}
