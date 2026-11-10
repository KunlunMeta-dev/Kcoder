import type { MobileMigrationClient } from '../migration-client';
import type { SourceUploadCalls } from '../migration-client/source-upload-contracts';
/** A finite typed API surface; it cannot tunnel an arbitrary RPC method. */
export function createMobileSourceUploadApi(client: MobileMigrationClient) {
  const call = <N extends keyof SourceUploadCalls>(name: N, input: SourceUploadCalls[N][0]) => client.call(name, input);
  return {
    sourceUploadPrepare: (p: SourceUploadCalls['sourceUploadPrepare'][0]) => call('sourceUploadPrepare', p),
    sourceUploadRead: (p: SourceUploadCalls['sourceUploadRead'][0]) => call('sourceUploadRead', p),
    sourceUploadFiles: (p: SourceUploadCalls['sourceUploadFiles'][0]) => call('sourceUploadFiles', p),
    sourceUploadPart: (p: SourceUploadCalls['sourceUploadPart'][0]) => call('sourceUploadPart', p),
    sourceUploadFinish: (p: SourceUploadCalls['sourceUploadFinish'][0]) => call('sourceUploadFinish', p),
    sourceUploadResume: (p: SourceUploadCalls['sourceUploadResume'][0]) => call('sourceUploadResume', p),
    sourceUploadCancel: (p: SourceUploadCalls['sourceUploadCancel'][0]) => call('sourceUploadCancel', p),
    sourceProductRead: (p: SourceUploadCalls['sourceProductRead'][0]) => call('sourceProductRead', p),
    sourceProductRun: (p: SourceUploadCalls['sourceProductRun'][0]) => call('sourceProductRun', p),
    sourceProductResume: (p: SourceUploadCalls['sourceProductResume'][0]) => call('sourceProductResume', p),
    sourceProductCancel: (p: SourceUploadCalls['sourceProductCancel'][0]) => call('sourceProductCancel', p),
  };
}
