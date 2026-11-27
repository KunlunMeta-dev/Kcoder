import { expectTypeOf, test } from 'vitest'
import type { useWorkbenchRuntimeMessaging } from './useWorkbenchRuntimeMessaging'
import type {
  CreateProjectRuntimeTaskOptions,
  CreateTemporaryRuntimeTaskOptions,
  RuntimePaneActionOptions,
  SendCurrentInputOptions,
  WorkbenchContextValue,
} from './workbenchContextTypes'

type ConversationAction =
  | 'sendRuntimePaneMessage'
  | 'interruptAndSendRuntimePaneMessage'
  | 'sendRuntimePaneGuidance'
  | 'compactRuntimePaneTask'
  | 'editLastUserMessage'
  | 'cancelRuntimePaneTask'
  | 'sendCurrentInput'
  | 'createTemporaryRuntimeTask'
  | 'createProjectRuntimeTask'
  | 'retryFailedMessage'
  | 'pauseCurrentResponse'
  | 'shortenCurrentWait'

type ContextArguments = {
  [Action in ConversationAction]: Parameters<WorkbenchContextValue[Action]>
}
type ImplementationArguments = {
  [Action in ConversationAction]: Parameters<ReturnType<typeof useWorkbenchRuntimeMessaging>[Action]>
}
type RequiredArguments<Actions> = { [Action in keyof Actions]: Required<Actions[Action]> }

test('both conversation entry points require explicit action arguments', () => {
  expectTypeOf<ContextArguments>().toEqualTypeOf<RequiredArguments<ContextArguments>>()
  expectTypeOf<ImplementationArguments>().toEqualTypeOf<RequiredArguments<ImplementationArguments>>()
})

test('every conversation action options type requires an error callback', () => {
  type Options = RuntimePaneActionOptions | SendCurrentInputOptions |
    CreateTemporaryRuntimeTaskOptions | CreateProjectRuntimeTaskOptions
  expectTypeOf<Options>().toMatchTypeOf<{ onError: (error: string) => void }>()
})
