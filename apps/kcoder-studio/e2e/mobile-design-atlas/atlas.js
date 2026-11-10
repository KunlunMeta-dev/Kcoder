// All data and images are packaged locally. No backend or production storage is used.
(() => {
  const data = window.ATLAS;
  const $ = id => document.getElementById(id);
  const h = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let group = "all", tab = "states", query = "", showArchive = true, version = data.v3Only ? "V3" : "all", current = null, variant = 0;
  const get = id => data.states.find(state => state.id === id);
  const tag = (text, cls = "") => `<span class="tag ${cls}">${h(text)}</span>`;
  const links = state => `<a class="button" href="${h(state.variants[variant]?.image || state.variants[0].image)}" download>下载原始 PNG</a><a class="button" href="states/${h(state.id)}.html" target="_blank" rel="noopener">独立说明页 ↗</a><button class="secondary" data-copy="${h(state.id)}">复制 AI 设计任务</button><a href="briefs/${h(state.id)}.md" download>说明文件</a>`;
  function renderNav() {
    $("nav").innerHTML = [["all", "全部状态"], ...data.groups.map(([id, name]) => [id, name])].map(([id, name]) => `<button data-group="${id}" class="${group === id ? "active" : ""}" ${group === id ? 'aria-current="true"' : ""}><span>${h(name)}</span><small>${id === "all" ? data.states.length : data.states.filter(s => s.group === id).length}</small></button>`).join("");
  }
  function render() {
    renderNav();
    document.querySelectorAll("[data-tab]").forEach(node => { node.classList.toggle("active", node.dataset.tab === tab); node.setAttribute("aria-selected", String(node.dataset.tab === tab)); });
    $("filters").hidden = !["states", "updates"].includes(tab);
    const content = $("content");
    if (tab === "flows" && data.states.every(s => s.transition)) {
      content.innerHTML = `<p class="hint">每行是一条条件分支。“用户操作”和“系统事件”分开标注，链接只切换状态说明。未采样页面没有虚构截图，多个结果不会依次发生。</p>` + data.groups.map(([id, name]) => `<section class="flow"><h3>${h(name)}</h3><div class="flow-branches">${data.states.filter(s => s.group === id).map(s => `<div class="flow-branch"><button class="step" data-state="${h(s.id)}"><span class="state-id">${h(s.id)}</span><strong>${h(s.title)}</strong></button><ul>${s.transition.next.map(next => `<li><span class="trigger-kind ${h(next.kind)}">${next.kind === "action" ? "用户操作" : "系统事件"}</span><span>${h(next.text)} → ${next.id ? `<a href="#${h(next.id)}" data-state="${h(next.id)}">${h(next.label)} <small>${h(next.id)}</small></a>` : `<span class="unsampled">${h(next.label)}（未采样／无独立截图）</span>`}</span></li>`).join("")}</ul></div>`).join("")}</div></section>`).join("");
      return;
    }
    if (tab === "flows") {
      content.innerHTML = `<p class="hint">先按用户路径理解状态，再进入单张图讨论细节。箭头表示阅读顺序；有些路径包含可选或异常分支。</p>` + data.flows.map(flow => `<section class="flow"><h3>${h(flow.title)}</h3><p>${h(flow.description)}</p><div class="steps">${flow.states.filter(get).map((id, i) => `${i ? '<span class="arrow" aria-hidden="true">→</span>' : ""}<button class="step" data-state="${h(id)}"><span class="state-id">${h(id)}</span><strong>${h(get(id).title)}</strong></button>`).join("")}</div></section>`).join("");
      return;
    }
    if (tab === "concepts") {
      content.innerHTML = `<p class="hint">这些概念用于理解状态和操作边界。界面里不必展示同样长的解释。</p><div class="glossary">${data.concepts.map(term => `<article class="term" id="term-${h(term.id)}"><h3>${h(term.name)}</h3><p>${h(term.meaning)}</p><p class="distinction">${h(term.distinction)}</p></article>`).join("")}</div>`;
      return;
    }
    if (tab === "coverage") {
      content.innerHTML = `<div class="notice">这一版是有来源的状态采样集，不是“全产品已覆盖”。${data.states.length} 个状态、${data.imageCount} 张图片；${data.freshCount} 个状态在本次生成时从真实组件重新采样。其余保留各自原始日期。缺口按下面清单继续补。</div><div class="coverage"><table><thead><tr><th>领域</th><th>本版已收录</th><th>尚需补充</th></tr></thead><tbody>${data.groups.map(([id, name, description]) => `<tr><td><b>${h(name)}</b><p>${h(description)}</p></td><td>${data.states.filter(s => s.group === id).map(s => `<a href="#${h(s.id)}">${h(s.id)} ${h(s.title)}</a>`).join("<br>")}</td><td>以下方缺口清单为准；未采样不等于产品没有该功能。</td></tr>`).join("")}</tbody></table></div><h2 class="section-title">后续采样缺口</h2><div class="coverage"><table><thead><tr><th>页面／领域</th><th>待采样状态</th><th>源码定位线索</th></tr></thead><tbody>${data.backlog.map(([name, missing, source]) => `<tr><td>${h(name)}</td><td class="pending">${h(missing)}</td><td><code>${h(source)}</code></td></tr>`).join("")}</tbody></table></div><h2 class="section-title">路由盘点</h2><p class="hint">${data.routes.length} 个路由入口。页面里另有菜单、工具面板和运行状态；路由数量不是状态数量。</p><div class="coverage"><table><thead><tr><th>源码路由</th><th>说明</th></tr></thead><tbody>${data.routes.map(route => `<tr><td><code>${h(route)}</code></td><td>是否已有所需状态截图，请按上方状态编号和缺口清单核对。</td></tr>`).join("")}</tbody></table></div>`;
      return;
    }
    const matches = data.states.filter(s => (tab !== "updates" || s.addedIn === data.edition) && (group === "all" || s.group === group) && (version === "all" || s.version === version) && (showArchive || s.freshness !== "历史采样") && (!query || [s.id, s.title, s.condition, JSON.stringify(s.transition || {}), ...s.concepts.map(id => data.concepts.find(c => c.id === id)?.name)].join(" ").toLowerCase().includes(query.toLowerCase())));
    const heading = tab === "updates" ? "本次新增" : group === "all" ? "可浏览状态" : data.groups.find(([id]) => id === group)?.[1];
    content.innerHTML = `<h2 class="section-title">${h(heading)} <small class="state-id">${matches.length}</small></h2><p class="hint">点击图片先看入口与触发链，再看概念注释、操作边界与版本。图片保留原始尺寸；主题和语言变体在详情中选择。</p>` + (matches.length ? `<div class="grid">${matches.map(s => `<button class="card" data-state="${h(s.id)}" aria-label="${h(s.id + ' ' + s.title)}"><div class="thumb"><img src="${h(s.variants[0].image)}" alt="${h(s.title)}" loading="lazy" width="${s.variants[0].width}" height="${s.variants[0].height}"></div><div class="card-copy"><span class="state-id">${h(s.id)}</span><h3>${h(s.title)}</h3><p>${h(s.condition)}</p>${s.transition ? `<p class="card-trigger"><b>${({ action: "操作", event: "事件", mixed: "操作／事件" })[s.transition.trigger.kind]}</b> · ${h(s.transition.trigger.steps.at(-1))}</p>` : ""}<div class="tags">${tag(s.version)}${tag(s.kind, s.kind === "瞬态" ? "transient" : "")}${tag(s.captureDate)}${tag(s.freshness, s.freshness === "本次组件采样" ? "current" : s.freshness === "历史采样" ? "archive" : "")}</div></div></button>`).join("")}</div>` : '<div class="empty">当前条件下没有状态。可清空搜索、切换“所有版本”，或勾选历史采样。</div>');
  }
  function renderDetail() {
    if (!current) return;
    const s = current, v = s.variants[variant] ?? s.variants[0];
    $("detail-title").textContent = s.title;
    $("detail-id").textContent = `${s.id} · ${s.version} · ${s.captureDate} · ${s.freshness}`;
    const notes = s.hotspots || [];
    $("detail-content").innerHTML = `<div><div class="preview-controls"><select id="variant" aria-label="选择截图变体">${s.variants.map((item, i) => `<option value="${i}" ${i === variant ? "selected" : ""}>${h(item.label)} · ${item.width}×${item.height}</option>`).join("")}</select><label><input id="annotations" type="checkbox" checked> 注释</label></div><div class="phone"><img src="${h(v.image)}" alt="${h(s.title + ' ' + v.label)}">${notes.map(([x, y, w, height], i) => `<div class="hotspot" style="left:${x}%;top:${y}%;width:${w}%;height:${height}%"><b>${i + 1}</b></div>`).join("")}</div><p class="preview-note">PNG 为真实组件截图／既有验收截图。编号解释阅读区域，非像素测量或新增产品控件。静态图中的按钮不会执行操作。</p></div><div class="detail-copy">${window.renderAtlasTransition(s)}<h3>什么时候出现</h3><p class="condition">${h(s.condition)}</p><div class="tags">${tag(s.evidence)}${tag(s.kind)}</div><h3>关键区域</h3>${notes.map(([, , , , name, text], i) => `<div class="annotation"><b>${i + 1}</b><div><strong>${h(name)}</strong><br>${h(text)}</div></div>`).join("") || '<p>本状态采用概念说明，不加覆盖标记。</p>'}<h3>用户在这里要做什么</h3><ul>${s.can.map(t => `<li>${h(t)}</li>`).join("")}</ul><h3>设计时必须保留的含义</h3><ul>${s.constraints.map(t => `<li>${h(t)}</li>`).join("")}</ul><h3>相关概念</h3>${s.concepts.map(id => data.concepts.find(t => t.id === id)).filter(Boolean).map(t => `<p><b>${h(t.name)}</b> · ${h(t.meaning)}<br>${h(t.distinction)}</p>`).join("")}<div class="detail-actions">${links(s)}</div><p class="provenance">来源：${h(v.source)}<br>原图 SHA-256：${h(v.sha256)}<br>组件定位：${h(s.recipe || "按来源套件查看")}<br>代码快照：${h(s.rendererTreeSha256 || "原采样未绑定组件源码指纹，需重新采样后确认同版")}</p></div>`;
    document.querySelector(".dialog .phone").style.setProperty("--image-ratio", String(v.width / v.height));
    $("variant").addEventListener("change", event => { variant = Number(event.target.value); renderDetail(); });
    $("annotations").addEventListener("change", event => document.querySelectorAll(".hotspot").forEach(node => { node.hidden = !event.target.checked; }));
  }
  function open(id) {
    const s = get(id); if (!s) return;
    current = s; variant = 0; renderDetail(); $("detail").scrollTop = 0;
    if (!$("detail").open) $("detail").showModal();
  }
  function toast(text) { $("toast").textContent = text; $("toast").style.display = "block"; setTimeout(() => { $("toast").style.display = "none"; }, 2600); }
  async function copy(id) {
    const text = get(id).aiBrief;
    try { await navigator.clipboard.writeText(text); toast("已复制该状态的 AI 设计任务"); }
    catch { const node = document.createElement("textarea"); node.value = text; document.body.append(node); node.select(); const ok = document.execCommand("copy"); node.remove(); toast(ok ? "已复制" : "浏览器未允许复制，请下载说明文件"); }
  }
  document.addEventListener("click", event => {
    const node = event.target.closest("[data-group],[data-tab],[data-state],[data-copy],[data-close]"); if (!node) return;
    if (node.dataset.group !== undefined) { group = node.dataset.group; tab = "states"; render(); }
    if (node.dataset.tab) { tab = node.dataset.tab; if (tab === "updates") { group = "all"; version = data.v3Only ? "V3" : "all"; showArchive = true; query = ""; $("versions").value = version; $("archive").checked = true; $("search").value = ""; } render(); }
    if (node.dataset.state) { if (location.hash === `#${node.dataset.state}`) open(node.dataset.state); else location.hash = node.dataset.state; }
    if (node.dataset.copy) void copy(node.dataset.copy);
    if (node.dataset.close !== undefined) $("detail").close();
  });
  $("detail").addEventListener("close", () => { current = null; if (get(decodeURIComponent(location.hash.slice(1)))) location.hash = ""; });
  window.addEventListener("hashchange", () => { const id = decodeURIComponent(location.hash.slice(1)); if (get(id)) open(id); else if ($("detail").open) $("detail").close(); });
  $("search").addEventListener("input", event => { query = event.target.value; render(); });
  $("versions").addEventListener("change", event => { version = event.target.value; render(); });
  $("archive").addEventListener("change", event => { showArchive = event.target.checked; render(); });
  render(); if (location.hash) open(decodeURIComponent(location.hash.slice(1)));
})();
