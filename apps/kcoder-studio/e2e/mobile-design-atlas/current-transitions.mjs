// These describe production entry conditions, not actions executed by the frozen fixture.
const sampled = id => ({ id });
const missing = label => ({ label, unsampled: true });
const action = (text, id, label) => ({ kind: "action", text, ...(id ? sampled(id) : missing(label)) });
const event = (text, id, label) => ({ kind: "event", text, ...(id ? sampled(id) : missing(label)) });
const entry = (from, kind, steps, next, note = "", requires = []) => ({ from: from.map(value => typeof value === "string" ? sampled(value) : value), trigger: { kind, steps }, next, note, requires });
const conversation = ["CHAT-01"];
const dismiss = [action("关闭浮层，返回原会话或草稿", "CHAT-01")];

export const currentTransitions = {
  "SEL-01": entry(["MENU-01"], "action", ["点击会话页左上角返回图标，直接进入会话选择页"], [action("点某个项目，仅显示该项目会话", "SEL-02"), action("点服务器名称或箭头，收起分组", "SEL-04"), action("点服务器右侧“+”，准备新建草稿", "DRAFT-01"), action("点一条会话，打开其正文", "CHAT-01")], "也可从返回列表入口进入；打开 App 时优先恢复会话，否则准备草稿，不以此页作为固定启动页。"),
  "SEL-02": entry(["SEL-01"], "action", ["点击“项目文件夹”中的某个项目行"], [action("点“全选”，恢复全部项目", "SEL-01"), action("选择没有历史的项目", "SEL-03"), action("点“+”，使用当前项目准备草稿", "DRAFT-01")], "项目过滤在本页生效，不会删除其他项目的历史。"),
  "SEL-03": entry(["SEL-01"], "mixed", ["选择一个项目", "当前已加载历史中没有这个项目的会话"], [action("点“全选”或选择其他项目", "SEL-01"), action("点该服务器的“+”准备新草稿", "DRAFT-01")], "空历史与服务器断联不同；不能仅凭空列表判断连接失败。"),
  "SEL-04": entry(["SEL-01"], "action", ["点击服务器分组名称或展开／收起箭头"], [action("再点同一分组，展开会话", "SEL-01")]),
  "DRAFT-01": entry(["SEL-01", missing("App 启动：没有可恢复会话")], "mixed", ["点服务器旁的“+”，或启动时没有可恢复会话", "准备本地草稿，带入上次有效项目；此时不创建后端会话"], [action("输入较长的问题", "INPUT-01"), action("点模型标签选择模型", "MODEL-1"), action("点附件“+”", "ATTACH-1"), action("首次点“发送”，开始保存恢复记录", "SEND-preparing"), event("当前项目断联", "DRAFT-02")], "服务器和项目可通过输入区上方选择器切换；选择器展开态尚未采样。", ["发送、模型、附件和权限按实际连接及能力开放；文字可先写。"]),
  "DRAFT-02": entry(["DRAFT-01"], "event", ["当前项目连接尚未建立或连接断开", "输入区保留草稿；依赖连接的能力按实际状态禁用"], [action("继续编辑问题", "INPUT-01"), event("连接恢复并完成配置读取", "DRAFT-01")], "恢复连接不会自动发送草稿；离线期间可以切换目标或项目。"),
  "INPUT-01": entry(["DRAFT-01", "CHAT-01"], "action", ["在消息输入框中持续输入或粘贴长文本"], [action("满足发送条件后点“发送”", "SEND-preparing"), action("展开输入区“+”选择附件", "ATTACH-1")], "编辑时最多五行，超出内部滚动；失焦或收起键盘后显示两行预览，再次点击恢复编辑。离线仍可编辑，发送继续受连接状态约束。"),
  "CHAT-01": entry(["SEL-01", "SEND-accepted", missing("App 启动：恢复上次会话")], "mixed", ["从列表打开已有会话，或恢复上次会话，或首次发送后进入会话", "缓存或服务端提供已加载的回复正文"], [action("点击某条回复下方“更多”", "CHAT-02"), action("点右上角“更多”", "MENU-02"), action("点左上角进入会话选择", "MENU-01"), event("新回合进入思考阶段", "THINK-01")], "本图为有回复的示例。恢复缓存不意味着当前在线；正文按真实内容增量展示。"),
  "CHAT-02": entry(conversation, "action", ["点击某条助手回复下方的省略号“更多”"], [action("关闭回复菜单", "CHAT-01"), action("选择“按已完成回合分叉”", null, "新分叉会话（未采样）")], "这是单条回复菜单，与右上角整段会话的“更多”不同；分叉受回合完成状态和后端能力约束。"),
  "THINK-01": entry(["RUN-01"], "event", ["当前回合收到思考内容或思考阶段事件", "回合尚未收到结束状态"], [event("思考阶段确认完成", "THINK-02"), event("回合被中断或停止", "THINK-03")], "折叠只是展示方式；不能因当前没有新字符就显示“已完成”。"),
  "THINK-02": entry(["THINK-01"], "event", ["服务端确认思考阶段或该回合已完成", "思考块按阅读偏好折叠显示"], [action("点击思考块标题或箭头", "THINK-04")], "回合可能继续输出正文或工具内容；思考结束不等于整段会话结束。"),
  "THINK-03": entry(["THINK-01", "RUN-01"], "event", ["停止请求生效，或收到回合中断状态"], [action("保留已有记录，继续输入新问题", "INPUT-01")], "停止状态不是成功完成；保留已接收的思考和工具结果。"),
  "THINK-04": entry(["THINK-02"], "action", ["点击已折叠的“思考／思考与工具”标题或箭头"], [action("再点标题或箭头，收起正文", "THINK-02")], "本图展开已完成的思考；运行中的思考也可展开，展开不会改变执行状态。"),
  "RUN-01": entry(["SEND-accepted"], "event", ["服务端开始当前回合，并同步运行状态"], [action("点击停止，等待服务端确认中断", "THINK-03"), event("收到思考内容", "THINK-01"), event("收到最终回复", "CHAT-01")], "停止针对当前回合；不等同于暂停持续目标。"),
  "GOAL-01": entry([missing("已有持续目标的会话"), "GOAL-02", "GOAL-03"], "event", ["读取到持续目标 active 状态，或继续目标后收到 active 状态"], [action("点击暂停并收到确认", "GOAL-02"), action("点击编辑目标", "GOAL-09"), action("点击目标详情箭头", "GOAL-10"), event("目标执行受阻", "GOAL-03"), event("目标达到完成条件", "GOAL-04"), event("目标被取消", "GOAL-05"), event("达到用量限制", "GOAL-06"), event("达到预算限制", "GOAL-07")], "暂停目标与停止当前回合是不同操作；不会依次经历所有 Goal 状态。"),
  "GOAL-02": entry(["GOAL-01"], "mixed", ["点击目标“暂停”", "服务端确认目标 paused 状态"], [action("点击继续并收到 active 状态", "GOAL-01"), action("编辑目标", "GOAL-09")], "暂停后保留目标，不以暂停推断当前工具已停止。"),
  "GOAL-03": entry(["GOAL-01"], "event", ["服务端报告目标 blocked 状态"], [action("处理阻塞后点击继续，并收到 active 状态", "GOAL-01"), action("查看详情了解阻塞原因", "GOAL-10")]),
  "GOAL-04": entry(["GOAL-01"], "event", ["服务端确认目标 complete 状态"], [action("阅读结果或继续普通会话", "CHAT-01")], "终态目标不可当作仍在执行或仍可编辑。"),
  "GOAL-05": entry(["GOAL-01"], "event", ["同步到服务端的目标 cancelled 状态"], [action("保留结果，继续普通会话", "CHAT-01")], "此图不表示存在一个本地图册可操作的“取消目标”按钮；清除目标也不等同于取消回合。"),
  "GOAL-06": entry(["GOAL-01"], "event", ["目标因用量限制进入 usageLimited 状态"], [action("查看目标用量和限制", "GOAL-10")], "限额状态由后端确认，不在图册中推断或自动重启。"),
  "GOAL-07": entry(["GOAL-01"], "event", ["目标因预算限制进入 budgetLimited 状态"], [action("查看目标预算和已使用情况", "GOAL-10")], "与用量限制是两个不同分支，不是先后步骤。"),
  "GOAL-08": entry([missing("配置了 strict 模式持续目标的会话")], "event", ["读取目标，mode 为 strict 且状态为 active"], [action("编辑当前目标", "GOAL-09"), action("查看目标详情", "GOAL-10"), action("暂停并收到确认", "GOAL-02")], "Goal Pro 是目标模式，不是 active 之后的下一阶段。"),
  "GOAL-09": entry(["GOAL-01", "GOAL-02", "GOAL-08"], "action", ["点击持续目标卡片上的编辑按钮"], [action("保存修订并同步目标", "GOAL-02"), action("取消编辑，回到原目标", "GOAL-02")], "本图编辑 paused 目标，返回时仍为暂停；编辑不会自动恢复目标。", ["目标可编辑、已连接且没有冲突中的写入。"]),
  "GOAL-10": entry(["GOAL-02", "GOAL-01", "GOAL-03", "GOAL-06", "GOAL-07", "GOAL-08"], "action", ["点击目标卡片的详情展开箭头"], [action("收起详情，返回原目标卡片", "GOAL-02")], "该图采用 paused 示例；展开详情不会改变任一目标状态。"),
  "PLAN-01": entry(["PLAN-02"], "action", ["点击右上角省略号", "点击“本轮清单 · 进度”打开详情面板"], [action("关闭详情，继续阅读", "PLAN-02"), action("运行期间主动固定单行摘要", "PLAN-03"), event("收到包含取消状态的条目更新", "PLAN-04")], "查看详情不改变底层消息视口；长清单在面板中滚动，默认不固定。"),
  "PLAN-02": entry(conversation, "event", ["收到当前回合的 TodoWrite 清单", "清单保留在所属消息中，随消息滚动"], [action("从省略号菜单查看本轮清单", "PLAN-01"), event("进入包含旧清单的历史", "PLAN-05")], "默认不占用输入区上方高度；进度只统计 completed。"),
  "PLAN-03": entry(["PLAN-01"], "action", ["在详情中点击“固定为单行摘要”", "向上阅读较早的正文"], [action("点击摘要查看详情", "PLAN-01"), action("点击摘要右侧关闭按钮，取消固定", "PLAN-02"), event("回合结束或清单全部完成／取消，退出固定展示", "PLAN-02")], "固定只作用于当前会话的当前回合；切换归属不带入旧固定状态。"),
  "PLAN-04": entry(["PLAN-01", "PLAN-02"], "event", ["模型通过 TodoWrite 报告包含 cancelled 的清单", "从省略号菜单打开详情"], [action("关闭清单详情", "PLAN-02")], "取消项显示已取消，不画完成勾，不计入已完成数量；模型更新不代表客户端执行了任务。"),
  "PLAN-05": entry(conversation, "event", ["加载包含上一回合清单的消息记录", "当前回合另有 TodoWrite 清单"], [action("从菜单查看当前回合的清单", "PLAN-01"), action("关闭面板，继续阅读消息", "PLAN-02")], "旧清单属于旧消息；当前清单也保留在消息流，不将旧回合进度带入新回合。"),
  "AGENT-01": entry(["MENU-02"], "action", ["点击父会话右上角“更多”", "选择“查看子代理”"], [action("选择运行中的子代理", "AGENT-09"), action("选择已完成的子代理", "AGENT-02"), action("点击返回，回到父会话", "CHAT-01"), event("当前父会话没有子代理", "AGENT-08")], "列表和子会话在独立查看器内；消息列表与 Composer 复用主会话组件，父会话草稿保留。", ["Gateway 声明支持子代理发现。"]),
  "AGENT-08": entry(["MENU-02"], "mixed", ["选择“查看子代理”", "列表读取完成，但当前父会话没有子代理"], [action("返回父会话", "CHAT-01"), event("刷新后发现子代理", "AGENT-01")], "空列表与读取失败不同。"),
  "AGENT-09": entry(["AGENT-01"], "mixed", ["在子代理列表中选择一项", "该代理状态为运行中，读取结构化快照并订阅增量消息"], [action("点击返回，回到子代理列表", "AGENT-01"), action("点击“返回父会话”", "CHAT-01"), action("在允许控制时输入追加指令", "AGENT-06"), event("代理完成", "AGENT-02"), event("代理失败", "AGENT-03"), event("代理取消", "AGENT-04"), event("代理暂停", "AGENT-05"), event("收到该代理的问题", "AGENT-07")], "终态是条件分支，不是按列表顺序推进。"),
  "AGENT-06": entry(["AGENT-09"], "action", ["选中支持追加指令且仍可控制的子代理", "在子代理查看器内填写追加指令"], [action("提交指令并等待回执", "AGENT-09"), action("返回子代理列表", "AGENT-01")], "标本使用共享 Composer 和输入布局；提交、去重和回执仍由正式子代理控制器处理，副作用冻结。"),
  "AGENT-07": entry(["AGENT-09"], "event", ["收到属于当前子代理的模型提问", "在子代理公开记录内展示来源和问题卡片"], [action("在允许回答时提交答案并等待回执", "AGENT-09"), action("返回子代理列表", "AGENT-01")], "问题归属所选代理；离线或已处理时可读，不可重复提交。"),
  "QUESTION-1": entry(["RUN-01"], "event", ["当前回合收到需要单选或自由回答的模型问题"], [action("选择答案或填写文本，提交", "QUESTION-3"), event("问题被另一端处理或已失效", "QUESTION-4")]),
  "QUESTION-2": entry(["RUN-01"], "event", ["当前回合收到允许多选的模型问题"], [action("勾选答案并提交", "QUESTION-3"), event("问题被另一端处理或已失效", "QUESTION-4")], "多选由问题协议指定，不是单选卡片的下一阶段。"),
  "QUESTION-3": entry(["QUESTION-1", "QUESTION-2"], "action", ["点击问题卡片上的提交按钮，等待回执"], [event("答案已确认或问题已由另一端处理", "QUESTION-4"), event("提交失败且确认可重试", null, "原问题卡片恢复可答（未采样）")], "等待期间冻结重复提交；不能提前表示答案已接受。"),
  "QUESTION-4": entry(["QUESTION-1", "QUESTION-2", "QUESTION-3"], "event", ["当前客户端无可用回答权限，或问题已处理／已失效"], [action("继续阅读当前会话", "CHAT-01")], "这是多种只读条件的组件示例，不强行推断某一种服务端处理结果。"),
  "APPROVAL-1": entry(["RUN-01"], "event", ["收到需要审批的工具调用，且工具输入完整可展示"], [action("批准或拒绝该工具调用", "APPROVAL-2")], "不能仅凭审批卡片可见就认为当前客户端有权提交。"),
  "APPROVAL-2": entry(["APPROVAL-1"], "action", ["点击批准或拒绝后，审批回执尚未返回"], [event("审批回执确认，回合继续或结束", "RUN-01"), event("审批已被另一端处理", null, "只读审批结果（未采样）")], "返回运行状态只是其中一种分支，拒绝也可能结束当前回合。"),
  "APPROVAL-3": entry(["RUN-01"], "event", ["工具调用输入缺失或未完整接收，无法安全展示审批内容"], [event("输入补全且请求仍有效", "APPROVAL-1")], "禁止批准不完整输入；不是用户点“拒绝”产生的结果。"),
  "MODEL-1": entry(["DRAFT-01", "CHAT-01", "MODEL-2"], "mixed", ["点击输入区的模型标签", "目录已加载且存在可选模型"], [action("点击模型名称，切换成功后返回会话", "CHAT-01"), action("点击模型右侧箭头，进入详情调整推理强度", null, "模型详情（未采样）"), action("关闭选择器，保留原选择", "CHAT-01")], "点击模型名称后切换成功即关闭选择器；点击当前模型直接关闭，不重复写入。失败保留选择器与错误。列表不展示勾号或推理强度，只有右侧箭头打开详情；详情中的返回只退一层，不会新建会话。"),
  "MODEL-2": entry(["DRAFT-01", "CHAT-01"], "mixed", ["点击输入区的模型标签", "模型目录请求尚未完成"], [event("成功返回可选模型", "MODEL-1"), event("成功返回但目录为空", "MODEL-3"), event("目录读取失败", "MODEL-4")]),
  "MODEL-3": entry(["MODEL-2"], "event", ["目录读取成功，但没有符合当前范围的可选模型"], dismiss, "空目录不是网络失败；不会自动选择目录第一项。"),
  "MODEL-4": entry(["MODEL-2"], "event", ["读取模型目录的请求失败"], dismiss, "错误示例只描述选择器，不把读取失败当作当前会话或历史被清空。"),
  "ATTACH-1": entry(["DRAFT-01", "CHAT-01"], "action", ["点击输入区左下角“+”打开附件来源菜单"], [action("选择拍照、图库或文件，并返回所选资源", "ATTACH-2"), ...dismiss], "系统文件选择器和原生权限弹窗未采样。", ["当前连接、会话和附件能力允许添加附件。"]),
  "ATTACH-2": entry(["ATTACH-1"], "mixed", ["从系统选择器取得资源", "正在读取、准备或上传附件"], [event("附件准备成功", null, "输入区已附加附件（未采样）"), event("附件准备失败", "ATTACH-3")], "这是附件准备，不是后端正在生成答案，也不等同于发送恢复记录。"),
  "ATTACH-3": entry(["ATTACH-2"], "event", ["附件读取、准备或上传失败"], [action("重新选择附件来源", "ATTACH-1"), ...dismiss]),
  "MENU-01": entry(conversation, "action", ["点击会话页左上角返回图标，直接进入会话选择页"], [action("点项目过滤会话", "SEL-01"), action("点页头搜索", null, "历史会话页（未采样）"), action("点页头待处理", null, "待处理请求页（未采样）"), action("点页头设置，进入相关偏好", "SET-01")], "此入口不再打开导航菜单；阅读偏好示例不是设置首页。"),
  "MENU-02": entry(conversation, "action", ["点击会话页右上角省略号“更多”"], [action("选择“查看子代理”", "AGENT-01"), action("选择“搜索已加载正文”并输入关键字", "SEARCH-01"), action("选择“权限模式”", "PERM-01"), action("选择工作区入口并打开添加面板菜单", "WORK-01"), action("选择“快捷短语”", "INPUT-02"), action("选择“会话管理”", null, "重命名／压缩／归档／删除子菜单（未采样）"), action("关闭更多菜单", "CHAT-01")], "权限与快捷短语入口按连接、运行及归档条件开放；工作区面板菜单之间还有未采样中间页面。"),
  "PERM-01": entry(["MENU-02"], "action", ["在右上角“更多”中选择“权限模式”"], [action("选择允许使用的权限模式并返回会话", "CHAT-01"), ...dismiss], "切换的是会话权限配置，不会替某个正在等待的工具批准请求。"),
  "PERM-02": entry(["MENU-02"], "event", ["查看权限选择组件时，运行中、只读或连接条件不允许修改"], [event("恢复到允许修改的条件", "PERM-01"), ...dismiss], "禁用标本不是保证能从生产页点开的入口：真实入口也可能已禁用。"),
  "WORK-01": entry(["MENU-02"], "action", ["从更多菜单打开工作区", "点击工作区的添加面板入口"], [action("选择文件、终端或浏览器面板", null, "对应工作区面板（未采样）"), ...dismiss], "完整工作区与原生桌面行为未由此图验证。"),
  "SEARCH-01": entry(["MENU-02", "SEARCH-02"], "action", ["在更多菜单中选择“搜索已加载正文”", "输入能匹配当前已加载正文的关键字"], [action("上一处／下一处，跳到其他命中", "SEARCH-01"), action("改为没有匹配的关键字", "SEARCH-02"), action("关闭正文搜索", "CHAT-01")], "自链接表示同一状态内切换命中，不会打开另一个会话或搜索未加载历史。"),
  "SEARCH-02": entry(["MENU-02", "SEARCH-01"], "action", ["在已加载正文搜索框输入关键字", "当前已加载内容没有匹配"], [action("修改关键字并匹配正文", "SEARCH-01"), action("关闭搜索", "CHAT-01")], "无匹配不表示整个历史中没有该内容。"),
  "FILTER-01": entry([missing("历史会话页")], "action", ["点击历史页右上角筛选图标"], [action("切换服务器、项目或归档范围，返回历史", null, "过滤后的历史会话页（未采样）"), action("点击重置，恢复默认过滤", "FILTER-01")], "这里的筛选与会话选择页内点项目过滤是两个入口。"),
  "SEND-preparing": entry(["DRAFT-01", "INPUT-01"], "action", ["点击“发送”", "后台先将本次发送的恢复记录保存到本机，不展示保存卡片"], [event("恢复记录已保存，继续准备消息", "SEND-retaining"), event("准备过程确认失败", "SEND-failed")], "保持消息区和输入区布局；首次发送才创建后端会话，进草稿页面本身不会创建。"),
  "SEND-retaining": entry(["SEND-preparing"], "event", ["恢复记录写入完成", "后台继续准备消息或保留发送所需附件，不插入恢复卡片"], [event("准备完毕并发起请求", "SEND-sending"), event("准备确认失败", "SEND-failed")], "不一定有附件；恢复记录的保存与后端排队消息分别管理。"),
  "SEND-sending": entry(["SEND-retaining"], "event", ["发送请求已发出，后台等待服务端回执，不插入恢复卡片"], [event("服务端确认接收", "SEND-accepted"), event("连接中断，无法确认是否执行", "SEND-unknown"), event("服务端明确拒绝或失败", "SEND-failed")], "三个结果是分支；未知或失败时展示处理入口，等待超时不能直接判成失败。"),
  "SEND-accepted": entry(["SEND-sending", "SEND-unknown"], "event", ["收到权威接收回执或核对结果，已绑定对应回合", "会话正文投影尚在同步"], [event("运行状态同步到客户端", "RUN-01"), event("正文同步完成", "CHAT-01")], "已接收不等于模型已完成；不会自动重新发送原问题。"),
  "SEND-unknown": entry(["SEND-sending"], "event", ["请求可能已执行，但没有收到可确认结果的回执"], [event("核对后确认已接收", "SEND-accepted"), event("核对后确认失败", "SEND-failed"), event("尚无权威核对结果，保持记录", "SEND-unknown")], "不能盲目重发；先按稳定请求身份核对，避免重复副作用。"),
  "SEND-failed": entry(["SEND-preparing", "SEND-retaining", "SEND-sending", "SEND-unknown"], "event", ["准备失败，或回执／权威核对确认本次发送失败", "保留可恢复草稿供用户处理"], [action("确认允许重试后，点击手动重试", "SEND-preparing"), action("移除这条失败草稿", "CHAT-01")], "卡片浮在输入区上方，不挤动正文；多条或长内容内部滚动。移除只针对失败草稿；不删除已确认的会话历史。"),
  "SET-01": entry(["MENU-01", missing("会话选择页 → 设置")], "action", ["打开设置", "进入阅读／会话偏好"], [action("调整偏好后回到会话查看效果", "CHAT-01"), action("在设置内进入快捷短语", "SET-02")], "设置首页和中间分类页未采样；本图是共享阅读偏好组件。"),
  "SET-02": entry(["MENU-01", "SET-01"], "action", ["打开设置中的快捷短语管理"], [action("点击某条短语的编辑入口", "SET-03"), action("返回会话并打开短语选择器", "INPUT-02")], "本机管理与会话内插入是不同界面，中间设置导航未采样。"),
  "SET-03": entry(["SET-02"], "action", ["点击某条快捷短语的编辑按钮"], [action("保存或取消编辑", "SET-02")], "图册标本只修改内存数据，不更改用户本机短语。"),
  "INPUT-02": entry(["MENU-02"], "action", ["在会话更多菜单中选择“快捷短语”"], [action("选择一条短语，插入输入框", "INPUT-01"), action("关闭选择器，保留原输入", "CHAT-01")], "插入不会自动发送；也可从展开后的输入区工具入口进入。"),
};

for (const [id, status] of [["AGENT-02", "已完成"], ["AGENT-03", "失败"], ["AGENT-04", "已取消"], ["AGENT-05", "已暂停"]]) {
  currentTransitions[id] = entry(["AGENT-01", "AGENT-09"], "mixed", ["在子代理列表中选择一项，或当前记录收到状态更新", `所选代理状态为${status}，展示其公开记录`], [action("返回子代理列表", "AGENT-01"), action("返回父会话", "CHAT-01")], "已加载的公开记录保留可读；不将完成、失败、取消和暂停混为同一个结果。");
}

export function validateTransitions(cases, transitions = currentTransitions) {
  const ids = new Set(cases.map(([id]) => id));
  if (ids.size !== cases.length || Object.keys(transitions).length !== ids.size) throw new Error("Transition coverage must match every unique captured state");
  for (const id of Object.keys(transitions)) {
    const value = transitions[id];
    if (!ids.has(id) || !["action", "event", "mixed"].includes(value.trigger.kind) || !value.trigger.steps.length || !value.from.length || !value.next.length) throw new Error(`Incomplete transition: ${id}`);
    for (const node of [...value.from, ...value.next]) {
      if (node.id ? !ids.has(node.id) || node.unsampled : !node.unsampled || !node.label) throw new Error(`Invalid transition reference: ${id} -> ${node.id ?? node.label}`);
    }
    for (const node of value.next) if (!["action", "event"].includes(node.kind) || !node.text) throw new Error(`Missing outgoing trigger: ${id}`);
  }
}

export function resolvedTransition(id, cases) {
  const labels = new Map(cases.map(([key, label]) => [key, label]));
  const value = currentTransitions[id];
  const label = node => ({ ...node, label: node.id ? labels.get(node.id) : node.label });
  return { ...value, from: value.from.map(label), next: value.next.map(label) };
}
