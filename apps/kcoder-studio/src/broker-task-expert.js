import { isContract } from '../shared/generated/validator.mjs';

export const TASK_EXPERT_CAPABILITY = 'agentTurnConfigurationV1';
export const EXPERT_CREATION_CAPABILITY = 'agentDefinitionsV1';

function supportsExpertCapability(client, experimental, capability) {
  return client?.initialized === true && client.channel === 'runtime' &&
    client[capability] === true && experimental?.[capability] === true;
}

export function taskExpertAdmissionError(request, client, experimental) {
  if (request.method === 'thread/start' && request.params?.agentDefinition != null) {
    return supportsExpertCapability(client, experimental, EXPERT_CREATION_CAPABILITY)
      ? null : 'agentDefinitionsV1 negotiation is required';
  }
  if (request.method !== 'thread/expert') return null;
  if (!supportsExpertCapability(client, experimental, TASK_EXPERT_CAPABILITY)) return 'agentTurnConfigurationV1 negotiation is required';
  if (!isContract('ThreadExpertParams', request.params)) return 'Invalid original task expert request';
  return null;
}

// A shared backend opt-in does not authorize an older client to change experts.
export function projectTaskExpertCapabilities(experimental, client) {
  let projected = experimental;
  for (const capability of [TASK_EXPERT_CAPABILITY, EXPERT_CREATION_CAPABILITY]) {
    if (Object.hasOwn(experimental ?? {}, capability)) {
      projected = { ...projected, [capability]: supportsExpertCapability(client, experimental, capability) };
    }
  }
  return projected;
}
