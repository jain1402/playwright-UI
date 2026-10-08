const { test } = require('@playwright/test');
const { LoginPage } = require('../pages/LoginPage');

test('log in with the configured test account', async ({ page }) => {
  const email = process.env.TEST_EMAIL;
  const password = process.env.TEST_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'A valid login test account is required. Set TEST_EMAIL and TEST_PASSWORD in your local .env file.',
    );
  }

  const loginPage = new LoginPage(page);
  await loginPage.login(email, password);
  await loginPage.verifyLoginSuccess();
});
