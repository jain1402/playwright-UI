const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { inspectEkycUpload, findProjectEkycFixtures } = require('./uploadInspector');
const { attachApprovedEkycFixture } = require('./onboardingAutomation');

test.describe('E-KYC upload inspection', () => {
  test('reads native document options and file constraints without uploading', async ({ page }) => {
    await page.setContent(`
      <form>
        <label for="document-type">Document Type</label>
        <select id="document-type" name="documentType" required>
          <option value="">Choose a document</option>
          <option value="passport">Passport</option>
          <option value="utility-bill">Utility Bill</option>
        </select>
        <section aria-labelledby="identity-proof-label">
          <h2 id="identity-proof-label">Identity Proof</h2>
          <p>Supported Format: PDF/JPEG (Max: 5MB)</p>
          <div class="formio-component-container formio-component-identity_proof">
            <div class="form-group required">
              <input id="identity-file" name="identityFile" type="file" accept=".pdf,image/jpeg">
            </div>
          </div>
        </section>
      </form>
    `);

    const report = await inspectEkycUpload(page);

    expect(report.documentTypeLabelObserved).toBe(true);
    expect(report.options.map(option => option.label)).toContain('Passport');
    expect(report.options.map(option => option.label)).toContain('Utility Bill');
    expect(report.fileInputs).toHaveLength(1);
    expect(report.fileInputs[0].constraints).toMatchObject({
      accept: '.pdf,image/jpeg',
      acceptedFormats: ['.pdf', 'image/jpeg'],
      acceptedFormatsFromInstructions: ['PDF', 'JPEG'],
      supportedFormatText: 'PDF/JPEG (Max: 5MB)',
      maxFileSizeText: '5MB',
      required: true,
      requiredStatus: 'required-by-rendered-required-class',
    });
    expect(report.fileInputs[0].associationSource).toBe('nearest-semantic-or-upload-container');
    expect(report.fileInputs[0].associatedSection).toContain('Identity Proof');
    expect(report.fileInputs[0].fieldComponent).toBe('identity_proof');
    expect(report.fileInputs[0].fieldComponentSelector).toBe('.formio-component-identity_proof');
    expect(report.documentInstructions.acceptedFormats).toEqual(['PDF', 'JPEG']);
    expect(report.uploadAttempted).toBe(false);
    expect(report.continueClicked).toBe(false);
    expect(await page.locator('#identity-file').evaluate(input => input.files.length)).toBe(0);
  });

  test('opens a custom Document Type control only to inspect actual visible options', async ({ page }) => {
    await page.setContent(`
      <div>
        <span>Document Type</span>
        <span>Government Issued ID</span>
        <button type="button" aria-label="Remove item: 'government_id'">Remove item</button>
        <input id="document-type" aria-label="autocomplete">
        <div id="menu" role="listbox" hidden>
          <div role="option" data-value="passport">Passport</div>
          <div role="option" data-value="residence">Proof of Residence</div>
        </div>
      </div>
    `);
    await page.locator('#document-type').evaluate(button => {
      document.querySelector('#document-type').addEventListener('click', () => {
        document.querySelector('#menu').hidden = false;
      });
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          document.querySelector('#menu').hidden = true;
        }
      });
    });

    const report = await inspectEkycUpload(page);

    expect(report.openedForInspection).toBe(true);
    expect(report.options.map(option => option.label)).toEqual(['Passport', 'Proof of Residence']);
    expect(report.options.map(option => option.value)).toEqual(['passport', 'residence']);
    expect(report.committedDocumentTypes).toEqual([{
      label: 'Government Issued ID',
      value: 'government_id',
      evidence: 'selected token exposes a Remove item control',
    }]);
    expect(report.committedSelectionPreserved).toBe(true);
    expect(report.result).toContain('without selecting one');
    expect(await page.locator('#menu').isVisible()).toBe(false);
  });

  test('reports no project fixture without creating one', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ekyc-fixture-scan-'));
    try {
      const fixtureDirectory = path.join(root, 'utils', 'testfile', 'nested');
      fs.mkdirSync(fixtureDirectory, { recursive: true });
      fs.writeFileSync(path.join(fixtureDirectory, 'notes.txt'), '');
      fs.writeFileSync(path.join(fixtureDirectory, 'uat-sample.PNG'), '');

      const fixtures = findProjectEkycFixtures(root);

      expect(fixtures.directory).toBe(path.join('utils', 'testfile'));
      expect(fixtures.directoryExists).toBe(true);
      expect(fixtures.files).toEqual([
        {
          path: path.join('utils', 'testfile', 'nested', 'notes.txt'),
          extension: '.txt',
          sizeBytes: 0,
        },
        {
          path: path.join('utils', 'testfile', 'nested', 'uat-sample.PNG'),
          extension: '.png',
          sizeBytes: 0,
        },
      ]);
      expect(fixtures.found).toEqual([path.join('utils', 'testfile', 'nested', 'uat-sample.PNG')]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports a missing requested fixture directory distinctly', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ekyc-fixture-missing-'));
    try {
      const fixtures = findProjectEkycFixtures(root);

      expect(fixtures).toMatchObject({
        directory: path.join('utils', 'testfile'),
        directoryExists: false,
        files: [],
        found: [],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('associates a hidden input with its stable Form.io field key', async ({ page }) => {
    await page.setContent(`
      <div class="formio-component formio-component-container formio-component-poi_gov_id_front">
        <div class="formio-component formio-component-contact_file formio-component-customfilecomponent">
          <label for="generated-id">Government ID front</label>
          <input id="generated-id" name="data[poi_gov_id_front]" type="file" hidden>
        </div>
      </div>
    `);

    const report = await inspectEkycUpload(page);

    expect(report.fileInputs[0]).toMatchObject({
      id: 'generated-id',
      name: 'data[poi_gov_id_front]',
      fieldComponent: 'poi_gov_id_front',
      fieldComponentSelector: '.formio-component-poi_gov_id_front',
    });
    expect(report.fileInputs[0].associationSource).toBe('native-label-association');
  });

  test('attaches an explicitly approved synthetic PNG to all three stable Form.io fields', async ({ page }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ekyc-approved-fixture-'));
    const priorApproval = process.env.TEST_EKYC_SYNTHETIC_FIXTURE_APPROVED;
    const fixtureDirectory = path.join(root, 'utils', 'testfile', 'nested');
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    fs.writeFileSync(path.join(fixtureDirectory, 'synthetic-uat.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1x8AAAAASUVORK5CYII=',
      'base64',
    ));

    try {
      process.env.TEST_EKYC_SYNTHETIC_FIXTURE_APPROVED = 'true';
      const fields = [
        ['poi_gov_id_front', 'Government ID front'],
        ['poi_gov_id_back', 'Government ID back'],
        ['por_document', 'Proof of residence'],
      ];
      const components = fields.map(([key, label]) => `
        <div class="formio-component formio-component-file formio-component-${key}">
          <label for="generated-${key}">${label}</label>
          <input id="generated-${key}" name="data[${key}]" type="file" hidden>
          <span class="attached-name" hidden></span>
        </div>
      `).join('');
      await page.setContent(`
        <section class="document-upload">
          <p>Supported Format: PNG (Max: 5MB)</p>
          ${components}
        </section>
        <script>
          for (const input of document.querySelectorAll('input[type="file"]')) {
            input.addEventListener('change', () => {
              const output = input.parentElement.querySelector('.attached-name');
              output.textContent = input.files[0]?.name || '';
              output.hidden = !output.textContent;
            });
          }
        </script>
      `);

      const inspection = await inspectEkycUpload(page);
      inspection.fixture = findProjectEkycFixtures(root);
      const result = await attachApprovedEkycFixture(page, inspection, root);

      expect(result.status, `${result.failedField}: ${result.reason}`).toBe('attached');
      expect(result.fields.map(field => field.fieldKey)).toEqual(fields.map(([key]) => key));
      for (const [key] of fields) {
        const input = page.locator(`.formio-component-${key} input[type="file"]`);
        expect(await input.evaluate(element => element.files[0]?.name)).toBe('synthetic-uat.png');
        await expect(page.locator(`.formio-component-${key}`)).toContainText('synthetic-uat.png');
      }
    } finally {
      if (priorApproval === undefined) delete process.env.TEST_EKYC_SYNTHETIC_FIXTURE_APPROVED;
      else process.env.TEST_EKYC_SYNTHETIC_FIXTURE_APPROVED = priorApproval;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
