// Legacy migration scenarios opt into advanced UI explicitly; opening the dialog stays simple.
export async function selectAdvancedMigration(scope, mode = 'batch') {
  const toggle = scope.getByTestId('migration-advanced-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await scope.getByTestId(`migration-mode-${mode}`).click();
}
