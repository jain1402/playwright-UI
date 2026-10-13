const { test, expect } = require('@playwright/test');
const { inspectDynamicForm } = require('./formInspector');
const {
  fillSafeSyntheticFields,
  waitForUserDeclarations,
} = require('./onboardingAutomation');

test('selects only the configured dropdown option and verifies its committed value', async ({ page }) => {
  await page.setContent(`
    <button id="country" role="combobox" aria-label="Country" aria-required="true"
      aria-controls="country-options" aria-valuetext="">Select Country</button>
    <div id="country-options" role="listbox">
      <div role="option" data-value="CA">Canada</div>
    </div>
    <script>
      document.querySelector('[role="option"]').addEventListener('click', () => {
        const control = document.querySelector('#country');
        control.setAttribute('aria-valuetext', 'CA');
        control.textContent = 'Canada';
      });
    </script>
  `);
  const form = await inspectDynamicForm(page);
  form.dropdownOptionDiscovery = [{
    field: 'country',
    label: 'Country',
    options: [{ label: 'Canada', value: 'CA', disabled: false }],
  }];

  const result = await fillSafeSyntheticFields(page, form, { residenceCountry: 'Canada' });
  const after = await inspectDynamicForm(page);

  expect(result.used).toContainEqual(expect.objectContaining({
    field: 'Country',
    category: 'observed-dropdown-option',
    verifiedValue: 'Canada',
  }));
  expect(result.unresolvedRequired).toEqual([]);
  expect(after.fields.find(field => field.id === 'country').currentValue).toBe('CA');
});

test('pauses for truthful user decisions and resumes after required declaration fields are completed', async ({ page }) => {
  await page.setContent(`
    <label for="income">Annual Income (USD)</label>
    <select id="income" name="annualIncome" required>
      <option value="">Select</option>
      <option value="choice-a">Choice A</option>
    </select>
    <label for="wealth">Source Of Wealth</label>
    <select id="wealth" name="sourceOfWealth" required>
      <option value="">Select</option>
      <option value="choice-b">Choice B</option>
    </select>
  `);
  const form = await inspectDynamicForm(page);
  const completion = waitForUserDeclarations(page, form, 2_000);
  await page.waitForTimeout(100);
  await page.locator('#income').selectOption('choice-a');
  await page.locator('#wealth').selectOption('choice-b');
  const result = await completion;

  expect(result.completed).toBe(true);
  expect(result.fields).toEqual([
    { field: 'Annual Income (USD)', status: 'user-value-verified' },
    { field: 'Source Of Wealth', status: 'user-value-verified' },
  ]);
  expect(result.form.fields.find(field => field.name === 'annualIncome').currentValue).toBe('choice-a');
  expect(result.form.fields.find(field => field.name === 'sourceOfWealth').currentValue).toBe('choice-b');
});

test('does not treat a dropdown click as success unless the selected value is read back', async ({ page }) => {
  await page.setContent(`
    <button id="country" role="combobox" aria-label="Country" aria-required="true"
      aria-controls="country-options">Select Country</button>
    <div id="country-options" role="listbox">
      <div role="option" data-value="CA">Canada</div>
    </div>
  `);
  const form = await inspectDynamicForm(page);
  form.dropdownOptionDiscovery = [{
    field: 'country',
    label: 'Country',
    options: [{ label: 'Canada', value: 'CA', disabled: false }],
  }];

  const result = await fillSafeSyntheticFields(page, form, { residenceCountry: 'Canada' });

  expect(result.used).toEqual([]);
  expect(result.unresolvedRequired).toContainEqual(expect.objectContaining({
    field: 'Country',
    reason: expect.stringContaining('not confirmed as the committed value'),
  }));
});
