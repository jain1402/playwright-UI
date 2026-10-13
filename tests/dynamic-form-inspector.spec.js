const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { FORM_CONTROLS, inspectDynamicForm } = require('./formInspector');

const AUTH_STATE_PATH = path.join(__dirname, '..', 'playwright', '.auth', 'user.json');

test.use({ storageState: AUTH_STATE_PATH });

test('inspects onboarding fields with the saved authenticated session', async ({ page }) => {
  await page.goto('/onboarding');
  await page.waitForFunction(selectors => Array.from(document.querySelectorAll(selectors)).some(element => {
    const style = window.getComputedStyle(element);
    return element.getClientRects().length > 0
      && style.display !== 'none'
      && style.visibility !== 'hidden';
  }), FORM_CONTROLS);

  const form = await inspectDynamicForm(page);
  expect(new URL(form.url).pathname).toMatch(/\/onboarding(?:\/|$)/i);
  expect(form.fields.length, 'Saved authentication must expose onboarding form fields').toBeGreaterThan(0);

  console.log('=== SAVED AUTH FORM INSPECTION ===');
  console.log(`[PAGE ${form.tracker.currentStep ?? '?'}/${form.tracker.totalSteps ?? '?'}] ${form.stepTitle || 'Untitled onboarding page'}`);
  for (const field of form.fields) {
    console.log(`  [OBSERVED] ${field.label || field.accessibleName || 'Unlabeled field'}`);
  }
});
