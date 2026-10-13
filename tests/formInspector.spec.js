const { test, expect } = require('@playwright/test');
const { inspectDynamicForm } = require('./formInspector');

test('inspects a hidden required file input without uploading a file', async ({ page }) => {
  await page.setContent(`
    <main>
      <h1>Upload Documents</h1>
      <label for="identity-file">Proof of identity</label>
      <input id="identity-file" name="identityDocument" type="file" required hidden>
    </main>
  `);

  const report = await inspectDynamicForm(page);
  const fileField = report.fields.find(field => field.controlType === 'file');

  expect(fileField).toMatchObject({
    label: 'Proof of identity',
    name: 'identityDocument',
    required: true,
    enabled: true,
    currentValue: '',
  });
  expect(report.fields).toHaveLength(1);
});

test('recognizes a committed token selected in a Document Type autocomplete', async ({ page }) => {
  await page.setContent(`
    <main>
      <h1>Upload Documents</h1>
      <div>
        <label>Document Type</label>
        <span>Government Issued ID
          <button type="button" aria-label="Remove item: 'government_id'">Remove item</button>
        </span>
        <input aria-label="autocomplete" type="text" value="">
      </div>
    </main>
  `);

  const report = await inspectDynamicForm(page);
  const documentType = report.fields.find(field => field.surroundingLabel === 'Document Type');

  expect(documentType).toMatchObject({
    label: 'Document Type',
    controlType: 'text',
    currentValue: 'Government Issued ID',
    businessRuleClassification: 'Dropdown/selection',
    committedSelections: [{
      label: 'Government Issued ID',
      value: 'government_id',
      evidence: 'selected token exposes a Remove item control',
    }],
  });
  expect(documentType.constraints.rawInputValue).toBe('');
});
