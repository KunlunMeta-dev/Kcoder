import { useState } from 'react'
import { ChatInput } from '../../src/components/chat/ChatInput'
import type { WorkbenchMessage } from '../../src/types/workbench'

const userMessage = (id: string, content: string): WorkbenchMessage => ({
  id,
  role: 'user',
  content,
  status: 'done',
  createdAt: '',
})

export function InputHistoryFixture() {
  const [scope, setScope] = useState('first')
  const [value, setValue] = useState('未发送的草稿')
  const [messages, setMessages] = useState<WorkbenchMessage[]>([
    userMessage('first', '第一条输入 中文🙂'),
    {
      id: 'answer',
      role: 'assistant',
      content: '模型输出不应进入输入历史',
      status: 'done',
      createdAt: '',
    },
    userMessage('second', '第二条输入\n保留换行'),
  ])
  const [sent, setSent] = useState(0)
  const variant =
    new URLSearchParams(location.search).get('variant') === 'compact' ? 'compact' : 'desktop'
  return (
    <main className="p-6">
      <button
        data-testid="fixture-history-switch-keep"
        onClick={() => {
          setScope('other')
          setMessages([userMessage('other', '其他会话的输入')])
        }}
      >
        Switch while retaining the supplied value
      </button>
      <button
        data-testid="fixture-history-switch"
        onClick={() => {
          setScope('other')
          setMessages([userMessage('other', '其他会话的输入')])
          setValue('')
        }}
      >
        Switch conversation
      </button>
      <output data-testid="fixture-history-draft">{value}</output>
      <output data-testid="fixture-history-sent">{sent}</output>
      <div data-testid="fixture-history-width" className="w-full max-w-xl">
        <ChatInput
          value={value}
          onChange={setValue}
          disabled={false}
          variant={variant}
          historyMessages={messages}
          inputHistoryScope={scope}
          onSubmit={text => {
            setMessages(previous => [...previous, userMessage(`sent-${sent}`, text ?? value)])
            setSent(previous => previous + 1)
            setValue('')
          }}
        />
      </div>
    </main>
  )
}
