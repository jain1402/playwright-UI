const { test } = require('@playwright/test');
const { SignupPage } = require('../pages/SignupPage');
const { LoginPage } = require('../pages/LoginPage');

test('sign up and log in with the same generated credentials', async ({ page }) => {
  const signupPage = new SignupPage(page);
  const user = await signupPage.signup();

  const loginPage = new LoginPage(page);
  await loginPage.login(user.email, user.password);
  await loginPage.verifyLoginSuccess();
});
