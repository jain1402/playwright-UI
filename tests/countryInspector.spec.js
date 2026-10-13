const { test, expect } = require('@playwright/test');
const {
  inspectCountrySelection,
  selectApprovedCountry,
} = require('./countryInspector');

async function mountCountryDropdown(page, { options = [], selected = null, typed = '', invalid = false } = {}) {
  const optionMarkup = options.map(option => `
    <div role="option"
      aria-selected="false"
      data-value="${option.value}"
      aria-disabled="${option.disabled ? 'true' : 'false'}">${option.label}</div>
  `).join('');
  await page.setContent(`
    <main>
      <label id="country-label">Country</label>
      <button id="country" type="button" role="combobox" aria-labelledby="country-label"
        aria-controls="country-options" aria-expanded="false"
        aria-invalid="${invalid ? 'true' : 'false'}"
        ${selected ? `aria-valuetext="${selected.label}" data-value="${selected.value}"` : ''}>
        ${selected ? selected.label : 'Select country'}
      </button>
      <input id="country-search" type="text" value="${typed}" aria-label="Country search">
      <div id="country-options" role="listbox" hidden>${optionMarkup}</div>
    </main>
    <script>
      const country = document.querySelector('#country');
      const optionsList = document.querySelector('#country-options');
      country.addEventListener('click', () => {
        optionsList.hidden = false;
        country.setAttribute('aria-expanded', 'true');
      });
      for (const option of optionsList.querySelectorAll('[role="option"]')) {
        option.addEventListener('click', () => {
          country.setAttribute('aria-valuetext', option.innerText);
          country.setAttribute('data-value', option.dataset.value);
          country.innerText = option.innerText + ' Remove item';
          country.setAttribute('aria-invalid', 'false');
          optionsList.hidden = true;
          country.setAttribute('aria-expanded', 'false');
        });
      }
    </script>
  `);
}

test.describe('Country selection helper', () => {
  test('detects and preserves a committed prefilled country', async ({ page }) => {
    await mountCountryDropdown(page, {
      selected: { label: 'Canada', value: 'CA' },
      options: [{ label: 'India', value: 'IN' }],
    });
    const control = page.getByRole('combobox', { name: 'Country' });
    await page.evaluate(() => {
      window.countryClicks = 0;
      document.querySelector('#country').addEventListener('click', () => { window.countryClicks += 1; });
    });

    const result = await selectApprovedCountry(page, control, 'India');

    expect(result.status).toBe('prefilled-preserved');
    expect(result.before).toMatchObject({
      displayedText: 'Canada',
      selectedValue: 'CA',
      selectedLabel: 'Canada',
      hasCommittedSelection: true,
    });
    expect(await page.evaluate(() => window.countryClicks)).toBe(0);
    expect(await control.getAttribute('data-value')).toBe('CA');
  });

  test('opens an empty control and selects the exact approved visible option', async ({ page }) => {
    await mountCountryDropdown(page, {
      options: [
        { label: 'Canada', value: 'CA' },
        { label: 'India', value: 'IN' },
      ],
    });

    const control = page.getByRole('combobox', { name: 'Country' });

    const result = await selectApprovedCountry(page, control, 'India');

    expect(result.status).toBe('selected-and-verified');
    expect(result.options.map(option => option.label)).toEqual(['Canada', 'India']);
    expect(result.selected).toMatchObject({
      selectedValue: 'IN',
      selectedLabel: 'India',
      hasCommittedSelection: true,
      ariaInvalid: false,
      validationMessage: '',
    });
    expect(result.approvedCountry).toBe('India');
  });

  test('does not preserve a committed value that is marked invalid', async ({ page }) => {
    await mountCountryDropdown(page, {
      selected: { label: 'India', value: 'IN' },
      options: [{ label: 'India', value: 'IN' }],
      invalid: true,
    });
    const control = page.getByRole('combobox', { name: 'Country' });

    const result = await selectApprovedCountry(page, control, 'India');

    expect(result.status).toBe('selected-and-verified');
    expect(result.before.hasCommittedSelection).toBe(true);
    expect(result.before.ariaInvalid).toBe(true);
    expect(result.selected).toMatchObject({
      selectedLabel: 'India',
      selectedValue: 'IN',
      hasCommittedSelection: true,
      ariaInvalid: false,
    });
  });

  test('does not treat placeholder or uncommitted typed text as a selected country', async ({ page }) => {
    await mountCountryDropdown(page, { typed: 'India' });
    const control = page.getByRole('combobox', { name: 'Country' });

    const result = await inspectCountrySelection(control);

    expect(result.hasCommittedSelection).toBe(false);
    expect(result.placeholderOnly).toBe(true);
    expect(result.selectedValue).toBeNull();
    expect(result.typedUncommittedText).toBe('India');
  });

  test('reports a clear diagnostic when opening the control yields no options', async ({ page }) => {
    await mountCountryDropdown(page);
    const control = page.getByRole('combobox', { name: 'Country' });

    const result = await selectApprovedCountry(page, control, 'India');

    expect(result.status).toBe('missing-visible-options');
    expect(result.options).toEqual([]);
    expect(result.reason).toMatch(/no selectable options/i);
  });

  test('reports actual visible options when no approved country is configured', async ({ page }) => {
    await mountCountryDropdown(page, {
      options: [
        { label: 'Canada', value: 'CA' },
        { label: 'India', value: 'IN' },
      ],
    });
    const control = page.getByRole('combobox', { name: 'Country' });

    const result = await selectApprovedCountry(page, control, '');

    expect(result.status).toBe('approved-country-unavailable');
    expect(result.options.map(option => option.label)).toEqual(['Canada', 'India']);
    expect(result.reason).toMatch(/no approved residence-country/i);
    expect(await control.getAttribute('data-value')).toBeNull();
  });

  test('reports visible options when the approved country is not available', async ({ page }) => {
    await mountCountryDropdown(page, {
      options: [{ label: 'Canada', value: 'CA' }],
    });
    const control = page.getByRole('combobox', { name: 'Country' });

    const result = await selectApprovedCountry(page, control, 'India');

    expect(result.status).toBe('approved-country-not-found');
    expect(result.options.map(option => option.label)).toEqual(['Canada']);
    expect(result.reason).toMatch(/no enabled visible option matches approved country "India"/i);
    expect(await control.getAttribute('data-value')).toBeNull();
    expect(await page.locator('#country-search').inputValue()).toBe('');
  });

  test('uses the first enabled meaningful visible country only when fallback is authorized', async ({ page }) => {
    await mountCountryDropdown(page, {
      options: [
        { label: 'Select Country', value: '', disabled: true },
        { label: 'Other', value: 'OTHER' },
        { label: 'Canada', value: 'country-canada' },
        { label: 'India', value: 'country-india' },
      ],
    });
    const control = page.getByRole('combobox', { name: 'Country' });

    const result = await selectApprovedCountry(page, control, 'Unavailable Country', {
      allowFirstMeaningfulFallback: true,
    });

    expect(result.status).toBe('selected-and-verified');
    expect(result.selectedBy).toBe('first-enabled-meaningful-ui-option-qa-fallback');
    expect(result.selectedOption).toEqual({ label: 'Canada', value: 'country-canada' });
    expect(result.optionScanComplete).toBe(true);
  });
});
