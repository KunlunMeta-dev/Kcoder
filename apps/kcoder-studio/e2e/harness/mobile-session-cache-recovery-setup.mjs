export async function openAdvancedNewTaskForm(page, setupDiagnostics, recordUniqueSetupLocator) {
  const advancedOptions = await recordUniqueSetupLocator(
    page, setupDiagnostics, "new-task-advanced", page.getByTestId("new-task-advanced"));
  setupDiagnostics.phase = "open-new-task-advanced-options";
  await advancedOptions.click();
  const promptInput = page.getByTestId("new-workspace-prompt");
  setupDiagnostics.phase = "wait-advanced-prompt-visible";
  await promptInput.waitFor({ state: "visible", timeout: 30_000 });
  const localServer = await recordUniqueSetupLocator(
    page, setupDiagnostics, "server-option-local", page.locator('[data-testid="server-option-local"]:visible'));
  setupDiagnostics.phase = "select-local-server";
  await localServer.click();
  const workspacePath = page.getByTestId("workspace-path");
  setupDiagnostics.phase = "wait-workspace-path";
  await workspacePath.waitFor({ state: "visible", timeout: 30_000 });
  await recordUniqueSetupLocator(page, setupDiagnostics, "workspace-path", workspacePath);
  await recordUniqueSetupLocator(page, setupDiagnostics, "new-workspace-prompt", promptInput);
  return promptInput;
}
