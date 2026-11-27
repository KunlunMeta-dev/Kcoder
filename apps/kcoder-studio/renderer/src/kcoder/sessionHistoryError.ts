import i18n from 'i18next'

// Older runtimes and saved task errors carry the full error chain instead of a code.
// Match only authority failures that cannot safely be fixed by retrying a model turn.
export function sessionHistoryErrorMessage(message: string): string {
  if (!/\b(?:history source control directory exists but its record is missing|bound history source record is missing|history source record is corrupt|history source incarnation changed|history body generation changed)\b/.test(message)) {
    return message
  }
  return i18n.t('common:workbench.session_history_unavailable')
}
