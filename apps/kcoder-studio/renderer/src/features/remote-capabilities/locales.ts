export const remoteCapabilityResources = {
  en: {
    operation: {
      recent: 'Read ten recent original operations', receiverLinked: 'Receiver observed', receiverNotObserved: 'Receiver unobserved', selectConversation: 'Select the original conversation before reading its remote operation.', selectedTarget: 'Selected conversation target', title: 'Original remote operation', description: 'Read the original receiver and cleanup receipts. This never starts or repeats a remote task.', id: 'Original operation ID', read: 'Read original operation', reading: 'Reading…', notFound: 'No original operation was found in this target and workspace.', task: 'Receiver task', cleanup: 'Process cleanup', artifact: 'Received artifact', businessPartial: 'Transport and reader observations do not verify business correctness. The result remains partial.', cancel: 'Request cancellation', details: 'Receipt details', receiver: 'Original receiver', protocol: 'Protocol observations', unknownCancellation: 'The cancellation receipt is unknown. Read this original operation before taking another action.', cancelTitle: 'Cancel this original operation?', cancelDescription: 'Only this original receiver is affected. A cancellation request is separate from confirmed task termination and process cleanup.', confirmCancel: 'Request cancellation', back: 'Back', errors: { upgrade: 'This target does not provide original-operation control. Upgrade the target and reconnect.', ownerChanged: 'The account, target or connection changed. Read the original operation in the current context.', unavailable: 'The original operation could not be confirmed. Keep its ID and read it again.' }, status: { not_observed: 'Not observed', accepted: 'Accepted; terminal unconfirmed', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted', unknown: 'Outcome unknown' }, cleanupStatus: { not_observed: 'Not observed', unconfirmed: 'Unconfirmed', confirmed: 'Confirmed' },
    },

    title: 'Remote capability directory',
    description:
      'Observations from existing authorized connections. Execution permissions are checked when a task runs.',
    refresh: 'Refresh observations',
    next: 'Next page',
    restart: 'Read from the beginning',
    loading: 'Reading observations…',
    unavailable:
      'The directory is unavailable in this connection. Check the current Gateway and refresh.',
    stale:
      'The account, target, or connection changed. Read from the beginning for current observations.',
    empty: 'No configured targets are visible to this account.',
    unknown: 'Unknown',
    observed: 'Observed',
    advertised: 'Advertised',
    unavailableState: 'Unavailable',
    denied: 'Denied',
    protocol: 'Protocol',
    identity: 'Native identity',
    business: 'Task execution',
    details: 'Observation details',
    owner: 'Observed native owner',
    location: 'Data location',
    lastObserved: 'Last observed',
    schema: 'Public contract references',
    schemaUnknown: 'Producer schema revision has not been observed.',
    requestPolicy:
      'Models, budget, tools, confirmations and transfers require current native checks.',
    selected_native_target: 'Selected native target',
    gateway_to_selected_target: 'Gateway to selected target',
    notObserved: 'Not observed',
    relay_registration_on_gateway: 'Private Gateway registration (path withheld)',
    reasons: {
      ACP_INBOUND_PROTOCOL_ADVERTISED:
        'The native binary advertises its inbound ACP v1 bridge; no ACP session or outbound task is running.',
      ACP_INBOUND_IMPLEMENTATION_NOT_OBSERVED:
        'The current target has not provided an inbound ACP declaration.',
      RELAY_DURABLE_REGISTRATION_OBSERVED_NOT_ONLINE_VERIFIED:
        'The private Relay registration is valid for this Gateway and origin. Live routing and business execution are not verified.',
      RELAY_REGISTRATION_NOT_CONFIGURED: 'No native Relay registration source is configured.',
      RELAY_REGISTRATION_UNAVAILABLE:
        'The configured private Relay registration could not be verified.',
      RELAY_METADATA_ACCESS_DENIED: 'This account cannot read Gateway registration metadata.',
      RELAY_METADATA_HOST_UPGRADE_REQUIRED:
        'The Gateway does not provide Relay metadata observations.',
      REMOTE_TARGET_STATUS_UNAVAILABLE: 'The current target status could not be verified.',
      REMOTE_PROTOCOL_HANDSHAKE_OBSERVED:
        'The current connection completed its native protocol handshake.',
      REMOTE_CAPABILITY_LIST_INCOMPLETE:
        'The handshake was observed; its capability list could not be fully represented.',
      REMOTE_CONNECTION_NOT_OBSERVED:
        'No live initialized connection has been observed. Use the normal target connection first.',
      REMOTE_TARGET_OFFLINE: 'The target was reported offline; no fallback target was selected.',
      REMOTE_CAPABILITY_ADVERTISED_NOT_BUSINESS_VERIFIED:
        'The target advertised this protocol. Business execution has not been verified.',
      REMOTE_CAPABILITY_NOT_ADVERTISED: 'The current handshake did not advertise this capability.',
      ACP_OUTBOUND_RUNNER_NOT_REGISTERED:
        'No outbound ACP runner is registered. Inbound ACP support does not provide delegation.',
      RELAY_AUTHENTICATED_REGISTRATION_NOT_OBSERVED:
        'Authenticated Relay registration has not been observed. Relay routing does not grant native execution permission.',
    },
  },
  'zh-CN': {
    operation: {
      recent: '读取最近十条原操作', receiverLinked: '已观察接收任务', receiverNotObserved: '接收任务未观察', selectConversation: '请先选择原会话，再核对它的远端操作。', selectedTarget: '当前会话目标', title: '原远端操作', description: '核对原接收任务与清理回执，不启动或重放远端任务。', id: '原 operation ID', read: '读取原操作', reading: '正在核对…', notFound: '当前目标与工作区未找到该原操作。', task: '接收任务', cleanup: '进程清理', artifact: '已接收成果', businessPartial: '传输与阅读记录不代表业务正确，成果仍待完整核验。', cancel: '请求取消', details: '回执详情', receiver: '原接收任务', protocol: '协议观察', unknownCancellation: '取消回执未知。请先读取这个原操作，再决定后续动作。', cancelTitle: '取消这个原操作？', cancelDescription: '只影响这个原接收任务。请求取消与确认任务终止、进程清理分别记录。', confirmCancel: '请求取消', back: '返回', errors: { upgrade: '当前目标未提供原操作管理，请升级目标并重新连接。', ownerChanged: '账户、目标或连接已改变，请在当前归属下读取原操作。', unavailable: '暂时无法确认原操作。请保留 ID 并重新读取。' }, status: { not_observed: '尚未观察', accepted: '已接纳，终态未确认', completed: '已完成', failed: '失败', interrupted: '已中断', unknown: '结果未知' }, cleanupStatus: { not_observed: '尚未观察', unconfirmed: '未确认', confirmed: '已确认' },
    },

    title: '远端能力目录',
    description: '查看已有授权连接的观察记录。实际执行任务时会重新检查原生权限。',
    refresh: '刷新观察记录',
    next: '下一页',
    restart: '从头读取',
    loading: '正在读取观察记录…',
    unavailable: '当前连接暂时无法读取目录，请检查 Gateway 后刷新。',
    stale: '账户、目标或连接已变化，请从头读取当前观察记录。',
    empty: '当前账户没有可见的运行目标。',
    unknown: '未知',
    observed: '已观察',
    advertised: '协议已声明',
    unavailableState: '不可用',
    denied: '已拒绝',
    protocol: '协议',
    identity: '原生身份',
    business: '任务执行',
    details: '观察详情',
    owner: '已观察的原生归属',
    location: '数据位置',
    lastObserved: '观察时间',
    schema: '公开合同引用',
    schemaUnknown: '尚未观察到远端的 schema 修订。',
    requestPolicy: '模型、预算、工具、确认和文件传输仍须通过当前原生检查。',
    selected_native_target: '所选原生运行目标',
    gateway_to_selected_target: 'Gateway 至所选运行目标',
    notObserved: '尚未观察',
    relay_registration_on_gateway: 'Gateway 私有注册记录（不公开路径）',
    reasons: {
      ACP_INBOUND_PROTOCOL_ADVERTISED:
        '原生二进制已声明入站 ACP v1 桥接，不表示存在活动 ACP 会话或出站任务。',
      ACP_INBOUND_IMPLEMENTATION_NOT_OBSERVED: '当前目标尚未提供入站 ACP 声明。',
      RELAY_DURABLE_REGISTRATION_OBSERVED_NOT_ONLINE_VERIFIED:
        '私有 Relay 注册与当前 Gateway 和 origin 绑定一致；尚未验证在线路由和业务执行。',
      RELAY_REGISTRATION_NOT_CONFIGURED: '尚未配置原生 Relay 注册来源。',
      RELAY_REGISTRATION_UNAVAILABLE: '无法核实已配置的私有 Relay 注册记录。',
      RELAY_METADATA_ACCESS_DENIED: '当前账户无权读取 Gateway 注册元数据。',
      RELAY_METADATA_HOST_UPGRADE_REQUIRED: '当前 Gateway 尚不提供 Relay 元数据观察。',
      REMOTE_TARGET_STATUS_UNAVAILABLE: '尚未核实当前目标状态。',
      REMOTE_PROTOCOL_HANDSHAKE_OBSERVED: '当前连接已完成原生协议握手。',
      REMOTE_CAPABILITY_LIST_INCOMPLETE: '已观察到握手，但能力清单未能完整表示。',
      REMOTE_CONNECTION_NOT_OBSERVED: '尚未观察到已初始化的活动连接，请先通过正常入口连接目标。',
      REMOTE_TARGET_OFFLINE: '目标被报告为离线，未选择其他目标代替。',
      REMOTE_CAPABILITY_ADVERTISED_NOT_BUSINESS_VERIFIED: '目标已声明此协议，尚未验证业务执行。',
      REMOTE_CAPABILITY_NOT_ADVERTISED: '当前握手未声明此能力。',
      ACP_OUTBOUND_RUNNER_NOT_REGISTERED:
        '尚未注册出站 ACP runner，入站 ACP 支持不代表可以向外委派。',
      RELAY_AUTHENTICATED_REGISTRATION_NOT_OBSERVED:
        '尚未观察到已认证的 Relay 注册，Relay 路由不授予原生执行权限。',
    },
  },
}
