import { runIntegration } from '../../e2e/harness/run-context.mjs';

const resourceMode = process.env.KCODER_E2E_APPLICATION_TASKS;
const applicationOAuth = process.env.KCODER_E2E_APPLICATION_OAUTH === '1';
const providerRevocation = process.env.KCODER_E2E_APPLICATION_OAUTH === 'provider_revocation';
const storageUnknown = process.env.KCODER_E2E_APPLICATION_OAUTH === 'storage_unknown';
await runIntegration(import.meta.url, {
  testId: 'application-native-controls', tier: 'full-integration',
  modelPolicy: 'Owned application/MCP/OAuth protocol fixtures with existing Native application protections. Fixed bounded local provider where required; no channel authentication, platform send or paid model acceptance.',
}, async context => {
  if(storageUnknown){
    const {verifyNativeUnknownStorageRecovery}=await import('../../e2e/harness/native-unknown-storage-recovery.mjs');
    return verifyNativeUnknownStorageRecovery(context);
  }
  if(resourceMode==='bindings'){
    const {verifyNativeTaskResourceBindings}=await import('../../e2e/harness/native-task-resource-bindings.mjs');
    return verifyNativeTaskResourceBindings(context);
  }
  if(resourceMode==='bindings_ui'){
    const {verifyNativeTaskResourceBindingsUi}=await import('../../e2e/harness/native-task-resource-bindings-ui.mjs');
    return verifyNativeTaskResourceBindingsUi(context);
  }
  if(providerRevocation){
    const {verifyNativeProviderRevocation}=await import('../../e2e/harness/native-provider-revocation.mjs');
    return verifyNativeProviderRevocation(context);
  }
  if(applicationOAuth){
    const {verifyNativeApplicationOAuth}=await import('../../e2e/harness/native-application-oauth.mjs');
    return verifyNativeApplicationOAuth(context);
  }
  const { verifyNativeApplicationTasks } = await import('../../e2e/harness/native-application-tasks.mjs');
  return verifyNativeApplicationTasks(context);
});
