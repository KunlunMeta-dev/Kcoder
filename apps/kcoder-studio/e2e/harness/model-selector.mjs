// The closed trigger intentionally says only "Models". Inspect the current
// selection through the same expanded menu the user opens.
export async function waitForSelectedModel(page, model, timeout = 30000) {
  const trigger = page.getByTestId('model-selector-button');
  await trigger.waitFor({state:'visible',timeout});
  const wasOpen = await trigger.getAttribute('aria-expanded') === 'true';
  if (!wasOpen) await trigger.click();
  try {
    await page.waitForFunction(expected => document.querySelector('[data-testid="model-selector-current"]')?.textContent?.includes(expected), model, {timeout});
    return await page.getByTestId('model-selector-current').innerText();
  } finally {
    if (!wasOpen && await trigger.getAttribute('aria-expanded') === 'true') await trigger.click();
  }
}
