import {runE2E} from '../../harness/run-context.mjs';
import {verifyNativeApplicationTasks} from '../../harness/native-application-tasks.mjs';
await runE2E(import.meta.url,{
 testId:'native-original-application-bounded-read-source-transport',
 tier:'full-integration',
 modelPolicy:'One original reviewed MCP document read and canonical management consumer, zero business effects. Controlled independent Provider protocol only.',
 retainSuccessEvidence:true,
 retainSuccessLogs:true,
},context=>verifyNativeApplicationTasks(context,{businessGreen:true,businessReadProbe:true,
 businessReadSource:process.env.KCODER_E2E_APPLICATION_READ_SOURCE??'document'}));
