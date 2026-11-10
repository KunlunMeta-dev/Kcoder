// Curated presentation evidence, not an assertion that every product state is covered.
export const groups = [
  ["selection", "会话选择", "找到项目、选择已有会话，或开始一份草稿。"],
  ["draft", "新建草稿", "先写问题；第一次发送时才创建后端会话。"],
  ["conversation", "对话与思考", "阅读回复、观察运行，必要时介入或停止。"],
  ["recovery", "发送与恢复", "区分准备、发送、已接收、未知结果和确认失败。"],
  ["history", "历史与筛选", "查找已加载的历史，按范围缩小列表。"],
  ["actions", "菜单与权限", "低频操作按需展开；执行权限与阅读偏好分开。"],
  ["settings", "设置与辅助页面", "版本、外观、待处理和专业工具。"],
];

export const concepts = [
  { id: "gateway", name: "Gateway", meaning: "手机访问 KCoder 的接入服务，负责身份验证和把请求送到运行目标。", distinction: "Gateway 在线，不代表它管理的每台服务器都在线。" },
  { id: "target", name: "服务器／运行目标", meaning: "实际读取文件、保存会话和执行工具的环境，可以是本机或远程服务器。", distinction: "同名项目在不同服务器上，可能是完全不同的数据。" },
  { id: "project", name: "项目与工作区", meaning: "项目组织目录和会话；工作区是一次会话实际工作的目录，也可能是独立 worktree。", distinction: "切换项目会改变文件和会话范围，不只是改一个显示名称。" },
  { id: "session", name: "会话", meaning: "一段可持续打开的对话历史，里面可以包含多次提问和回复。", distinction: "添加项目、打开草稿、创建会话，是三个不同动作。" },
  { id: "turn", name: "消息与回合", meaning: "消息是时间线中的一条内容；回合是一次请求及其模型回复、思考、工具执行等过程。", distinction: "一个回合里可以出现多条消息和多个工具步骤。" },
  { id: "draft", name: "草稿", meaning: "用户尚未发送的问题、附件和选择，先保留在客户端。", distinction: "进入草稿页本身不等于已经创建后端会话。" },
  { id: "connection", name: "连接与可用能力", meaning: "是否能读取目标、加载模型、准备附件、修改权限和发送，要分别根据实际状态判断。", distinction: "离线时仍可先写问题；不能把所有功能简单一起禁用。" },
  { id: "cache", name: "缓存历史", meaning: "保存在设备上的已确认历史投影，用于先展示已有内容，再尝试同步。", distinction: "看得到正文，不代表当前在线，也不代表缓存完整。" },
  { id: "recovery", name: "发送恢复记录", meaning: "客户端记录发送意图与结果，用于中断或重开后核对本次发送。", distinction: "恢复记录不等于后端排队消息，也不证明服务器已经收到。" },
  { id: "receipt", name: "结果待核对", meaning: "请求可能已发出或执行，但客户端尚未取得足够的确认。", distinction: "未知结果不等于失败；不能把重发当作一定不会重复。" },
  { id: "thinking", name: "思考与工具", meaning: "思考是模型分析内容；工具是读取文件、执行命令等步骤。两者可以交错。", distinction: "折叠只是隐藏详情，不表示完成。进行中、完成、停止应跟随实际事件。" },
  { id: "permission", name: "权限模式与审批", meaning: "决定哪些执行动作需要用户确认；待处理里还可能有模型提问。", distinction: "不是手机系统的摄像头／相册权限，也不是主题、字号等本机设置。" },
  { id: "fork", name: "编辑重发与分叉", meaning: "编辑最后一条问题后重新提交，或从一个已完成回合建立新会话。", distinction: "分叉会产生新的会话分支；不是把旧会话简单改名。" },
];

const defaults = {
  selection: { concepts: ["target", "project", "session"], can: ["选择项目筛选", "打开已有会话", "进入草稿", "进入搜索、待处理和设置"], constraints: ["会话、项目和服务器的身份必须保持对应。", "数量来自实际已加载数据，不能把示例数字当固定值。"], hotspots: [[8, 1, 84, 5, "入口", "搜索、待处理、设置是不同入口。"], [4, 7, 91, 32, "会话", "先按服务器识别归属，再选择具体会话。"], [4, 40, 91, 43, "项目", "下面的项目列表用于缩小上方会话范围。"]] },
  draft: { concepts: ["draft", "project", "connection"], can: ["先写问题", "切换服务器和项目", "连接就绪后选择模型并发送"], constraints: ["页面打开不自动发送，不自动创建后端会话。", "连接、配置、附件、权限与发送分别判断可用性；切换目标不能混用草稿或配置。"], hotspots: [[4, 1, 92, 8, "导航", "进入菜单后仍可找到会话、历史、待处理和设置。"], [4, 78, 92, 6, "当前范围", "明确本次使用的服务器和项目。"], [2, 85, 96, 14, "输入", "离线允许写问题；实际发送有独立的就绪条件。"]] },
  conversation: { concepts: ["turn", "thinking", "connection"], can: ["阅读正文", "展开思考和工具", "运行中停止", "通过菜单使用可用操作"], constraints: ["思考、工具和回复按实际顺序呈现。", "不得把折叠状态、动画停止或连接断开误标为回合完成。"], hotspots: [[4, 1, 92, 8, "归属与操作", "标题、运行目标与右侧菜单帮助定位当前会话。"], [4, 12, 92, 58, "正文", "模型回复、思考与工具是不同内容层次。"], [2, 83, 96, 16, "继续对话", "输入、运行中停止与发送的语义不同。"]] },
  recovery: { concepts: ["recovery", "receipt", "draft"], can: ["观察当前阶段", "按状态核对结果或手动恢复", "继续保留下一条草稿"], constraints: ["普通准备和发送进度不应使用错误语义。", "结果未知与确认失败必须区分；恢复操作不覆盖用户较新的草稿。", "此组件标本冻结了网络动作，统一关闭实际发送；不能据此推断正式版所有灰色按钮的业务条件。"], hotspots: [[2, 60, 96, 22, "恢复卡片", "这不是后端队列。卡片说明本次发送当前已知的阶段。"], [2, 84, 96, 15, "新草稿", "卡片中的旧问题与下面正在编辑的新问题是两份内容。"]] },
  history: { concepts: ["session", "cache", "project"], can: ["搜索已加载的历史", "按服务器／项目筛选", "查看归档会话", "打开某条会话"], constraints: ["历史搜索与当前对话正文搜索是不同功能。", "刷新或局部断联不应无故清空已加载历史。"], hotspots: [[4, 1, 92, 8, "范围入口", "返回与筛选不应丢失用户正在查看的范围。"], [4, 10, 92, 8, "搜索", "V3 使用搜索按钮或键盘确认提交查询。"], [4, 21, 92, 54, "结果", "实际时间、标题与当前筛选共同帮助定位会话。"]] },
  actions: { concepts: ["permission", "target", "session"], can: ["打开对应操作", "返回原页面", "修改被允许的当前设置"], constraints: ["菜单项属于具体目标、会话或草稿，不能跨目标生效。", "权限不是外观偏好；有些运行状态不允许修改。"], hotspots: [[4, 50, 92, 45, "操作区", "这张图记录展开后的菜单或选择器。具体位置以截图为准。"]] },
  settings: { concepts: ["permission", "connection", "cache"], can: ["查看或更改本机偏好", "区分目标设置与客户端设置"], constraints: ["V1/V2/V3 是界面版本，不能改变会话归属和执行事实。", "旧版采样用于理解功能，样式与当前 V3 可能不同。"], hotspots: [] },
};

export function state(id, title, group, image, details = {}) {
  return { id, title, group, image, version: "V3", kind: "常规", freshness: "既有采样", ...defaults[group], ...details };
}

// File names are explicit allowlists; arbitrary personal screenshots are never scanned into the pack.
export const documentStates = [
  state("SEL-01", "全部项目的会话", "selection", "2026-10-23-v3-conversation-selection/375-zh-CN-light.png", { condition: "打开会话选择页，未限定项目。", recipe: "V3ConversationSelection.tsx" }),
  state("SEL-02", "选中一个项目", "selection", "2026-10-23-v3-conversation-selection/375-zh-CN-selected-project.png", { condition: "点击项目后，只显示该项目的会话。", recipe: "V3ConversationSelection.tsx" }),
  state("DRAFT-01", "记住上次有效项目", "draft", "2026-10-23-v3-startup-draft/390-zh-CN-light-remembered-project.png", { condition: "没有可恢复会话，使用上次有效项目准备草稿。", recipe: "NewTaskDraft.tsx / useLastDraftProject.ts" }),
  state("DRAFT-02", "离线时先写问题", "draft", "2026-10-23-v3-startup-draft/390-zh-CN-light-offline-writing.png", { condition: "项目尚未连接，用户仍在编辑问题。", kind: "离线", recipe: "NewTaskDraft.tsx" }),
  state("DRAFT-03", "从所选项目新建", "draft", "2026-10-23-v3-conversation-selection/375-zh-CN-project-draft.png", { condition: "点击服务器旁的加号，带入所选项目。", recipe: "NewTaskDraft.tsx" }),
  state("CHAT-01", "已有会话正文", "conversation", "2026-10-23-v3-conversation-selection/375-zh-CN-open-conversation.png", { condition: "从列表打开已有会话。", recipe: "TaskScreen.tsx / TaskTranscript.tsx" }),
  state("CHAT-02", "回复正文与操作", "conversation", "2026-10-22-v3-conversation-messages/390-zh-CN-light-v3-reply.png", { condition: "回复已呈现，用户阅读或打开消息操作。", recipe: "MessageBubble.tsx / TranscriptActions.tsx" }),
  state("CHAT-03", "展开思考与工具", "conversation", "2026-10-22-v3-conversation-messages/390-zh-CN-light-v3-thinking-tools.png", { condition: "用户展开同一回合的思考和工具过程。", kind: "展开", recipe: "OrderedMessageSegments.tsx / TranscriptDisclosure.tsx" }),
  state("THINK-01", "模型仍在思考", "conversation", "2026-10-23-mobile-thinking-status/390-zh-CN-light-thinking-running.png", { condition: "收到思考增量，但未收到完成事件。", kind: "瞬态", recipe: "OrderedMessageSegments.tsx", constraints: [...defaults.conversation.constraints, "此时显示进行中；不能提前显示已完成。"] }),
  state("THINK-02", "思考所在回合已完成", "conversation", "2026-10-23-mobile-thinking-status/390-zh-CN-light-thinking-completed.png", { condition: "已收到本回合的完成事件。", kind: "完成", recipe: "OrderedMessageSegments.tsx" }),
  state("THINK-03", "用户停止思考回合", "conversation", "2026-10-23-mobile-thinking-status/390-zh-CN-light-thinking-stopped.png", { condition: "停止请求获得确认，该回合中断。", kind: "停止", recipe: "OrderedMessageSegments.tsx", constraints: ["停止与成功完成是两个状态。", "中断后仍保留已显示的历史，不伪造工具成功结果。"] }),
  state("CACHE-01", "重开后先读缓存", "conversation", "2026-10-23-v3-startup-draft/390-zh-CN-light-restored-cache.png", { condition: "有可恢复会话，先展示本机已保存的历史。", kind: "恢复", concepts: ["cache", "connection", "session"], recipe: "CachedSessionView.tsx" }),
  state("MENU-01", "左上角导航菜单", "actions", "2026-10-23-v3-startup-draft/390-zh-CN-light-navigation.png", { condition: "在草稿或会话页打开导航菜单。", kind: "菜单", recipe: "ConversationV3.tsx" }),
  state("MENU-02", "新建草稿的更多菜单", "actions", "2026-10-22-v3-permissions-more/390-zh-CN-light-v3-draft-more.png", { condition: "在草稿右上角打开更多，找到权限等选项。", kind: "菜单", recipe: "NewTaskDraft.tsx" }),
  state("MENU-03", "已有会话的更多菜单", "actions", "2026-10-22-v3-permissions-more/390-zh-CN-light-v3-conversation-more.png", { condition: "在已有会话右上角打开更多。", kind: "菜单", recipe: "TaskPanels.tsx" }),
  state("PERM-01", "草稿权限选择", "actions", "2026-10-22-conversation-v3/390-zh-CN-light-v3-draft-permissions.png", { condition: "打开当前草稿的权限模式选择器。", kind: "菜单", recipe: "TaskPermissionSelector.tsx" }),
  state("SHARED-01", "对话中的待审批动作", "conversation", "2026-10-23-shared-conversation/shared-approval-a.png", { condition: "工具执行需要用户作出权限决定。", kind: "审批", concepts: ["permission", "turn", "target"], recipe: "TaskTranscript.tsx / MessageCards.tsx", constraints: ["展示请求所属会话和真实处理状态。", "多个客户端可见不表示可以对同一请求重复提交决定。"] }),
  state("SET-01", "设置首页（旧版采样）", "settings", "2026-10-14-settings-acceptance/settings-home-390-zh-CN-light.png", { condition: "设置模块的既有采样，用于理解分组。", version: "早期界面", freshness: "历史采样", recipe: "settings.tsx", kind: "历史参考" }),
  state("INBOX-01", "待处理列表（旧版采样）", "settings", "2026-10-13-l2-inbox/interaction-inbox-390x844-zh.png", { condition: "集中查看需要用户回应的审批或提问。", version: "早期界面", freshness: "历史采样", recipe: "inbox.tsx", kind: "历史参考", concepts: ["permission", "target", "session"] }),
  state("SEARCH-01", "当前会话正文搜索（旧版）", "actions", "2026-10-18-message-edit-fork-search/after-search-390-zh-dark.png", { condition: "在当前会话已加载的正文里查找关键词。", version: "早期界面", freshness: "历史采样", kind: "历史参考", concepts: ["session", "cache"], recipe: "TaskPanels.tsx", constraints: ["这是会话内部的搜索，不是历史会话列表的标题搜索。", "未加载的更早正文不应被说成已经全部搜索。"] }),
  state("FORK-01", "按完成回合分叉（旧版）", "actions", "2026-10-18-message-edit-fork-search/after-fork-390-zh-dark.png", { condition: "从已完成回合发起新会话分支。", version: "早期界面", freshness: "历史采样", kind: "历史参考", concepts: ["fork", "turn"], recipe: "TranscriptActions.tsx" }),
  state("EDIT-01", "编辑最后问题（旧版）", "actions", "2026-10-18-message-edit-fork-search/after-edit-390-zh-dark.png", { condition: "修正最后一条问题后重新发送。", version: "早期界面", freshness: "历史采样", kind: "历史参考", concepts: ["fork", "draft"], recipe: "TranscriptActions.tsx" }),
];

export const libraryStates = [
  ["HIST-01", "历史对话列表", "history", "history-v3", "打开历史，按真实月份组织已加载会话。"],
  ["HIST-02", "提交搜索后的结果", "history", "search-v3", "输入关键词并点击搜索之后。"],
  ["HIST-03", "筛选页面", "history", "filters-v3", "展开服务器、项目和归档范围选择。"],
  ["HIST-04", "已归档会话", "history", "archived-v3", "切换到归档范围。"],
  ["SET-02", "V1／V2／V3 版本选择", "settings", "version-choices", "设置中的界面版本选择，版本选择本身不更改会话。"],
  ["OLD-01", "V1 会话选择对照", "selection", "home-classic", "旧版列表外观对照，功能身份保持一致。", "V1"],
  ["OLD-02", "V2 会话选择对照", "selection", "home-modern", "上一版列表外观对照。", "V2"],
];

export const recoveryStates = [
  ["none", "没有发送恢复卡片", "常规", "没有待处理的本机发送记录。"],
  ["preparing", "正在保存发送恢复记录", "瞬态", "点击发送后，先记录这次发送意图。"],
  ["retaining", "消息准备中，记录已保存", "瞬态", "本机恢复记录已保存，还在准备本次消息。"],
  ["sending", "请求已发出，等待结果", "瞬态", "正在等待发送结果，不应显示为确认失败。"],
  ["accepted", "服务器已接收，等待同步", "瞬态", "已有本次回合的接收凭据，继续核对或同步，不重复提交。"],
  ["unknown", "发送结果待核对", "待核对", "当前无法确认本次是否已执行，需要核对。"],
  ["failed", "确认失败，保留草稿", "错误", "存在明确失败信息，保留原问题供用户处理。"],
];

export const flows = [
  { title: "从项目开始一次对话", description: "区分添加项目、准备草稿和首次创建会话。", states: ["SEL-01", "SEL-02", "DRAFT-03", "SEND-preparing", "SEND-sending", "THINK-01", "THINK-02", "CHAT-01"] },
  { title: "重开 App 与断联", description: "缓存阅读、草稿书写和后端连接是独立能力。", states: ["CACHE-01", "DRAFT-01", "DRAFT-02", "SEL-01"] },
  { title: "核对一次发送", description: "这是可能的分支，不表示每次发送必定依次出现全部卡片。", states: ["SEND-preparing", "SEND-retaining", "SEND-sending", "SEND-accepted", "SEND-unknown", "SEND-failed"] },
  { title: "查找以前的会话", description: "列表搜索与当前对话正文搜索分开理解。", states: ["SEL-01", "HIST-01", "HIST-02", "HIST-03", "HIST-04", "CHAT-01"] },
  { title: "观察与干预执行", description: "折叠、完成、停止和请求审批具有不同含义。", states: ["THINK-01", "CHAT-03", "SHARED-01", "THINK-03", "THINK-02"] },
];

export const backlog = [
  ["连接与配对", "欢迎、手动连接、扫码、连接中、令牌失效、重新授权", "welcome.tsx / connect.tsx / pair-scan.tsx"],
  ["项目管理", "选择已有目录、登记中、置顶、重命名、路径不可用", "open-project.tsx / workspace-history-actions-sheet.tsx"],
  ["输入与附件", "空输入、长输入、图片／文件、准备中、上传冲突、移除附件", "TaskComposer.tsx / attachment-sheet.tsx"],
  ["历史边界", "首次加载、空结果、加载更多、部分来源离线、授权过期", "sessions.tsx"],
  ["待处理", "当前 V3 列表、无请求、提问、审批、其他客户端已处理", "inbox.tsx / MessageCards.tsx"],
  ["会话操作", "当前 V3 的正文搜索、编辑重发、分叉与各自不可用状态", "TaskPanels.tsx / TranscriptActions.tsx"],
  ["专业页面", "文件列表、文件预览、编辑、Diff、终端、浏览器", "workspace-panels.tsx / TaskPanels.tsx"],
  ["设置", "所有当前设置分组、连接管理、诊断、阅读偏好与保存反馈", "settings*.tsx / components/settings/"],
  ["原生平台", "系统键盘、摄像头／相册授权、分享、后台恢复、安全区", "Android／iOS 真机或模拟器独立采样"],
];
