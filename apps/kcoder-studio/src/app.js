import { RpcClient, defaultRpcUrl, rpcUrlForServer } from "./rpc-client.js";

const $ = (selector) => document.querySelector(selector);
const state = { serverId: null, servers: [], threadId: null, turnId: null, busy: false, eventCount: 0, items: new Map(), demoStarted: false };
const rpc = new RpcClient();

function selectedServer() { return state.servers.find((server) => server.id === state.serverId); }

function setConnection(kind, detail) {
  const server = selectedServer();
  const serverDetail = detail || (server ? `${server.label} · ${kind === "online" ? "在线" : kind === "connecting" ? "连接中" : "离线"}` : "未选择服务器");
  document.body.dataset.connection = kind;
  $("#connection-label").textContent = serverDetail;
  $("#pill-label").textContent = kind === "online" ? "已连接" : kind === "connecting" ? "连接中" : "离线";
  $("#send").disabled = kind !== "online" || !$("#prompt").value.trim() || state.busy;
  document.querySelectorAll(".server-card").forEach((card) => {
    const active = card.dataset.serverId === state.serverId;
    card.classList.toggle("active", active);
    card.setAttribute("aria-current", active ? "true" : "false");
    const detailNode = card.querySelector("small");
    const target = state.servers.find((entry) => entry.id === card.dataset.serverId);
    if (detailNode && target) detailNode.textContent = active ? serverDetail.replace(`${target.label} · `, "") : target.description;
  });
}

function addActivity(title, detail, kind = "event") {
  state.eventCount += 1;
  $("#event-count").textContent = String(state.eventCount);
  $("#activity-empty").hidden = true;
  const row = document.createElement("div");
  row.className = `activity-item ${kind}`;
  row.innerHTML = `<span class="activity-icon"></span><div><strong></strong><p></p></div>`;
  row.querySelector("strong").textContent = title;
  row.querySelector("p").textContent = detail || "已完成";
  $("#activity-list").prepend(row);
}

function message(role, text = "") {
  $("#welcome")?.remove();
  const article = document.createElement("article");
  article.className = `message ${role}`;
  article.innerHTML = `<div class="message-avatar"></div><div class="message-body"><div class="message-role"></div><div class="message-text"></div></div>`;
  article.querySelector(".message-avatar").textContent = role === "user" ? "你" : "K";
  article.querySelector(".message-role").textContent = role === "user" ? "你" : "KCoder";
  article.querySelector(".message-text").textContent = text;
  $("#transcript").append(article);
  article.scrollIntoView({ behavior: "smooth", block: "end" });
  return article.querySelector(".message-text");
}

function setBusy(busy) {
  state.busy = busy;
  $("#stop").hidden = !busy;
  $("#send").hidden = busy;
  $("#prompt").disabled = busy;
  setConnection(rpc.connected ? "online" : "offline");
}

function resetConversation() {
  state.threadId = null;
  state.turnId = null;
  state.items.clear();
  $("#thread-label").textContent = "尚未创建会话";
}

function renderServers() {
  const list = $("#server-list");
  list.replaceChildren();
  for (const server of state.servers) {
    const button = document.createElement("button");
    button.className = "server-card";
    button.type = "button";
    button.dataset.serverId = server.id;
    button.innerHTML = `<span class="server-icon"></span><span class="server-copy"><strong></strong><small></small></span><span class="status-dot"></span>`;
    button.querySelector(".server-icon").textContent = server.transport === "ssh" ? "SSH" : "VM";
    button.querySelector("strong").textContent = server.label;
    button.querySelector("small").textContent = server.description;
    button.addEventListener("click", () => selectServer(server.id));
    list.append(button);
  }
  setConnection(rpc.connected ? "online" : "offline");
}

function selectServer(serverId) {
  if (serverId === state.serverId && rpc.connected) return;
  if (state.busy) { addActivity("暂时无法切换服务器", "请先停止当前任务", "error"); return; }
  const server = state.servers.find((entry) => entry.id === serverId);
  if (!server) return;
  rpc.close();
  resetConversation();
  state.serverId = server.id;
  rpc.url = rpcUrlForServer(defaultRpcUrl(), server.id);
  renderServers();
  setConnection("connecting");
  setTimeout(() => rpc.connect(), 100);
}

async function initialize() {
  const result = await rpc.request("initialize", { protocolVersion: "2026-07-27", clientInfo: { name: "kcoder-studio", version: "0.1.0" }, capabilities: {} });
  addActivity(`已连接 ${selectedServer()?.label || "app-server"}`, result?.serverInfo?.version || "协议握手成功", "success");
}

async function ensureThread() {
  if (state.threadId) return state.threadId;
  const result = await rpc.request("thread/start", {});
  state.threadId = result.thread?.id || result.threadId;
  $("#thread-label").textContent = state.threadId ? `会话 ${state.threadId.slice(0, 8)}` : "新会话";
  return state.threadId;
}

async function sendPrompt(text) {
  message("user", text);
  $("#prompt").value = "";
  setBusy(true);
  try {
    const threadId = await ensureThread();
    const result = await rpc.request("turn/start", { threadId, input: [{ type: "text", text }] });
    state.turnId = result.turn?.id || result.turnId || null;
  } catch (error) {
    message("assistant", `无法启动任务：${error.message}`);
    setBusy(false);
  }
}

function handleNotification({ method, params = {} }) {
  if (method === "server/transportError" || method === "server/disconnected") {
    const messageText = params.message || (params.code === 255 ? "SSH 连接失败，请检查 ssh config/agent 和远端 kcoder" : "app-server 连接已断开");
    addActivity(method === "server/transportError" ? "服务器连接失败" : "服务器已断开", messageText, "error");
    setBusy(false);
    setConnection("offline");
    return;
  }
  if (method === "thread/started") {
    state.threadId = params.thread?.id || params.threadId || state.threadId;
    return;
  }
  if (method === "turn/started") {
    state.turnId = params.turn?.id || params.turnId;
    addActivity("任务开始", "正在处理请求");
    return;
  }
  if (method === "item/started") {
    const item = params.item || params;
    if (item.type === "agentMessage" || item.type === "message") state.items.set(item.id, message("assistant"));
    else addActivity(item.title || "工具调用", item.command || item.name || item.type || "正在运行", "tool");
    return;
  }
  if (method === "item/delta") {
    const id = params.itemId || params.item?.id;
    let target = state.items.get(id);
    if (!target) { target = message("assistant"); state.items.set(id, target); }
    target.textContent += params.delta?.text || params.delta || params.text || "";
    target.closest("article").scrollIntoView({ behavior: "smooth", block: "end" });
    return;
  }
  if (method === "item/completed") {
    const item = params.item || params;
    if (item.type !== "agentMessage" && item.type !== "message") addActivity(item.title || "工具完成", item.output || item.status || item.type, "success");
    return;
  }
  if (method === "turn/completed") {
    const status = params.turn?.status || params.status || "completed";
    const kind = status === "failed" ? "error" : status === "interrupted" ? "event" : "success";
    const title = status === "failed" ? "任务失败" : status === "interrupted" ? "任务已停止" : "任务完成";
    addActivity(title, params.error?.message || status, kind);
    setBusy(false);
    return;
  }
  addActivity(method, params.status || "收到服务器事件");
}

rpc.addEventListener("connecting", () => setConnection("connecting", "正在连接 app-server…"));
rpc.addEventListener("open", async () => {
  setConnection("online");
  try {
    await initialize();
    if (new URLSearchParams(location.search).get("demo") === "1" && !state.demoStarted) {
      state.demoStarted = true;
      await sendPrompt("请演示 KCoder Studio 的真实流式连接");
    }
  } catch (e) {
    addActivity("握手失败", e.message, "error");
  }
});
rpc.addEventListener("close", () => {
  resetConversation();
  setBusy(false);
  setConnection("offline", "连接已断开");
});
rpc.addEventListener("error", () => setConnection("offline", "无法连接 app-server"));
rpc.addEventListener("protocolerror", (e) => addActivity("协议错误", e.detail.message, "error"));
rpc.addEventListener("notification", (e) => handleNotification(e.detail));

$("#composer").addEventListener("submit", (event) => { event.preventDefault(); const text = $("#prompt").value.trim(); if (text && rpc.connected && !state.busy) sendPrompt(text); });
$("#prompt").addEventListener("input", (event) => { event.target.style.height = "auto"; event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`; $("#send").disabled = !event.target.value.trim() || !rpc.connected || state.busy; });
$("#prompt").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("#composer").requestSubmit(); } });
$("#stop").addEventListener("click", async () => { if (!state.turnId) return; try { await rpc.request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId }); addActivity("已请求停止", "等待服务器确认"); } catch (e) { addActivity("停止失败", e.message, "error"); } });
$("#reconnect").addEventListener("click", () => { rpc.close(); setTimeout(() => rpc.connect(), 100); });
$("#new-thread").addEventListener("click", () => {
  if (state.busy) { addActivity("暂时无法新建会话", "请先停止当前任务", "error"); return; }
  resetConversation(); $("#transcript").innerHTML = `<div class="welcome"><div class="welcome-symbol">山</div><h2>新会话已准备好</h2><p>发送一条消息后，将在当前服务器创建会话。</p></div>`;
});
document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => { $("#prompt").value = button.dataset.prompt; $("#prompt").dispatchEvent(new Event("input")); $("#prompt").focus(); }));

async function boot() {
  setConnection("connecting", "正在加载服务器…");
  try {
    const response = await fetch("/api/servers", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    state.servers = Array.isArray(payload.servers) ? payload.servers : [];
    if (!state.servers.length) throw new Error("没有可用服务器");
    renderServers();
    selectServer(state.servers[0].id);
  } catch (error) {
    setConnection("offline", "无法加载服务器配置");
    addActivity("服务器配置失败", error.message, "error");
  }
}

boot();
