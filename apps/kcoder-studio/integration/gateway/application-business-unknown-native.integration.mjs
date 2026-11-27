import {runIntegration} from '../../e2e/harness/run-context.mjs';
import {verifyNativeApplicationTasks} from '../../e2e/harness/native-application-tasks.mjs';
await runIntegration(import.meta.url,{
 testId:'native-original-application-unknown-effect-read-only-platform-lookup',tier:'full-integration',
 modelPolicy:'Actual original native task and real final approval UI; one owned MCP create succeeds but its acknowledgment is suppressed, then the original registered read-only API looks up that idempotency key. No second write, SDK, paid model or branded account.',
 retainSuccessLogs:true,
},context=>verifyNativeApplicationTasks(context,{businessGreen:true,businessLookupProbe:true}));
