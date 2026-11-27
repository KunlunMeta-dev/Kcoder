import {runIntegration} from '../../e2e/harness/run-context.mjs';
import {verifyNativeApplicationTasks} from '../../e2e/harness/native-application-tasks.mjs';

await runIntegration(import.meta.url,{
 testId:'native-original-application-six-business-tasks-and-final-ui-approval',
 tier:'full-integration',
 modelPolicy:'Six independent original native application read/effect tasks, owned MCP business objects and receipts, canonical original attachment/CSV bytes and actual final approval UI. Controlled independent Provider protocol only; zero paid models, branded-account or model-quality claims.',
 retainSuccessEvidence:true,
 retainSuccessLogs:true,
},context=>verifyNativeApplicationTasks(context,{businessGreen:true}));
