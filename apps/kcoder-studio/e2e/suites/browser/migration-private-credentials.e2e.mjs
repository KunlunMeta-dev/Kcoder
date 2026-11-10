const metadata = {
  testId: 'studio-migration-private-credentials',
  modelPolicy: 'model-independent private credential recovery through real browser/Gateway/Native; no model turn',
  tier: 'full-integration',
};
process.env.KCODER_E2E_MIGRATION_PRIVATE_CREDENTIALS_ONLY = '1';
const { runMigrationSuite } = await import('./migration.e2e.mjs');
await runMigrationSuite(import.meta.url, metadata);
