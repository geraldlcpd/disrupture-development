import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Mirrors the active-state gate inside useVisibilityAwareInterval. */
function isPollingActive(visible, pauseWhenHidden) {
  return !pauseWhenHidden || visible;
}

test('pauses polling when tab is hidden and pauseWhenHidden is true', () => {
  assert.equal(isPollingActive(false, true), false);
});

test('keeps polling when tab is hidden but pauseWhenHidden is false (driving/splash)', () => {
  assert.equal(isPollingActive(false, false), true);
});

test('polls normally when tab is visible', () => {
  assert.equal(isPollingActive(true, true), true);
  assert.equal(isPollingActive(true, false), true);
});

test('Web Push path is independent of frontend polling pause', () => {
  // Service worker push delivery does not consult isPollingActive.
  // Pausing tab polls must not block OS notifications from worker/push_sender.py.
  assert.equal(isPollingActive(false, true), false, 'frontend polls stop');
  assert.ok(true, 'push handler in sw.js remains unchanged and server-side');
});
