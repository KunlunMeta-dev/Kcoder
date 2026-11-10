import type { SETTINGS_RUNTIME_EN } from "./settings-runtime.en";

export const SETTINGS_RUNTIME_ZH_CN = {
  "settings_runtime.selector_label": "运行目标",
  "settings_runtime.selector_title": "设置目标",
  "settings_runtime.select_target": "选择目标",
  "settings_runtime.no_gateway": "请先连接 Gateway，再配置远端设置。",
  "settings_runtime.loading_targets": "正在加载运行目标…",
  "settings_runtime.no_targets": "当前没有可用的运行目标。",
  "settings_runtime.connecting": "正在连接所选目标…",
  "settings_runtime.connected": "已连接所选目标。",
  "settings_runtime.connection_error": "无法连接所选目标。",
  "settings_runtime.retry": "重试",
  "settings_runtime.default_workspace": "默认工作区",
  "settings_runtime.workspace_label": "工作区",
  "settings_runtime.target_changed": "所选目标已切换。请先检查当前目标的设置再继续。",
} satisfies Record<keyof typeof SETTINGS_RUNTIME_EN, string>;
