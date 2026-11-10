/** Defaults live in the channels configuration domain, never in tool dispatch. */
export const defaultToolRestrictions = () => ({ enabled: true,
  disabledTools: ['AskUserQuestion', 'AskUserQuestionAsync', 'EnterPlanMode', 'ExitPlanMode', 'ask_user_question'] });

export function toolRestrictions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['enabled', 'disabledTools'].includes(key)) ||
      typeof value.enabled !== 'boolean' || !Array.isArray(value.disabledTools) || value.disabledTools.length > 128 ||
      value.disabledTools.some(name => typeof name !== 'string' || !name || Buffer.byteLength(name) > 256 || /[\s\p{Cc}]/u.test(name))) {
    throw new Error('CHANNEL_SETTINGS_INVALID');
  }
  return { enabled: value.enabled, disabledTools: [...new Set(value.disabledTools)].sort() };
}

export function settingsToolRestrictions(channels) {
  const stored = channels?.tool_restrictions;
  return stored === undefined ? defaultToolRestrictions() : toolRestrictions({ enabled: stored?.enabled, disabledTools: stored?.disabled_tools });
}
