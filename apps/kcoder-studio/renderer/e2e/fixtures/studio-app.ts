import type { Page } from '@playwright/test'

type BridgeRuntimeConfig = {
  appBasePath: string
  apiBaseUrl: string
  socketBaseUrl: string
  socketPath: string
  runtimeMode: 'local-first' | 'backend'
  loginMode: 'password' | 'oidc' | 'all'
  oidcLoginText: string
  cloudDeviceScalingWikiUrl: string
}

type TestLocalModelConnectionInput = {
  baseUrl: string
  modelId: string
  apiFormat?: 'openai-responses' | 'openai-chat-completions' | 'anthropic-messages' | null
  toolProfile?: 'custom' | 'function' | 'shell' | null
  requestPath?: string | null
  apiKey?: string | null
}

type TestLocalModelConnectionResult = {
  status: number
  toolCalling: true
}

declare global {
  interface Window {
    __KCODER_STUDIO_E2E__?: {
      version: 1
      isEnabled: true
      isTauri: () => boolean
      getRuntimeConfig: () => BridgeRuntimeConfig
      getRoute: () => string
      navigate: (path: string) => string
      waitForTestId: (testId: string, options?: { timeoutMs?: number }) => Promise<boolean>
      queryTestIds: (prefix?: string) => string[]
      setAuthToken: (token: string) => void
      clearAuthToken: () => void
      clearStorage: () => void
      testLocalModelConnection: (
        input: TestLocalModelConnectionInput
      ) => Promise<TestLocalModelConnectionResult>
      tripLocalModelConnectionCircuitBreaker: (
        input: TestLocalModelConnectionInput
      ) => Promise<TestLocalModelConnectionResult>
    }
  }
}

export class StudioApp {
  constructor(private readonly page: Page) {}

  async goto(path = '/') {
    // Only initial navigation may recover from Chromium's network-change abort.
    // Business actions are never replayed by this helper.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let networkChanged = false
      const onFailed = (request: import('@playwright/test').Request) => {
        if (
          ['document', 'script', 'stylesheet'].includes(request.resourceType()) &&
          request.failure()?.errorText === 'net::ERR_NETWORK_CHANGED'
        ) networkChanged = true
      }
      this.page.on('requestfailed', onFailed)
      try {
        await this.page.goto(path)
        await this.waitForBridge(() => networkChanged)
        return
      } catch (error) {
        if (!networkChanged || attempt === 1) throw error
      } finally {
        this.page.off('requestfailed', onFailed)
      }
    }
  }

  async waitForBridge(networkChanged: () => boolean = () => false) {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (networkChanged()) {
        throw new Error('Application startup resources failed: net::ERR_NETWORK_CHANGED')
      }
      if (await this.page.evaluate(() => Boolean(window.__KCODER_STUDIO_E2E__?.isEnabled))) return
      await this.page.waitForTimeout(50)
    }
    throw new Error('Application automation bridge was not initialized within 10000ms')
  }

  async route() {
    return this.page.evaluate(() => window.__KCODER_STUDIO_E2E__?.getRoute() ?? window.location.pathname)
  }

  async runtimeConfig() {
    return this.page.evaluate(() => window.__KCODER_STUDIO_E2E__?.getRuntimeConfig())
  }

  async navigate(path: string) {
    await this.page.evaluate(nextPath => window.__KCODER_STUDIO_E2E__?.navigate(nextPath), path)
  }

  async waitForTestId(testId: string, timeoutMs = 5000) {
    await this.page.evaluate(
      ([id, timeout]) => window.__KCODER_STUDIO_E2E__?.waitForTestId(id, { timeoutMs: timeout }),
      [testId, timeoutMs] as const
    )
  }

  async testIds(prefix?: string) {
    return this.page.evaluate(value => window.__KCODER_STUDIO_E2E__?.queryTestIds(value) ?? [], prefix)
  }

  async testLocalModelConnection(input: TestLocalModelConnectionInput) {
    return this.page.evaluate(
      value => window.__KCODER_STUDIO_E2E__?.testLocalModelConnection(value),
      input
    )
  }

  async tripLocalModelConnectionCircuitBreaker(input: TestLocalModelConnectionInput) {
    return this.page.evaluate(
      value => window.__KCODER_STUDIO_E2E__?.tripLocalModelConnectionCircuitBreaker(value),
      input
    )
  }
}
