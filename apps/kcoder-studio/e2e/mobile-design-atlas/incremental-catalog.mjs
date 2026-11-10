// Only reviewed synthetic captures are admitted; missing states remain explicit gaps.
export const incrementalGroups = [
  ["commands", "指令与持续目标", "斜杠入口、Goal 生命周期与真实任务进度。"],
  ["agents", "子代理与协作", "父会话、子代理正文、提问与协作的归属。"],
  ["connections", "连接与配对", "接入 Gateway、目标状态与重新授权。"],
  ["input", "输入、模型与附件", "编辑草稿、选择模型、准备和保留附件。"],
  ["projects", "项目与会话管理", "置顶、重命名、登记目录与会话操作。"],
  ["workspace", "文件、浏览器与终端", "工作目录中的文件、改动和专业操作视口。"],
];

export const incrementalConcepts = [
  { id: "command", name: "斜杠指令", meaning: "在输入区以 / 开头调用的客户端操作入口，例如 /model、/goal。", distinction: "不是每段以斜杠开头的文字都能发送；可用指令以当前命令目录为准。" },
  { id: "goal", name: "持续目标 Goal", meaning: "跨多个回合继续推进的目标，具有自己的状态、预算和用量。", distinction: "暂停目标与停止当前回合不同；清除目标不等于删除会话。" },
  { id: "plan", name: "任务清单与进度", meaning: "模型实际报告的计划项及其执行状态。", distinction: "不是持续目标本身；没有真实清单时不能凭空显示完成百分比。" },
  { id: "subagent", name: "子代理 Subagent", meaning: "父会话委派工作的独立代理，拥有自己的执行状态和可读记录。", distinction: "子代理完成不等于父会话完成；回答问题或追加指令必须对应正确的代理。" },
  { id: "moa", name: "多模型协作 MOA", meaning: "通过 /moa 或 /moa-plan 组织多个参与者提供建议或计划，再汇总结果。", distinction: "与持续目标、普通单模型回复及单个子代理不是同一个概念；部分参与者失败也不等于全部完成。" },
  { id: "queue", name: "待发送队列", meaning: "当前回合运行时用户追加的待处理消息。", distinction: "与本机发送恢复记录、附件保留区分别管理，不能共用一个含糊的“已发送”状态。" },
  { id: "attachment", name: "附件准备与保留", meaning: "文件先被选择并准备，再关联消息；失败或中断时可能保留原文件等待核对。", distinction: "已选文件、已上传、消息已接收是三个不同阶段。" },
  { id: "provider", name: "模型与服务", meaning: "Provider 提供模型服务；模型、推理强度与输入能力共同决定本次可用选择。", distinction: "支持图片或工具不表示凭据有效；会话选择不会自动修改服务器默认配置。" },
  { id: "workspaceTools", name: "工作区工具", meaning: "文件、Diff、终端和浏览器都作用于当前会话所在的运行目标与目录。", distinction: "远程浏览器不是手机浏览器；目标文件不一定存在于手机文件系统。" },
  { id: "failureContinuation", name: "从失败处继续", meaning: "根据服务器确认的恢复边界继续一次失败执行。", distinction: "与重新发送原问题不同；未知副作用不能因点击继续而盲目重放。" },
  { id: "migration", name: "迁移与接收", meaning: "将其他来源的项目、历史、配置或扩展经过预览与映射后接收到目标端。", distinction: "发现来源、预览、上传、发布和撤销分别有状态；预览成功不等于已经启用。" },
];

function capture(id, title, group, image, condition, concepts, can, constraints, recipe, variants = [], extra = {}) {
  return { id, title, group, image, condition, concepts, can, constraints, recipe, variants,
    version: "早期界面", kind: "历史参考", freshness: "历史采样", addedIn: "02", hotspots: [], ...extra };
}
const goalBoundary = ["暂停目标与停止当前回合分别呈现。", "目标状态、用量和计划来自实际后端；不根据动画猜测完成。", "本图为早期样式，仅说明功能，不代表当前 V3 的像素外观。"];
const scoped = ["操作归属当前 Gateway、运行目标和项目，不跨目标生效。", "保留原采样日期；旧样式不当作当前 V3。"];

export const incrementalStates = [
  capture("CMD-01", "输入 / 的指令候选菜单", "commands", "2026-10-13/goal-before-slash-menu-390x844.png", "用户在输入区输入斜杠，查看当时版本的指令候选。", ["command", "goal"], ["找到支持的命令", "选择命令后继续填写参数"], ["候选列表是当时版本；当前命令以 composer-slash.ts 为准。", "不能将菜单里的历史指令当作当前一定可用。"], "components/composer-slash.ts / TaskComposer.tsx"),
  capture("GOAL-01", "Goal 常驻状态和控制", "commands", "2026-10-13/goal-after-persistent-controls-390x844.png", "当前会话有持续目标，在输入区上方查看状态与控制。", ["goal", "plan", "turn"], ["查看目标和真实用量", "按状态暂停、继续、编辑或清除", "展开目标详情"], goalBoundary, "TaskGoalControls.tsx"),
  capture("GOAL-02", "终态 Goal 只读", "commands", "2026-10-13/goal-terminal-after-readonly-390x844.png", "目标已经进入终态，编辑入口不再开放。", ["goal"], ["阅读已完成目标", "查看终态说明"], [...goalBoundary, "不可把终态目标显示成仍可保存或继续。"], "TaskGoalControls.tsx / goalProjection.ts"),
  capture("GOAL-03", "编辑时目标状态发生变化", "commands", "2026-10-13/goal-terminal-after-edit-race-390x844.png", "编辑期间收到较新的目标状态，旧编辑不能直接覆盖它。", ["goal"], ["理解目标已变化", "保留输入并按实际状态核对"], [...goalBoundary, "保存要校验目标身份与版本；界面不得伪报保存成功。"], "TaskGoalControls.tsx"),
  capture("AGENT-01", "子代理提问与父会话定位", "agents", "2026-10-13-l2-inbox/interaction-inbox-source-agent-focus-390x844-zh.png", "从待处理请求打开具体子代理的问题，定位父会话内的正确代理。", ["subagent", "permission", "session"], ["阅读问题与代理上下文", "答复或忽略问题", "回到父会话"], ["父会话、代理、目标与请求必须对应。", "旧连接、已处理或身份不明的请求只能只读，不重复提交答案。", "这是子代理问题状态，不代表已覆盖整个子代理工作台。"], "TaskSubagents.tsx / InteractionInboxScreen.tsx", ["2026-10-13-l2-inbox/interaction-inbox-source-agent-focus-320x844-zh.png"]),
  capture("CONNECT-01", "首次使用与连接入口", "connections", "2026-10-13-l1-pairing/mobile-pairing-after-welcome-390x844-zh-light.png", "尚未建立连接，选择受支持的连接方式。", ["gateway", "connection"], ["开始连接 Gateway", "了解配对入口"], scoped, "app/welcome.tsx"),
  capture("CONNECT-02", "空配对链接表单", "connections", "2026-10-13-l1-pairing/mobile-pairing-after-empty-link-form-390x844-zh-light.png", "进入配对表单，尚未输入连接链接。", ["gateway", "connection"], ["填写连接信息", "返回或取消"], [...scoped, "真实口令与令牌不进入截图、说明和设计数据。"], "app/connect.tsx"),
  capture("CONNECT-03", "历史页要求重新授权", "connections", "2026-10-13/l2-after-sessions-reauth-390-zh-light.png", "已有历史仍在，但访问目标需要重新授权。", ["cache", "connection"], ["查看已加载历史", "重新授权对应目标"], [...scoped, "重新授权与清空历史是不同动作。", "这张早期截图的错误展示不应被视为当前样式要求。"], "app/sessions.tsx"),
  capture("CONNECT-04", "目标在线与能力摘要", "connections", "2026-10-13/nav-after-host-available-390-zh-light.png", "查看特定服务器的状态与已确认能力。", ["target", "connection", "workspaceTools"], ["辨认当前目标", "查看可用能力"], [...scoped, "在线、能力支持、功能已启动必须分开说明。"], "app/host-details.tsx"),
  capture("CONNECT-05", "目标离线，能力未确认", "connections", "2026-10-13/nav-after-host-offline-320-zh-dark.png", "目标暂时不可达，保留身份并将未检查能力显示为未确认。", ["target", "connection"], ["识别离线目标", "查看已有目标信息"], [...scoped, "未确认不能伪装成不支持，也不能误报在线。"], "app/host-details.tsx", [], { kind: "离线" }),
  capture("INPUT-01", "新建草稿的模型与推理强度", "input", "2026-10-16-new-draft-composer-functional/after-model-effort-390-zh-light.png", "打开当前草稿的模型和推理强度选择器。", ["provider", "draft", "connection"], ["选择当前目标支持的模型", "选择可用推理强度"], [...scoped, "保留会话选择、显式选择与目标默认的优先级，不自动选目录第一项。"], "TaskInteractions.tsx / useTaskModelPreferences.ts"),
  capture("INPUT-02", "草稿中已选择的本机附件", "input", "2026-10-16-new-draft-composer-functional/after-local-attachments-390-zh-light.png", "文件已加入草稿，仍未发送。", ["attachment", "draft"], ["查看附件", "继续编辑问题", "移除尚未发送的附件"], [...scoped, "本机文件已选择不等于上传成功，更不等于会话已创建。"], "TaskAttachments.tsx / NewTaskDraft.tsx"),
  capture("INPUT-03", "附件选择后未进入输入区的失败现场", "input", "2026-10-14-l3-reading-tools/attachment-staging-failure.png", "历史测试中选择文件后没有出现附件 chip，保留该失败现场供设计分析。", ["attachment", "recovery"], ["识别附件准备缺少反馈的问题"], ["这是已记录的历史失败证据，不是正常态或附件上传成功的证明。", "不把缺少反馈理解为没有发生任何操作。"], "TaskAttachments.tsx / attachment-selection.ts", [], { kind: "历史缺陷", evidence: "隔离测试的失败现场；不是通过证据" }),
  capture("INPUT-04", "输入区权限选择", "input", "2026-10-16-new-draft-composer-functional/after-permission-390-zh-light.png", "在当时版本打开草稿权限选择器。", ["permission", "draft"], ["查看并选择本次允许的权限模式"], [...scoped, "V3 当前入口在更多菜单，旧版入口位置仅供功能理解。"], "TaskPermissionSelector.tsx"),
  capture("INPUT-05", "草稿的项目选择器", "input", "2026-10-16-new-draft-composer-functional/after-project-picker-390-zh-light.png", "从草稿切换已有项目。", ["project", "draft", "target"], ["确认服务器与目录", "选择已有项目"], [...scoped, "切换后仍是草稿，不隐式发送或创建后端会话。"], "DraftContextBar.tsx / NewTaskDraft.tsx"),
  capture("PROJECT-01", "置顶项目的列表分组", "projects", "2026-10-16-home-project-pins/after-home-pinned-390-zh-light.png", "已有项目被置顶，在列表中优先展示。", ["project", "target"], ["找到常用项目", "打开对应会话或草稿"], [...scoped, "置顶是组织方式，不复制项目文件，也不改变连接状态。"], "V3ConversationSelection.tsx / workspace-history-actions-sheet.tsx", ["2026-10-16-home-project-pins/after-home-pinned-320-zh-dark.png"]),
  capture("PROJECT-02", "项目置顶菜单", "projects", "2026-10-16-home-project-pins/after-pin-menu-390-zh-light.png", "打开项目操作，查看置顶入口。", ["project"], ["置顶或取消置顶所选项目"], scoped, "workspace-history-actions-sheet.tsx"),
  capture("PROJECT-03", "重命名项目编辑框", "projects", "2026-10-16-project-rename-task-actions/project-rename-editor-390-zh-cn-light.png", "在项目操作菜单中编辑显示名称。", ["project", "target"], ["输入新的项目显示名称", "保存或取消"], [...scoped, "项目显示名称与磁盘目录路径不同，不应暗示会移动目录。"], "workspace-history-actions-sheet.tsx"),
  capture("PROJECT-04", "长按会话打开操作", "projects", "2026-10-16-project-rename-task-actions/drawer-longpress-390-zh-cn-light.png", "长按列表中的会话，显示原有会话操作。", ["session"], ["查看当前会话可用操作", "关闭后回到原列表"], [...scoped, "归档、删除、重命名不是同一操作；危险操作保留确认边界。"], "thread-actions-sheet.tsx"),
  capture("PROJECT-05", "已有目录登记入口", "projects", "2026-10-13/nav-after-open-project-390-zh-light.png", "在选定运行目标上选择或登记已有目录。", ["project", "target"], ["选择目标上的已有目录", "确认或取消登记"], [...scoped, "登记目录、创建目录、创建 worktree 和新建会话不同。"], "app/open-project.tsx", ["2026-10-13/nav-after-open-project-320-en-dark.png"]),
  capture("WORK-01", "最近文件与文件路径", "workspace", "2026-10-14-l3-reading-tools/files-recent-path.png", "在会话的文件面板查看最近文件与路径。", ["workspaceTools", "project"], ["辨认目标文件", "打开和阅读文件"], scoped, "workspace-panels.tsx / workspace-file-discovery-panel.tsx"),
  capture("WORK-02", "文件变更 Diff 审阅", "workspace", "2026-10-14-l3-reading-tools/files-diff-review.png", "在工作区查看文件增删差异。", ["workspaceTools"], ["阅读变更内容", "检查增删差异与所属文件"], [...scoped, "Diff 表示文件变化，不等于模型已经完成整个任务。"], "changes-panel.tsx / workspace-panels.tsx"),
  capture("WORK-03", "远程浏览器工作区", "workspace", "2026-10-13-l4-browser-workspace/l4-workspace-browserpanel-after-390x844-zh-CN-light.png", "打开当前会话目标上的浏览器并查看页面。", ["workspaceTools", "target", "permission"], ["输入网页地址", "查看页面", "使用浏览器操作控件"], [...scoped, "这是目标端浏览器，不是手机本地浏览器；动作不能在丢回执后盲目重放。"], "workspace-panels.tsx / browser-preflight.ts"),
  capture("WORK-04", "浏览器能力不支持", "workspace", "2026-10-13/nav-after-browser-unavailable-320-en-dark.png", "目标已确认缺少对应浏览器能力，展示不可用状态。", ["workspaceTools", "connection"], ["理解功能不可用的实际前提", "返回当前会话"], [...scoped, "缺少能力与网络断开分别表达。"], "workspace-panels.tsx / browser-preflight.ts"),
  capture("WORK-05", "终端 ANSI 色彩与可读性标本", "workspace", "2026-10-22-terminal-contrast/terminal-390-en-light.png", "在独立 xterm 标本中对照真实 Mobile 终端主题的 ANSI 色彩。", ["workspaceTools"], ["检查浅色与深色的字符对比度"], ["这是 xterm 配色标本，不是完整终端页面，也不证明终端连接或命令执行。", "不使用配色截图冒充专业视口的完整采样。"], "terminal theme / xterm palette fixture", ["2026-10-22-terminal-contrast/terminal-320-zh-CN-light.png", "2026-10-22-terminal-contrast/terminal-320-en-dark.png", "2026-10-22-terminal-contrast/terminal-390-zh-CN-dark.png"], { version: "共享组件", evidence: "独立 xterm 配色 fixture；无 Gateway 或模型" }),
  capture("SET-03", "模型服务的能力选项", "settings", "2026-10-13/model-capabilities-after-390x844-zh-CN-light.png", "编辑目标端模型服务，按需展开可选输入能力。", ["provider", "target"], ["查看模型字段", "展开高级能力配置"], [...scoped, "配置声明不等于凭据验证或实际模型调用成功。"], "settings/ModelServicesSettings.tsx"),
  capture("SET-04", "外观偏好保存失败", "settings", "2026-10-14-preferences-feedback/after-appearance-write-failure-320-en-dark.png", "本机偏好写入失败，页面保留可恢复反馈。", ["cache"], ["识别本机保存失败", "按页面提供的方式重试保存"], ["本机偏好保存失败与远程服务器断联是不同问题。", "不能丢弃用户刚选择的值或伪报已保存。"], "settings/LocalPreferenceStorageStatus.tsx", [], { kind: "错误" }),
  capture("LAYOUT-01", "较短视口下的输入区", "input", "2026-10-13/keyboard-after-web-viewport-simulation-390x560.png", "Web 视口高度缩短，检查输入框与控件是否仍可见。", ["draft", "connection"], ["在有限视口内编辑和访问操作"], ["只是 Web 视口模拟，不是 Android 或 iOS 系统键盘截图。", "系统键盘、安全区与输入法行为仍需真机补采。"], "TaskComposer.tsx / keyboard-safe-view.tsx", [], { kind: "布局边界" }),
];

export const incrementalFlows = [
  { title: "指令与持续目标", description: "候选菜单、常驻目标与终态编辑边界。暂停 Goal 不等于停止回合。", states: ["CMD-01", "GOAL-01", "GOAL-02", "GOAL-03"] },
  { title: "处理子代理问题", description: "待处理入口定位具体代理，保留父会话与目标身份。", states: ["INBOX-01", "AGENT-01", "SHARED-01"] },
  { title: "准备有附件的草稿", description: "选择项目、模型和附件；附件准备失败与消息发送失败分开。", states: ["DRAFT-01", "INPUT-05", "INPUT-01", "INPUT-02", "INPUT-03", "SEND-preparing"] },
  { title: "管理项目与工作区", description: "置顶和改名不改变磁盘目录；文件、Diff 与浏览器使用当前目标。", states: ["PROJECT-01", "PROJECT-02", "PROJECT-03", "WORK-01", "WORK-02", "WORK-03"] },
];

export const remainingGaps = [
  ["指令与 Goal", "当前 V3 指令菜单；Goal Pro、暂停/恢复/受阻/预算耗尽、编辑表单、清除确认和目标历史", "composer-slash.ts / TaskGoalControls.tsx"],
  ["子代理与协作", "完整子代理列表与正文、运行/完成/失败/空态、追加指令、停止确认；/moa 与 /moa-plan 配置及结果汇总", "TaskSubagents.tsx / MessageCards.tsx / useTaskCommands.ts"],
  ["排队与停止", "运行中追加消息、待发列表、移除、停止请求中和停止回执；与本机恢复记录对照", "TaskComposer.tsx / task-runtime/turns.ts"],
  ["附件与输入", "当前 V3 附件预览、上传进度/冲突/中断、原文件保留、继续上传、上传已完成但未关联消息、长输入和快捷短语", "TaskAttachments.tsx / useRetainedAttachmentOutbox.ts"],
  ["执行失败恢复", "失败详情、从已确认恢复点继续、使用当前配置继续、不可恢复与结果未知", "failure-continuation.tsx / RuntimeErrorBanner.tsx"],
  ["连接与配对", "当前 V3/共享连接页、扫码、连接中、令牌过期、切换与移除授权；P2P/中继诊断", "welcome.tsx / connect.tsx / pair-scan.tsx / settings-connections.tsx"],
  ["项目与会话", "当前 V3 置顶/改名/新增目录、归档/恢复/删除确认、处理中及失败；项目路径不可用", "V3ConversationSelection.tsx / thread-actions-sheet.tsx"],
  ["历史与搜索", "首次加载、空结果、分页、部分来源离线；当前 V3 正文搜索、编辑重发、分叉的可用与禁用状态", "sessions.tsx / TranscriptActions.tsx / TranscriptSearchBar.tsx"],
  ["待处理", "当前 V3 列表、空态、单选/多选/自由回答、其他端已处理、过期只读", "InteractionInboxScreen.tsx / interaction-cards.tsx"],
  ["专业工具", "当前完整终端、文件预览/编辑/未保存/冲突、浏览器加载/导航/断开；现有终端图仅为配色标本", "workspace-panels.tsx / changes-panel.tsx"],
  ["设置与迁移", "全部当前设置分组与二级页、工具/扩展/用量/缓存/快捷短语；迁移发现、预览、映射、接收、发布、历史和撤销", "settings/ / settings/migration/"],
  ["系统与通用边界", "Android/iOS 系统键盘、相册/摄像头、系统分享与后台恢复；大字体、未保存退出及平台专有状态", "Android/iOS 真实设备或模拟器；不可用 Web 缩小视口代替"],
];
