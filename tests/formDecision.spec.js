const { test, expect } = require('@playwright/test');
const { isEmptyFieldValue, valuesMatch } = require('./formDecision');

test.describe('form field decision helpers', () => {
  test('treats placeholders and prompt text as empty', () => {
    expect(isEmptyFieldValue({ currentValue: 'Select Country', role: 'combobox' })).toBe(true);
    expect(isEmptyFieldValue({ currentValue: 'Type to search', placeholder: 'Type to search' })).toBe(true);
    expect(isEmptyFieldValue({ currentValue: 'typed but not committed', label: 'autocomplete' })).toBe(true);
    expect(isEmptyFieldValue({ currentValue: null, role: 'combobox' })).toBe(true);
  });

  test('treats committed ordinary values and selected choices as non-empty', () => {
    expect(isEmptyFieldValue({ currentValue: 'QA Test City', controlType: 'text' })).toBe(false);
    expect(isEmptyFieldValue({ currentValue: true, role: 'radio' })).toBe(false);
    expect(isEmptyFieldValue({ currentValue: 'India', role: 'combobox', options: [] })).toBe(false);
  });

  test('verifies an entered value without accepting a different value', () => {
    expect(valuesMatch('QA Test City', 'QA Test City')).toBe(true);
    expect(valuesMatch('QA City', 'QA Test City')).toBe(false);
    expect(valuesMatch(null, 'QA Test City')).toBe(false);
  });
});
