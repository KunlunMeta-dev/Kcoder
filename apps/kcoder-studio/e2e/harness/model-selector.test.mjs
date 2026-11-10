import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForSelectedModel } from './model-selector.mjs';

function pageFixture({ open = false, remount = false, selection = 'fixture', disabledChecks = 0 } = {}) {
  const clicks = [];
  const page = { getByTestId(id) {
    if (id === 'model-selector-button') return {
      waitFor: async () => {}, getAttribute: async () => String(open),
      isVisible: async () => true,
      isEnabled: async () => disabledChecks-- <= 0,
      click: async () => { open = !open; clicks.push(open); },
    };
    assert.equal(id, 'model-selector-current');
    return {
      isVisible: async () => {
        if (remount) { remount = false; open = false; }
        return open;
      },
      innerText: async () => selection,
    };
  } };
  return { page, clicks, isOpen: () => open };
}

test('model wait reopens a menu closed by initial target remount and restores closed state', async () => {
  const f = pageFixture({ remount: true });
  assert.equal(await waitForSelectedModel(f.page, 'fixture', 1000), 'fixture');
  assert.deepEqual(f.clicks, [true, true, false]);
  assert.equal(f.isOpen(), false);
});

test('model wait preserves an already open menu without toggling it', async () => {
  const f = pageFixture({ open: true });
  assert.equal(await waitForSelectedModel(f.page, 'fixture', 1000), 'fixture');
  assert.deepEqual(f.clicks, []);
  assert.equal(f.isOpen(), true);
});

test('model wait includes the disabled catalog-loading phase before opening the menu', async () => {
  const f = pageFixture({ disabledChecks: 2 });
  assert.equal(await waitForSelectedModel(f.page, 'fixture', 1000), 'fixture');
  assert.deepEqual(f.clicks, [true, false]);
});

test('missing expected selection stays failed and closes only a menu opened by the helper', async () => {
  const f = pageFixture({ selection: 'other' });
  await assert.rejects(waitForSelectedModel(f.page, 'fixture', 100), /selected model fixture/);
  assert.equal(f.isOpen(), false);
});
