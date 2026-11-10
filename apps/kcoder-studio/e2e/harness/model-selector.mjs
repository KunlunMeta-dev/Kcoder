// The closed trigger intentionally says only "Models". Inspect the current
// selection through the same expanded menu the user opens.
import { waitFor } from './run-context.mjs';

export async function waitForSelectedModel(page, model, timeout = 30000) {
  const trigger = page.getByTestId('model-selector-button');
  await trigger.waitFor({state:'visible',timeout});
  const wasOpen = await trigger.getAttribute('aria-expanded') === 'true';
  try {
    return await waitFor(async () => {
      if (!await trigger.isVisible() || !await trigger.isEnabled()) return null;
      // Initial target/catalog resolution may remount and close the menu.
      if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click({ timeout: 1000 });
      const current = page.getByTestId('model-selector-current');
      if (!await current.isVisible()) return null;
      const selection = await current.innerText();
      return selection.includes(model) ? selection : null;
    }, timeout, `selected model ${model}`);
  } finally {
    if (!wasOpen && await trigger.getAttribute('aria-expanded') === 'true') await trigger.click();
  }
}
