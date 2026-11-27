import type { ReactNode } from 'react'

/** One presentation for original task records, including unknown and verified-empty reads. */
export function TaskWorkspaceTable({
  label,
  columns,
  emptyMessage,
  testId,
  children,
}: {
  label: string
  columns: string[]
  emptyMessage?: string
  testId: string
  children?: ReactNode
}) {
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border">
      <div className="overflow-x-auto">
        <table
          aria-label={label}
          data-testid={testId}
          className="w-full min-w-[28rem] text-left text-sm text-text-primary [&_td]:px-4 [&_td]:py-3 [&_td]:align-top"
        >
          <thead className="border-b border-border/60 bg-surface/60 text-xs text-text-secondary">
            <tr>
              {columns.map((column, index) => (
                <th
                  key={column}
                  scope="col"
                  className={`px-4 py-3 font-medium ${index === columns.length - 1 && index > 0 ? 'text-right' : ''}`}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {emptyMessage ? (
              <tr>
                <td colSpan={columns.length}>
                  <p role="status" className="py-5 text-center text-sm text-text-secondary">
                    {emptyMessage}
                  </p>
                </td>
              </tr>
            ) : (
              children
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
