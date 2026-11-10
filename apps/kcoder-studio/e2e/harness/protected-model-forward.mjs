import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startLiveModelObserver, liveModelRequestPath } from './live-model-observer.mjs';

/** Read the approved API credential only in the host; children receive an expiring lease. */
export async function protectedModelForward(context, model, budget, options = {}) {
  const env = options.env ?? process.env;
  if (env.KCODER_E2E_REAL_MODEL !== '1' || env.KCODER_TEST_SEARCH_EXTERNAL !== '1')
    throw Error('UNMET_PREREQUISITE: model and public-search consent required before reading approved auth');
  if (!['anthropic_messages', 'openai_chat_completions'].includes(model.providerConfig.api_format))
    throw Error('UNMET_PREREQUISITE: Octop baseline supports approved Anthropic Messages or OpenAI Chat Completions only');
  let credential;
  try {
    const path = resolve(model.configDir, 'credentials.json');
    if (!(await lstat(path)).isFile()) throw Error('unsupported credential container');
    credential = JSON.parse(await readFile(path, 'utf8'))[model.provider];
  } catch {
    throw Error('UNMET_PREREQUISITE: approved regular API credential store unavailable; no keyring or environment fallback');
  }
  if (credential?.type !== 'api' || typeof credential.key !== 'string' || !credential.key.trim() || /[\r\n]/.test(credential.key))
    throw Error('UNMET_PREREQUISITE: approved API credential required; keyring/subscription references are unsupported');
  context.registerSecret(credential.key);
  const upstreamHeaders = model.providerConfig.api_format === 'anthropic_messages'
    ? { 'x-api-key': credential.key } : { authorization: `Bearer ${credential.key}` };
  return startLiveModelObserver(context, model.providerConfig.endpoint, budget.maxResponses * budget.repeats, {
    upstreamHeaders,
    allowedPaths: [liveModelRequestPath(model.providerConfig.endpoint, model.providerConfig.api_format)],
    requestTimeoutMs: budget.caseWallMs,
    beforeForward(input) {
      options.onRequestShape?.(input);
      if (input.model !== model.model || !Number.isSafeInteger(input.outputTokenLimit) || input.outputTokenLimit < 1 || input.outputTokenLimit > budget.outputTokens)
        throw Error('Research model/token ceiling rejected');
      const allowed = new Set(['searchfree_search', 'web_fetch']);
      if (!input.exposedToolNames.length || input.exposedToolNames.some(name => !allowed.has(name)))
        throw Error('Research readonly search/fetch tool ceiling rejected');
      options.beforeForward?.(input);
      return { commonResearchToolCeiling: 'native search and fetch only', modelAndOutputBudgetChecked: true };
    },
  });
}
