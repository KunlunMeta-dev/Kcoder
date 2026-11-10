import {runE2E} from '../../harness/run-context.mjs';
import {verifyTwoNativeTaskCapabilitySourceAccounts} from '../../harness/native-task-capability-source-two-accounts.mjs';

await runE2E(import.meta.url,{
 testId:'two-real-native-task-capability-sources-survive-target-reopen',
 tier:'full-integration',
 modelPolicy:'Two actual Thread/Turn Accepted tasks select different configured MCP connectors and Native OAuth account refs through existing SetTaskSources; actual controlled MCP calls and cold target-process reopen. Four bounded local protocol responses, zero paid/vendor calls. No browser rows or forged source/account refs.',
 retainSuccessEvidence:true,
},verifyTwoNativeTaskCapabilitySourceAccounts);
