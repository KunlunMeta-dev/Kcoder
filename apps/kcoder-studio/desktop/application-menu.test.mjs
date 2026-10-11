import assert from "node:assert/strict";
import test from "node:test";
import { applicationMenuTemplate } from "./application-menu.mjs";

test("desktop File menu groups windows, chats, folders and account actions", () => {
  let opened = false;
  let settingsOpened = false;
  const menu = applicationMenuTemplate({ openSettings: () => { settingsOpened = true; }, openAutomations: () => { opened = true; }, quit() {} });
  assert.deepEqual(menu.map(item => item.label), ["文件", "编辑", "视图"]);
  assert.deepEqual(menu[0].submenu.map(item => item.type === 'separator' ? '---' : item.label), [
    '新建窗口', '新聊天', '新建临时聊天', '---', '打开文件夹…', '---', '关闭', '---', '注销', '退出 KCoder Studio',
  ]);
  menu[2].submenu.find(item => item.label === '设置…').click();
  menu[2].submenu.find(item => item.label === '定时任务…').click();
  assert.equal(settingsOpened, true);
  assert.equal(opened, true);
  assert.equal(menu[1].submenu.find(item => item.role === "copy").label, "复制");
});

test('application quit has an explicit host callback, distinct from window close', () => {
  let quits = 0;
  const menu = applicationMenuTemplate({ openSettings() {}, openAutomations() {}, quit: () => { quits += 1; } });
  const actions = menu.flatMap(group => group.submenu);
  assert.equal(actions.filter(item => item.label === '退出 KCoder Studio').length, 1);
  const quit = actions.find(item => item.label === '退出 KCoder Studio');
  assert.equal(quit.role, undefined);
  assert.equal(quit.accelerator, 'CmdOrCtrl+Q');
  quit.click();
  assert.equal(quits, 1);
  const close = actions.find(item => item.role === 'close');
  assert.equal(close.label, '关闭');
  assert.equal(close.click, undefined);
  assert.equal(actions.filter(item => item.role === 'minimize').length, 1);
});

test('File actions preserve focused-window callbacks and disable unavailable sign-out', () => {
  const invoked = [];
  const callbacks = Object.fromEntries(['newWindow', 'newChat', 'newTemporaryChat', 'openFolder', 'logout'].map(name => [name, (...args) => invoked.push([name, ...args])]));
  const file = applicationMenuTemplate({ ...callbacks, canLogout: false, quit() {} })[0].submenu;
  const focused = {};
  const item = {};
  for (const label of ['新建窗口', '新聊天', '新建临时聊天', '打开文件夹…']) file.find(entry => entry.label === label).click(item, focused);
  assert.deepEqual(invoked.map(value => value[0]), ['newWindow', 'newChat', 'newTemporaryChat', 'openFolder']);
  assert.ok(invoked.every(value => value[2] === focused));
  assert.equal(file.find(entry => entry.label === '注销').enabled, false);
  assert.equal(file.find(entry => entry.label === '新聊天').accelerator, 'CmdOrCtrl+N');
  assert.equal(file.find(entry => entry.label === '新建临时聊天').accelerator, 'CmdOrCtrl+Shift+N');
  assert.equal(file.find(entry => entry.label === '打开文件夹…').accelerator, 'CmdOrCtrl+O');
});
