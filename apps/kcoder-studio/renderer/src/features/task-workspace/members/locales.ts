export const taskMemberResources = {
  en: {
    loading: 'Reading the original member run…',
    unavailable:
      'This exact member run is unavailable. Open its original parent task to inspect retained records; no latest run was selected.',
    back: 'Return to original parent task',
    continueHint: 'Send to continue this finished member. The original record stays unchanged; reopen the new run from the task workspace.',
  },
  'zh-CN': {
    loading: '正在读取原成员运行…',
    unavailable: '暂时无法查看这个精确成员运行。可返回原父任务检查保留记录；没有切换到最新运行。',
    back: '返回原父任务',
    continueHint: '发送后按此指令续跑已结束成员。原记录保留，可从任务空间打开新运行。',
  },
} as const
