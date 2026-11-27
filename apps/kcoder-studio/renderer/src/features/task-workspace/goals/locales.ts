export const taskGoalResources = {
  en: {
    recentEvents: 'Recent original events', eventBound: 'The native reader returns up to five recent events.',
    recordedTokens: 'Recorded tokens', recordedBudget: 'Recorded token budget', recordedTime: 'Recorded execution time',
    seconds: 'seconds', noBudget: 'Not set', previewBound: 'Showing the first 16,000 characters. Open the original conversation for the full objective.',
    errors: {
      cancelled: 'Reading was cancelled. The Goal continues unchanged.',
      scope_changed: 'The target or account changed. Select the original task again.',
      unavailable: 'The original Goal is unavailable. Check the target and access, then refresh.',
      unsupported: 'This target did not provide the original Goal identity. Update its KCoder runtime.',
      reference_changed: 'The selected Goal is no longer current. It has not been replaced with another Goal in this view.',
      invalid_reply: 'The original Goal observation could not be verified. Return to the task and refresh.',
    },
  },
  'zh-CN': {
    recentEvents: '最近的原始事件', eventBound: '原生接口最多返回最近 5 条事件。',
    recordedTokens: '已记录 Token', recordedBudget: '已记录 Token 预算', recordedTime: '已记录执行时间',
    seconds: '秒', noBudget: '未设置', previewBound: '当前显示前 16,000 个字符，可打开原会话查看完整目标。',
    errors: {
      cancelled: '已取消读取，目标仍按原状态保留。',
      scope_changed: '目标或账户已变化，请重新选择原任务。',
      unavailable: '暂时无法读取原目标，请检查运行目标和权限后刷新。',
      unsupported: '当前目标未返回原始 Goal 身份，请更新目标上的 KCoder。',
      reference_changed: '所选 Goal 已不再是当前目标，此页面未自动替换为其他 Goal。',
      invalid_reply: '无法核对原始 Goal 观察，请返回任务后刷新。',
    },
  },
} as const
