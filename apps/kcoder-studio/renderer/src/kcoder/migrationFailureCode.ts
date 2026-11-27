/** Only these exact private preparation barriers cross the ordinary migration error boundary. */
export function migrationFailureCode(cause: unknown) {
  const raw = cause instanceof Error ? cause.message : ''
  if (raw === 'private_credentials_preparation_pending' || raw === 'private_credentials_publication_unknown') return raw
  return raw.match(/\bmigration_[a-z_]+\b/)?.[0] ?? 'error'
}
