const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { LoginPage } = require('../pages/LoginPage');

const AUTH_STATE_PATH = path.join(__dirname, '..', 'playwright', '.auth', 'user.json');
const OTP_CHALLENGE = /\b(?:otp|one[- ]time (?:password|code)|verification code|enter (?:the )?code)\b/i;

test('authenticate an existing QA account and save Playwright storage state', async ({ page }) => {
  const email = process.env.TEST_EMAIL;
  const password = process.env.TEST_PASSWORD;
  if (!email || !password) {
    throw new Error('Set TEST_EMAIL and TEST_PASSWORD in .env or the environment to authenticate an existing QA account.');
  }

  const loginPage = new LoginPage(page);
  await loginPage.login(email, password);

  const status = loginPage.loginResponse.status();
  if (status !== 200) {
    throw new Error(`Existing-account Sign In was rejected with HTTP ${status}; no storage state was saved.`);
  }

  try {
    await loginPage.verifyLoginSuccess();
  } catch {
    const bodyText = await page.locator('body').innerText();
    if (OTP_CHALLENGE.test(bodyText)) {
      throw new Error('Sign In requires OTP or another verification step. Complete it through the approved QA process; no storage state was saved.');
    }
    const currentPath = new URL(page.url()).pathname;
    throw new Error(`Sign In did not reach authenticated onboarding (current path: ${currentPath}); no storage state was saved. A required verification step may be blocking access.`);
  }

  await expect(page.getByRole('button', { name: 'Profile', exact: true })).toBeVisible();

  fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });
  await page.context().storageState({ path: AUTH_STATE_PATH });
  console.log('Authenticated storage state saved to playwright/.auth/user.json.');
});
