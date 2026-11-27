// Office and Agent management share the same owner-bound transport.
export { resourceTransport as nativeOfficeTransport } from './resourceTransport'
export type {
  ResourceTarget as NativeOfficeTarget,
  ResourceFiles as NativeOfficeFiles,
  ResourceDownloadResult as NativeOfficeDownloadResult,
} from './resourceTransport'
