// memory scenarios for the existing desktop runner.
import {
  ACTIVE_WORKBENCH_SELECTOR,
  CONCURRENT_MEMORY_MAX_PHYSICAL_FOOTPRINT_KIB,
  CONCURRENT_MEMORY_TASK_COUNT,
  MEMORY_COMPLETION_TEXT,
  MEMORY_MAX_BASELINE_SAMPLES,
  MEMORY_MAX_PEAK_GROWTH_KIB,
  MEMORY_MAX_SAMPLE_RANGE_KIB,
  MEMORY_MAX_SETTLED_DOM_NODE_COUNT,
  MEMORY_MAX_SETTLED_GROWTH_KIB,
  MEMORY_MAX_SETTLED_SAMPLES,
  MEMORY_MIN_BASELINE_SAMPLES,
  MEMORY_MIN_SETTLED_SAMPLES,
  MEMORY_PROMPT,
  MEMORY_SAMPLE_INTERVAL_MS,
  MEMORY_SAMPLE_WINDOW_SIZE,
  UI_TIMEOUT_MS,
  resultDir,
} from './config.mjs'
import {
  captureVerificationScreenshot,
  sendPromptUntilScenarioRequest,
  waitForBlankConversation,
  waitForNewTaskRow,
} from './ui-helpers.mjs'
import { artifactSink, delay } from './runtime.mjs'
import { processGroup, medianMemorySample, memorySampleRangeKiB } from '../task-flow-evidence.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'

export async function captureMemorySample(control, phase) {
  const snapshot = JSON.parse(await control.command('performanceSnapshot', 'body'))
  const webContent = processGroup(snapshot, 'webkit-webcontent')
  assert.ok(webContent, 'The app WebContent process was missing from the memory snapshot')
  return {
    phase,
    timestamp: snapshot.timestamp,
    domNodeCount: snapshot.domNodeCount,
    rssKiB: webContent.rss_kib,
    physicalFootprintKiB: webContent.physical_footprint_kib,
    pids: webContent.pids,
  }
}

export async function captureTotalMemorySample(control, phase) {
  const snapshot = JSON.parse(await control.command('performanceSnapshot', 'body'))
  return {
    phase,
    timestamp: snapshot.timestamp,
    domNodeCount: snapshot.domNodeCount,
    rssKiB: snapshot.processMemory.groups.reduce((total, group) => total + group.rss_kib, 0),
    physicalFootprintKiB: snapshot.processMemory.groups.reduce(
      (total, group) => total + group.physical_footprint_kib,
      0
    ),
    groups: snapshot.processMemory.groups,
  }
}

export async function verifyConcurrentTaskMemory({ composerSelector, control }) {
  assert.equal(process.platform, 'darwin', 'Concurrent memory E2E currently requires macOS')
  control.setScenario('concurrent_memory')
  const taskRows = []
  const initialSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  const knownTaskRows = new Set(
    initialSnapshot.testIds.filter(testId => testId.startsWith('runtime-local-task-row-'))
  )

  for (let index = 1; index <= CONCURRENT_MEMORY_TASK_COUNT; index += 1) {
    if (index > 1) {
      await control.command('click', '[data-testid="new-chat-button"]')
    }
    await waitForBlankConversation(control, composerSelector)
    const prompt = `KCODER_STUDIO_DESKTOP_E2E_CONCURRENT_MEMORY_${index}`
    await control.command('fill', composerSelector, { value: prompt })
    await control.command('press', composerSelector, { key: 'Enter' })
    await control.awaitScenarioRequestCount('concurrent_memory', index)
    const nextRow = await waitForNewTaskRow(control, knownTaskRows, prompt)
    knownTaskRows.add(nextRow)
    taskRows.push(nextRow)
  }

  assert.equal(
    control.scenarioRequests.get('concurrent_memory')?.length,
    CONCURRENT_MEMORY_TASK_COUNT,
    'The model service did not keep ten task requests running concurrently'
  )
  assert.equal(
    control.concurrentMemoryTaskNumbers.size,
    CONCURRENT_MEMORY_TASK_COUNT,
    'The model service did not receive ten unique concurrent task prompts'
  )
  assert.ok(
    control.concurrentMemoryResponses.length >= CONCURRENT_MEMORY_TASK_COUNT,
    'The model service released a concurrent task stream before memory sampling'
  )
  assert.equal(
    taskRows.length,
    CONCURRENT_MEMORY_TASK_COUNT,
    'The sidebar did not expose ten tasks'
  )
  await captureVerificationScreenshot(control, 'concurrent-memory-01-running.png')

  const samples = []
  for (let index = 0; index < 5; index += 1) {
    samples.push(await captureTotalMemorySample(control, 'running'))
    await delay(1_000)
  }
  const peak = samples.reduce((largest, sample) =>
    sample.physicalFootprintKiB > largest.physicalFootprintKiB ? sample : largest
  )

  const sidebarSnapshot = JSON.parse(await control.command('snapshot', 'body'))
  const expandTasksButton = sidebarSnapshot.testIds.find(testId =>
    testId.startsWith('project-runtime-tasks-expand-')
  )
  if (expandTasksButton) {
    await control.command('click', `[data-testid="${expandTasksButton}"]`)
  }
  await control.command('waitFor', `[data-testid="${taskRows[0]}"]`, {
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', `[data-testid="${taskRows[0]}"]`)
  await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, {
    text: 'KCODER_STUDIO_DESKTOP_E2E_CONCURRENT_MEMORY_1',
    timeoutMs: UI_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', `[data-testid="${taskRows.at(-1)}"]`)
  await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, {
    text: `KCODER_STUDIO_DESKTOP_E2E_CONCURRENT_MEMORY_${CONCURRENT_MEMORY_TASK_COUNT}`,
    timeoutMs: UI_TIMEOUT_MS,
  })

  await artifactSink.writeJson(join(resultDir, 'concurrent-memory.json'), {
    taskCount: CONCURRENT_MEMORY_TASK_COUNT,
    limitPhysicalFootprintKiB: CONCURRENT_MEMORY_MAX_PHYSICAL_FOOTPRINT_KIB,
    peak,
    samples,
  })
  assert.ok(
    peak.physicalFootprintKiB < CONCURRENT_MEMORY_MAX_PHYSICAL_FOOTPRINT_KIB,
    `App physical footprint reached ${peak.physicalFootprintKiB} KiB with ten concurrent tasks`
  )
  control.releaseConcurrentMemoryResponses()
}

export async function verifyMemoryGrowth({ composerSelector, control }) {
  assert.equal(process.platform, 'darwin', 'Desktop memory E2E currently requires macOS')
  control.setScenario('memory')
  const baselineSamples = await captureStableMemorySamples(
    control,
    'baseline',
    MEMORY_MIN_BASELINE_SAMPLES,
    MEMORY_MAX_BASELINE_SAMPLES
  )
  const baseline = medianMemorySample(baselineSamples.slice(-MEMORY_SAMPLE_WINDOW_SIZE))
  assert.ok(baseline, 'The memory E2E did not capture baseline samples')
  const samples = [...baselineSamples]
  await captureVerificationScreenshot(control, 'memory-01-baseline.png')
  await sendPromptUntilScenarioRequest(control, composerSelector, MEMORY_PROMPT, 'memory')
  await captureVerificationScreenshot(control, 'memory-02-streaming.png')

  let completed = false
  const startedAt = Date.now()
  while (!completed && Date.now() - startedAt < UI_TIMEOUT_MS) {
    await delay(MEMORY_SAMPLE_INTERVAL_MS)
    samples.push(await captureMemorySample(control, 'streaming'))
    const snapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
    completed = snapshot.text.includes(MEMORY_COMPLETION_TEXT)
  }
  assert.equal(completed, true, 'The memory E2E response did not complete')
  await captureVerificationScreenshot(control, 'memory-03-completed.png')

  for (let index = 0; index < MEMORY_MAX_SETTLED_SAMPLES; index += 1) {
    await delay(1_000)
    samples.push(await captureMemorySample(control, 'settled'))
    const settledSamples = samples.filter(sample => sample.phase === 'settled')
    if (settledSamples.length < MEMORY_MIN_SETTLED_SAMPLES) continue
    const settledWindow = settledSamples.slice(-MEMORY_SAMPLE_WINDOW_SIZE)
    const settled = medianMemorySample(settledWindow)
    assert.ok(settled, 'The memory E2E did not capture a settled sample window')
    if (
      settled.physicalFootprintKiB - baseline.physicalFootprintKiB <=
        MEMORY_MAX_SETTLED_GROWTH_KIB &&
      memorySampleRangeKiB(settledWindow) <= MEMORY_MAX_SAMPLE_RANGE_KIB
    ) {
      break
    }
  }

  const workloadSamples = samples.filter(sample => sample.phase !== 'baseline')
  const peak = workloadSamples.reduce((largest, sample) =>
    sample.physicalFootprintKiB > largest.physicalFootprintKiB ? sample : largest
  )
  const peakDomNodeCount = Math.max(...samples.map(sample => sample.domNodeCount))
  const settledSamples = samples.filter(sample => sample.phase === 'settled')
  const settledWindow = settledSamples.slice(-MEMORY_SAMPLE_WINDOW_SIZE)
  const settled = medianMemorySample(settledWindow)
  assert.ok(settled, 'The memory E2E did not capture settled samples')
  await captureVerificationScreenshot(control, 'memory-04-settled.png')
  const peakGrowthKiB = peak.physicalFootprintKiB - baseline.physicalFootprintKiB
  const settledGrowthKiB = settled.physicalFootprintKiB - baseline.physicalFootprintKiB
  const settledRangeKiB = memorySampleRangeKiB(settledWindow)
  const settledDomNodeCount = Math.max(...settledWindow.map(sample => sample.domNodeCount))

  await artifactSink.writeJson(join(resultDir, 'memory-growth.json'), {
    limits: {
      maxPeakGrowthKiB: MEMORY_MAX_PEAK_GROWTH_KIB,
      maxSettledGrowthKiB: MEMORY_MAX_SETTLED_GROWTH_KIB,
      maxSettledDomNodeCount: MEMORY_MAX_SETTLED_DOM_NODE_COUNT,
    },
    summary: {
      peakGrowthKiB,
      settledGrowthKiB,
      settledRangeKiB,
      peakDomNodeCount,
      settledDomNodeCount,
      baselineSampleCount: baselineSamples.length,
    },
    samples,
  })

  assert.ok(
    peakGrowthKiB <= MEMORY_MAX_PEAK_GROWTH_KIB,
    `WebContent peak physical footprint grew by ${peakGrowthKiB} KiB`
  )
  assert.ok(
    settledDomNodeCount <= MEMORY_MAX_SETTLED_DOM_NODE_COUNT,
    `WebContent DOM retained ${settledDomNodeCount} nodes after rendering the long response`
  )
  assert.ok(
    settledGrowthKiB <= MEMORY_MAX_SETTLED_GROWTH_KIB,
    `WebContent settled physical footprint grew by ${settledGrowthKiB} KiB`
  )
  assert.ok(
    settledRangeKiB <= MEMORY_MAX_SAMPLE_RANGE_KIB,
    `WebContent settled sample range reached ${settledRangeKiB} KiB`
  )
}

export async function captureStableMemorySamples(control, phase, minimumSamples, maximumSamples) {
  const samples = []
  while (samples.length < maximumSamples) {
    if (samples.length > 0) {
      await delay(1_000)
    }
    samples.push(await captureMemorySample(control, phase))
    if (samples.length < minimumSamples) continue
    const recent = samples.slice(-MEMORY_SAMPLE_WINDOW_SIZE)
    if (memorySampleRangeKiB(recent) <= MEMORY_MAX_SAMPLE_RANGE_KIB) break
  }
  return samples
}
