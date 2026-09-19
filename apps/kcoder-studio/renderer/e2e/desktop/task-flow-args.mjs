const FLAG_NAMES = {
  viewImageOnly: '--view-image-only',
  shortConversationOnly: '--short-conversation-only',
  retryOnly: '--retry-only',
  runningForkOnly: '--running-fork-only',
  sideChatOnly: '--side-chat-only',
  goalIdleOnly: '--goal-idle-only',
  goalRestartOnly: '--goal-restart-only',
  turnNavigationOnly: '--turn-navigation-only',
  attachmentOnly: '--attachment-only',
  pastedWorkspacePathsOnly: '--pasted-workspace-paths-only',
  droppedWorkspacePathsOnly: '--dropped-workspace-paths-only',
  systemDragPanelOnly: '--system-drag-panel-only',
  modelSwitchOnly: '--model-switch-only',
  cloudOnly: '--cloud-only',
  pluginsOnly: '--plugins-only',
  memoryOnly: '--memory-only',
  toolBlockOrderOnly: '--tool-block-order-only',
  queueNavigationOnly: '--queue-navigation-only',
}

export function parseTaskFlowArgs(argv = process.argv, env = process.env) {
  const selected = new Set(argv)
  const flags = Object.fromEntries(
    Object.entries(FLAG_NAMES).map(([name, flag]) => [name, selected.has(flag)])
  )
  return {
    requestInputOnly: env.KCODER_STUDIO_DESKTOP_E2E_REQUEST_INPUT_ONLY === '1',
    desktopScenarioOnly: env.KCODER_STUDIO_E2E_DESKTOP_SCENARIO_ONLY === 'true',
    ...flags,
    memoryLimits: {
      concurrentPhysicalFootprintKiB: numericEnvironment(
        env,
        'KCODER_STUDIO_E2E_CONCURRENT_MEMORY_MAX_PHYSICAL_FOOTPRINT_KIB',
        800 * 1024
      ),
      peakGrowthKiB: numericEnvironment(env, 'KCODER_STUDIO_E2E_MEMORY_MAX_PEAK_GROWTH_KIB', 384 * 1024),
      settledGrowthKiB: numericEnvironment(
        env,
        'KCODER_STUDIO_E2E_MEMORY_MAX_SETTLED_GROWTH_KIB',
        232 * 1024
      ),
      settledDomNodeCount: numericEnvironment(env, 'KCODER_STUDIO_E2E_MEMORY_MAX_SETTLED_DOM_NODES', 900),
    },
  }
}

function numericEnvironment(env, name, fallback) {
  const value = Number(env[name] ?? fallback)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`)
  return value
}
