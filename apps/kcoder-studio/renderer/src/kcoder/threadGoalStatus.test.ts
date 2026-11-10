import { describe, expect, it } from 'vitest'
import { parseThreadGoalStatusObservation, readThreadGoalStatusObservation } from './threadGoalStatus'

describe('thread Goal status observations', () => {
  it('keeps an observed active Goal distinct from an observed absence', () => {
    expect(parseThreadGoalStatusObservation({ availability: 'available', status: 'active' }))
      .toEqual({ availability: 'available', status: 'active' })
    expect(parseThreadGoalStatusObservation({ availability: 'available', status: null }))
      .toEqual({ availability: 'available', status: null })
    expect(parseThreadGoalStatusObservation({ threadId: 'a', availability: 'available', status: 'active' }, 'a'))
      .toEqual({ availability: 'available', status: 'active' })
  })

  it('treats missing, malformed and future data as unavailable', () => {
    for (const value of [undefined, null, {}, { availability: 'unavailable' },
      { availability: 'available' }, { availability: 'available', status: 'future' },
      { availability: 'available', status: null, inProgress: true },
      { threadId: 'other', availability: 'available', status: null }]) {
      expect(parseThreadGoalStatusObservation(value)).toEqual({ availability: 'unavailable' })
    }
  })

  it('preserves legacy absence and handles both wire-name spellings', () => {
    expect(readThreadGoalStatusObservation({})).toBeUndefined()
    expect(readThreadGoalStatusObservation({ goal_status_observation: { availability: 'available', status: null } }))
      .toEqual({ availability: 'available', status: null })
    expect(readThreadGoalStatusObservation({ goalStatusObservation: undefined, goal_status_observation: { availability: 'available', status: null } }))
      .toEqual({ availability: 'unavailable' })
  })
})
