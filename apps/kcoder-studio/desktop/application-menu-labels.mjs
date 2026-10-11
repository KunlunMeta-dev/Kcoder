// Stable command identities shared by native and renderer menus.
export const menuLabels = {
  zh: { file: '文件', edit: '编辑', view: '视图', newWindow: '新建窗口', newChat: '新聊天', temporaryChat: '新建临时聊天', openFolder: '打开文件夹…', close: '关闭', logout: '注销', quit: '退出 KCoder Studio', undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选', reload: '刷新', forceReload: '强制刷新', resetZoom: '实际大小', zoomIn: '放大', zoomOut: '缩小', togglefullscreen: '全屏', minimize: '最小化', zoom: '缩放窗口', settings: '设置…', automations: '定时任务…' },
  en: { file: 'File', edit: 'Edit', view: 'View', newWindow: 'New window', newChat: 'New chat', temporaryChat: 'New temporary chat', openFolder: 'Open folder…', close: 'Close', logout: 'Sign out', quit: 'Quit KCoder Studio', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select all', reload: 'Reload', forceReload: 'Force reload', resetZoom: 'Actual size', zoomIn: 'Zoom in', zoomOut: 'Zoom out', togglefullscreen: 'Full screen', minimize: 'Minimize', zoom: 'Zoom window', settings: 'Settings…', automations: 'Scheduled tasks…' },
};
export function localizeMenu(menu, locale = 'zh') {
  const labels = menuLabels[locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'];
  for (const item of menu.items ?? []) {
    if (labels[item.id]) item.label = labels[item.id];
    if (item.submenu) localizeMenu(item.submenu, locale);
  }
}
