const { expect } = require('@playwright/test');

class LoginPage {
  constructor(page) {
    this.page = page;
    this.email = page.getByRole('textbox', { name: 'Email *' });
    this.password = page.getByRole('textbox', { name: 'Password *' });
    this.submitButton = page.getByRole('button', { name: 'Sign In', exact: true });
  }

  async login(email, password) {
    await this.page.goto('/signin');
    await this.email.fill(email);
    await this.password.fill(password);
    const loginResponse = this.page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/brand/forms/login') &&
        response.request().method() === 'POST',
    );
    await this.submitButton.click();
    this.loginResponse = await loginResponse;
  }

  async verifyLoginSuccess() {
    expect(this.loginResponse, 'Login response should be captured').toBeTruthy();
    expect(this.loginResponse.status(), 'Login should be accepted').toBe(200);
    await expect(this.page).toHaveURL(/\/onboarding$/i);
    await expect(this.page.getByRole('button', { name: 'Profile', exact: true })).toBeVisible();
  }
}

module.exports = { LoginPage };
