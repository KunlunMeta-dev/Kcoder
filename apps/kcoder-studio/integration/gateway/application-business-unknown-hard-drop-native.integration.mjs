import {runIntegration} from '../../e2e/harness/run-context.mjs';
import {verifyNativeApplicationTasks} from '../../e2e/harness/native-application-tasks.mjs';
await runIntegration(import.meta.url,{
 testId:'native-original-application-hard-drop-remains-unknown-without-replay',tier:'full-integration',
 modelPolicy:'Original real UI approval and one owned platform effect followed by a hard transport drop; no new client/SDK or write. The original operation remains unknown when its registered lookup transport is unavailable. Zero paid model or branded account.',
 retainSuccessLogs:true,
},context=>verifyNativeApplicationTasks(context,{businessGreen:true,businessLookupProbe:true,businessHardDrop:true}));
