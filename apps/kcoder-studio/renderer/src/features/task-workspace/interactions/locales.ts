export const taskInteractionResources = {
  en: {
    columns: { prompt: 'Item', state: 'State' },
    openOriginal: 'Open the original conversation',
    originalRequired:
      'Some original requests require their conversation’s full presentation. Open that conversation to handle them; no response is sent from this card.',
    title: 'Original pending confirmations',
    description:
      'Read and answer the original parent task’s requests. Each answer stays bound to its original turn and request.',
    unknown:
      'Current confirmations have not been verified. Open the original task or refresh; a missing record is not an empty queue.',
    empty: 'No pending items remain in these verified original receipts.',
    refresh: 'Read current receipts',
    cancel: 'Cancel read',
    dismiss: 'Dismiss this card',
    states: {
      pending: 'Waiting for your response',
      response_pending: 'Response sent; awaiting native confirmation',
      resolved: 'The original native request is resolved',
      unknown:
        'The response outcome is unknown. Read the original receipt before any further action.',
    },
    errors: {
      unavailable:
        'The original interaction connection is unavailable. Open the original task to inspect it.',
      scope_changed: 'The target or account changed. Reopen the original task.',
      cancelled: 'Reading was cancelled. The original task continues.',
      invalid_reply: 'The original interaction could not be verified.',
      outcome_unknown: 'The response outcome is unconfirmed. It has not been sent again.',
    },
  },
  'zh-CN': {
    columns: { prompt: '事项', state: '状态' },
    openOriginal: '打开原会话处理',
    originalRequired: '部分原始请求需要原会话的完整交互界面，请打开原会话处理；此卡片未发送回应。',
    title: '原任务待确认事项',
    description: '读取并回应原父任务的请求，每次回应都绑定原回合与原请求。',
    unknown: '尚未核对当前待确认事项，可打开原任务或刷新；缺少记录不表示队列为空。',
    empty: '这些已核对的原始回执中没有剩余待确认事项。',
    refresh: '读取当前回执',
    cancel: '取消读取',
    dismiss: '关闭此卡片',
    states: {
      pending: '等待你的回应',
      response_pending: '回应已发送，正在等待原生确认',
      resolved: '原生请求已处理',
      unknown: '回应结果未知，请先核对原始回执再决定下一步。',
    },
    errors: {
      unavailable: '原交互连接暂不可用，请打开原任务核对。',
      scope_changed: '运行目标或账户已变化，请重新打开原任务。',
      cancelled: '已取消读取，原任务仍按原状态保留。',
      invalid_reply: '无法核对原交互回执。',
      outcome_unknown: '回应结果尚未确认，未再次发送。',
    },
  },
} as const
