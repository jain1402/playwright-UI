const { test, expect } = require('@playwright/test');
const { SignupPage } = require('../pages/SignupPage');
const { LoginPage } = require('../pages/LoginPage');
const { runOnboardingAutomation } = require('./onboardingAutomation');

test('sign up, sign in, complete onboarding forms, and verify 100% completion', async ({ page }, testInfo) => {
  test.setTimeout(900_000);

  console.log('=== INDIVIDUAL ONBOARDING E2E ===');
  await page.goto('/');
  const signupPage = new SignupPage(page);
  const user = await signupPage.signup();
  console.log('[PASS] Signup');

  const loginPage = new LoginPage(page);
  await loginPage.login(user.email, user.password);
  await loginPage.verifyLoginSuccess();
  console.log('[PASS] Sign in');

  const onboardingReport = await runOnboardingAutomation(page, testInfo);
  expect(
    onboardingReport.finalCompletionVerified,
    'Onboarding must visibly confirm completion before reporting success.',
  ).toBe(true);
});
