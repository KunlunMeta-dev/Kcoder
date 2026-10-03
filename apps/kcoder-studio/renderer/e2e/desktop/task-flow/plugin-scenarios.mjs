// plugin scenarios for the existing desktop runner.
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  COMPOSER_READY_STABILITY_MS,
  UI_TIMEOUT_MS,
  WORKBENCH_READY_TIMEOUT_MS,
} from './config.mjs'
import { captureVerificationScreenshot, waitForSnapshot } from './ui-helpers.mjs'
import { PLUGIN_DISPLAY_NAME } from '../task-flow-fixtures.mjs'
import assert from 'node:assert/strict'

export async function verifyPluginLifecycle(control, marketplacePath) {
  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', '[data-testid="plugins-workspace"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })

  const initialSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('plugins-add-custom-marketplace-empty-button') ||
      snapshot.testIds.includes('plugins-add-marketplace-button'),
    'The plugin marketplace controls did not become ready'
  )
  if (initialSnapshot.testIds.includes('plugins-add-custom-marketplace-empty-button')) {
    await control.command('click', '[data-testid="plugins-add-custom-marketplace-empty-button"]')
  } else {
    await control.command('click', '[data-testid="plugins-add-marketplace-button"]')
    await control.command('click', '[data-testid="plugins-add-custom-marketplace-button"]')
  }
  await control.command('fill', '[data-testid="plugins-marketplace-path-input"]', {
    value: marketplacePath,
  })
  await control.command('clickWhenEnabled', '[data-testid="plugins-marketplace-save-button"]', {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: UI_TIMEOUT_MS,
  })

  const marketplaceSnapshot = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.text.includes(PLUGIN_DISPLAY_NAME) &&
      snapshot.testIds.some(testId => testId.startsWith('plugin-marketplace-row-')),
    'The local plugin marketplace did not expose its plugin'
  )
  const rowTestId = marketplaceSnapshot.testIds.find(testId =>
    testId.startsWith('plugin-marketplace-row-')
  )
  assert.ok(rowTestId, 'The plugin marketplace row did not have a stable test id')
  const pluginId = rowTestId.slice('plugin-marketplace-row-'.length)
  const installSelector = `[data-testid="plugin-marketplace-install-${pluginId}"]`
  const actionsSelector = `[data-testid="plugin-marketplace-actions-${pluginId}"]`
  await captureVerificationScreenshot(control, 'plugins-01-marketplace.png')

  await control.command('click', installSelector)
  await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.includes(`plugin-marketplace-actions-${pluginId}`),
    'The plugin was not shown as installed after the real app-server request'
  )
  assert.match(
    await control.command('getText', installSelector),
    /Try in chat|在对话中试用/,
    'The installed plugin did not expose its chat action'
  )
  await captureVerificationScreenshot(control, 'plugins-02-installed.png')

  await control.command('click', installSelector)
  await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForSnapshot(
    control,
    snapshot => snapshot.text.includes(PLUGIN_DISPLAY_NAME),
    'Trying the installed plugin did not place its reference in the composer',
    UI_TIMEOUT_MS,
    ACTIVE_WORKBENCH_SELECTOR
  )
  await captureVerificationScreenshot(control, 'plugins-03-used-in-chat.png')

  await control.command('click', '[data-testid="plugins-button"]')
  await control.command('waitFor', actionsSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  await control.command('click', actionsSelector)
  await control.command('click', `[data-testid="plugin-marketplace-uninstall-${pluginId}"]`)
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes(`plugin-marketplace-actions-${pluginId}`),
    'The plugin remained installed after the uninstall request'
  )
  assert.match(
    await control.command('getText', installSelector),
    /Install|安装/,
    'The marketplace did not return to the install state after uninstall'
  )
  await captureVerificationScreenshot(control, 'plugins-04-uninstalled.png')
}
