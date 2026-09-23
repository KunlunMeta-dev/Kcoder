import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

/**
 * The renderer ships two runtime adapters: the modular `gatewayRuntime.ts` and
 * the installed Tauri adapter `installGatewayRuntime.ts`. They are forks with
 * different feature sets (the installed one owns the browser and terminal
 * surfaces), so a session-identity fix applied to one copy can silently miss the
 * other. Two real defects were shipped that way before they were caught by
 * running the same scenario against both adapters.
 *
 * This guard does not converge the forks; it only fails when a P2-owned recovery
 * semantic disappears from one of them. Converging the adapters is tracked as the
 * runtime-convergence work package, and this guard should be deleted once that
 * lands and a single implementation serves both entry points.
 */
const OWNED_SEMANTICS: Array<{ marker: string; rationale: string }> = [
  {
    marker: 'restartAllowed',
    rationale:
      'a paginated transcript read restarts once from a cursor-less snapshot',
  },
  {
    marker: 'code === -32041',
    rationale: 'a stale transcript cursor is recognised as such',
  },
  {
    marker: 'requestTranscriptPage',
    rationale: 'transcript paging goes through the shared recovery helper',
  },
  {
    marker: 'resubmit',
    rationale: 'the legacy retry path declares an intentional resubmission',
  },
  {
    marker: 'notificationReplayGuard',
    rationale: 'replayed notifications cannot mutate current-run state',
  },
  {
    marker: 'retryOperationId',
    rationale: 'a continuation names the recovery it asks for',
  },
]

const ADAPTERS = ['gatewayRuntime.ts', 'installGatewayRuntime.ts'] as const

describe('session-identity parity across the runtime adapters', () => {
  const sources = new Map(
    ADAPTERS.map(name => [
      name,
      readFileSync(new URL(name, import.meta.url), 'utf8'),
    ])
  )

  test.each(OWNED_SEMANTICS)(
    'both adapters keep the $marker semantic',
    ({ marker, rationale }) => {
      for (const name of ADAPTERS) {
        const source = sources.get(name)!
        expect(
          source.includes(marker),
          `${name} must keep ${marker} (${rationale}); apply the fix to both adapters or converge them`
        ).toBe(true)
      }
    }
  )

  test('the adapters are still documented as divergent forks', () => {
    // If this fails, the two files were converged: delete this guard instead of
    // keeping a parity check that no longer has two subjects.
    for (const name of ADAPTERS) {
      expect(sources.get(name)!.includes('class KCoderGatewayRuntime')).toBe(true)
    }
    expect(sources.get('gatewayRuntime.ts')).not.toBe(
      sources.get('installGatewayRuntime.ts')
    )
  })
})
