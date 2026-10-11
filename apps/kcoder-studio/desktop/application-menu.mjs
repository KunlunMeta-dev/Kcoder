export function applicationMenuTemplate({ openSettings, openAutomations, newWindow, newChat,
  newTemporaryChat, openFolder, logout, canLogout = false, quit }) {
  return [
    { id: "file", label: "文件", submenu: [
      { id: "newWindow", label: "新建窗口", enabled: Boolean(newWindow), click: newWindow },
      { id: "newChat", label: "新聊天", accelerator: "CmdOrCtrl+N", enabled: Boolean(newChat), click: newChat },
      { id: "temporaryChat", label: "新建临时聊天", accelerator: "CmdOrCtrl+Shift+N", enabled: Boolean(newTemporaryChat), click: newTemporaryChat },
      { type: "separator" },
      { id: "openFolder", label: "打开文件夹…", accelerator: "CmdOrCtrl+O", enabled: Boolean(openFolder), click: openFolder },
      { type: "separator" },
      { id: "close", label: "关闭", accelerator: "CmdOrCtrl+W", role: "close" },
      { type: "separator" },
      { id: "logout", label: "注销", enabled: canLogout && Boolean(logout), click: logout },
      { id: "quit", label: "退出 KCoder Studio", accelerator: "CmdOrCtrl+Q", click: quit },
    ] },
    { id: "edit", label: "编辑", submenu: [
      { id: "undo", label: "撤销", role: "undo" }, { id: "redo", label: "重做", role: "redo" },
      { type: "separator" }, { id: "cut", label: "剪切", role: "cut" },
      { id: "copy", label: "复制", role: "copy" }, { id: "paste", label: "粘贴", role: "paste" },
      { id: "selectAll", label: "全选", role: "selectAll" },
    ] },
    { id: "view", label: "视图", submenu: [
      { id: "reload", label: "刷新", role: "reload" }, { id: "forceReload", label: "强制刷新", role: "forceReload" },
      { type: "separator" }, { id: "resetZoom", label: "实际大小", role: "resetZoom" },
      { id: "zoomIn", label: "放大", role: "zoomIn" }, { id: "zoomOut", label: "缩小", role: "zoomOut" },
      { type: "separator" }, { id: "togglefullscreen", label: "全屏", role: "togglefullscreen" },
      { type: "separator" },
      { id: "minimize", label: "最小化", role: "minimize" }, { id: "zoom", label: "缩放窗口", role: "zoom" },
      { type: "separator" },
      { id: "settings", label: "设置…", accelerator: "CmdOrCtrl+,", click: openSettings },
      { id: "automations", label: "定时任务…", accelerator: "CmdOrCtrl+Shift+J", click: openAutomations },
    ] },
  ];
}
