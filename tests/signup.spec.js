const { test } = require('@playwright/test');
const { SignupPage } = require('../pages/SignupPage');

test('register an individual account', async ({ page }) => {
  const signupPage = new SignupPage(page);
  const user = await signupPage.signup();

  console.log(`Signup created and redirected to Sign In for ${user.email}`);
});
