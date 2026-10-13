const { test, expect } = require('@playwright/test');
const { waitForOnboardingStepSurface } = require('./onboardingAutomation');

test('detects Sumsub inside an iframe and resumes only after a later onboarding form appears', async ({ page }) => {
  await page.setContent(`
    <div id="tracker" class="step-tracker">Step 3 of 6</div>
    <iframe title="verification" style="width: 400px; height: 240px" srcdoc="
      <main>
        <h1>Sumsub</h1>
        <p>Verify your identity to continue.</p>
        <button id='continue'>Continue</button>
      </main>
      <script>
        document.querySelector('#continue').addEventListener('click', () => {
          parent.postMessage('continue-was-clicked', '*');
        });
      </script>
    "></iframe>
    <section id="next-step" hidden>
      <h1>Proof of Identity</h1>
      <div class="formio-component formio-component-textfield formio-component-document_category">
        <label for="document-category">Document Category</label>
        <input id="document-category" name="data[document_category]" type="text" required>
      </div>
      <button type="button">Continue</button>
    </section>
    <script>
      window.sumsubContinueClicked = false;
      window.addEventListener('message', event => {
        if (event.data === 'continue-was-clicked') window.sumsubContinueClicked = true;
      });
      setTimeout(() => {
        document.querySelector('#tracker').textContent = 'Step 4 of 6';
        document.querySelector('#next-step').hidden = false;
      }, 250);
    </script>
  `);

  const result = await waitForOnboardingStepSurface(page, 5_000);

  expect(result, JSON.stringify(result.manualEkyc, null, 2)).toMatchObject({
    ready: true,
    timedOut: false,
    manualEkyc: {
      detected: true,
      completed: true,
      evidence: {
        sumsubBrandingVisible: true,
        verificationIntroductionVisible: true,
        trackerShowsPageThree: true,
        continueVisible: true,
      },
      nextForm: {
        title: 'Proof of Identity',
        tracker: { currentStep: '4', totalSteps: 6 },
      },
    },
  });
  expect(result.manualEkyc.nextForm.fields).toContainEqual(expect.objectContaining({
    label: 'Document Category',
    required: true,
  }));
  expect(await page.evaluate(() => window.sumsubContinueClicked)).toBe(false);
});

test('blocks if Sumsub is detected but the next onboarding form does not appear before timeout', async ({ page }) => {
  await page.setContent(`
    <div class="step-tracker">Page 3 of 6</div>
    <iframe title="Sumsub verification" style="width: 400px; height: 240px" srcdoc="
      <main><h1>Sumsub</h1><p>Identity verification</p><button>Continue</button></main>
    "></iframe>
  `);

  const result = await waitForOnboardingStepSurface(page, 300);

  expect(result).toMatchObject({
    ready: false,
    timedOut: true,
    manualEkyc: {
      detected: true,
      completed: false,
      timedOut: true,
      reason: 'E-KYC manual verification was not completed within 120 seconds.',
    },
  });
});
