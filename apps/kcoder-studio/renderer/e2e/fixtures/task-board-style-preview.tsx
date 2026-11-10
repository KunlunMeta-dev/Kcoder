import { useState } from 'react'
import { Columns3 } from 'lucide-react'
import { TaskBoard } from '../../src/features/task-workspace/TaskBoard'
import type { TaskWorkspaceThreadChoice } from '../../src/features/task-workspace/NativeTaskWorkspace'

const examples = [
  ['整理本周会议纪要', 'idle', undefined],
  ['核对项目报销材料', 'idle', undefined],
  ['生成月度经营分析报告', 'running', undefined],
  ['汇总竞品资料与来源', 'background', undefined],
  ['确认报告导出权限', 'waiting_approval', undefined],
  ['补充材料统计口径', 'waiting_answer', undefined],
  ['北京出行攻略', 'idle', 'completed'],
  ['周报汇总与校对', 'idle', 'completed'],
  ['整理客户需求清单', 'idle', 'completed'],
  ['更新材料目录', 'failed', 'failed'],
  ['恢复中断的数据分析', 'idle', 'interrupted'],
  ['待同步的历史任务', undefined, undefined],
] as const
const tasks = examples.map(([title, activity, status], index) => ({
  threadId: `preview-${index}`, title, workspacePath: '/preview',
  board: { targetLabel: '当前计算机', stale: false, task: {
    taskId: `preview-${index}`, threadId: `preview-${index}`, title, runtime: 'kcoder',
    runActivity: activity, turnStatus: status, updatedAt: new Date(Date.now() - (index < 8 ? index : index < 10 ? 12 : 40) * 86400000).toISOString(),
    runSummary: { recentError: status === 'interrupted' ? { kind: 'interrupted' } : null },
  } },
})) as TaskWorkspaceThreadChoice[]
export function TaskBoardStylePreview() {
  const [selected, setSelected] = useState<TaskWorkspaceThreadChoice>()
  return <section className="studio-page-gutter py-6">
    <h1 className="heading-base mb-2 flex items-center gap-2"><Columns3 className="size-5" />任务看板</h1>
    <p className="mb-6 text-sm text-text-secondary">查看任务进度，处理待确认事项，点击卡片查看详情。</p>
    <TaskBoard tasks={tasks} listingState="ready" onSelect={setSelected} canOpen={() => true} onOpen={setSelected} />
    {selected && <p className="mt-4 text-sm" role="status">已选择：{selected.title}</p>}
  </section>
}
