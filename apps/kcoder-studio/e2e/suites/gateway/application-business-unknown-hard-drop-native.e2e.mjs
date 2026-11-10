import {runE2E} from '../../harness/run-context.mjs';
import {verifyNativeApplicationTasks} from '../../harness/native-application-tasks.mjs';
await runE2E(import.meta.url,{
 testId:'native-original-application-hard-drop-remains-unknown-without-replay',tier:'full-integration',
 modelPolicy:'Original real UI approval and one owned platform effect followed by a hard transport drop; no new client/SDK or write. The original operation remains unknown when its registered lookup transport is unavailable. Zero paid model or branded account.',
 retainSuccessLogs:true,
},context=>verifyNativeApplicationTasks(context,{businessGreen:true,businessLookupProbe:true,businessHardDrop:true}));
