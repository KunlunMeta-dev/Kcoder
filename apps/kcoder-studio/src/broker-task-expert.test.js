import test from 'node:test';
import assert from 'node:assert/strict';
import { TASK_EXPERT_LIGHT_READ_CAPABILITY, projectTaskExpertCapabilities } from './broker-task-expert.js';

test('lightweight expert reads are advertised only when both sides support them', () => {
  const backend = { agentTurnConfigurationV1: true, [TASK_EXPERT_LIGHT_READ_CAPABILITY]: true };
  assert.equal(projectTaskExpertCapabilities(backend, { initialized: true, channel: 'runtime',
    [TASK_EXPERT_LIGHT_READ_CAPABILITY]: true })[TASK_EXPERT_LIGHT_READ_CAPABILITY], true);
  assert.equal(projectTaskExpertCapabilities(backend, { initialized: true, channel: 'runtime' })[TASK_EXPERT_LIGHT_READ_CAPABILITY], false);
  assert.equal(projectTaskExpertCapabilities(backend, { initialized: true, channel: 'channel',
    [TASK_EXPERT_LIGHT_READ_CAPABILITY]: true })[TASK_EXPERT_LIGHT_READ_CAPABILITY], false);
  const legacy = projectTaskExpertCapabilities({ agentTurnConfigurationV1: true }, {
    initialized: true, channel: 'runtime', [TASK_EXPERT_LIGHT_READ_CAPABILITY]: true,
  });
  assert.equal(Object.hasOwn(legacy, TASK_EXPERT_LIGHT_READ_CAPABILITY), false);
});
