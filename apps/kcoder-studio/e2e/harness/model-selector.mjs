// The closed trigger intentionally says only "Models". Inspect the current
// selection through the same expanded menu the user opens.
import { waitFor } from './run-context.mjs';

export async function waitForSelectedModel(page, model, timeout = 30000) {
  const trigger = page.getByTestId('model-selector-button');
  const deadline = Date.now() + timeout;
  await trigger.waitFor({state:'visible',timeout});
  const actionTimeout = () => Math.max(1, Math.min(1000, deadline - Date.now()));
  let wasOpen, openedByHelper = false, primaryError;
  try {
    return await waitFor(async () => {
      try {
        if (!await trigger.isVisible()) return null;
        const expanded = await trigger.getAttribute('aria-expanded', { timeout: actionTimeout() });
        wasOpen ??= expanded === 'true';
        if (!await trigger.isEnabled()) return null;
        // Initial target/catalog resolution may remount and close the menu.
        if (expanded !== 'true') { await trigger.click({ timeout: actionTimeout() }); openedByHelper = true; }
        const current = page.getByTestId('model-selector-current');
        if (!await current.isVisible()) return null;
        const selection = await current.innerText({ timeout: actionTimeout() });
        return selection.includes(model) ? selection : null;
      } catch (error) {
        if (page.isClosed?.()) throw error;
        if (error?.name === 'TimeoutError' || /detached|not attached|not connected/i.test(error?.message || '')) return null;
        throw error;
      }
    }, Math.max(1, deadline - Date.now()), `selected model ${model}`);
  } catch (error) { primaryError = error; throw error;
  } finally {
    try {
      if (wasOpen === false && openedByHelper && !page.isClosed?.() && await trigger.getAttribute('aria-expanded', { timeout: 1000 }) === 'true') await trigger.click({ timeout: 1000 });
    } catch (cleanupError) { if (primaryError) primaryError.cleanupError = cleanupError; else throw cleanupError; }
  }
}
