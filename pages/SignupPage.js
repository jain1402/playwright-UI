const { randomInt, randomUUID } = require('node:crypto');
const { expect } = require('@playwright/test');
const { generateUniqueMobile } = require('../utils/mobilenumber');

const PHONE_COUNTRIES = [
  { name: 'United Kingdom', callingCode: '+44', countryCode: 'GB' },
  { name: 'India', callingCode: '+91', countryCode: 'IN' },
];

const PASSWORD = 'Fynxt@123';

class SignupPage {
  constructor(page) {
    this.page = page;
    this.accountType = page.getByRole('combobox').nth(0);
    this.title = page.getByRole('combobox').nth(1);
    this.residenceCountry = page.getByRole('combobox').nth(2);
    this.firstName = page.getByRole('textbox', { name: 'First Name *' });
    this.lastName = page.getByRole('textbox', { name: 'Last Name *' });
    this.email = page.getByRole('textbox', { name: 'Email Address *', exact: true });
    this.confirmEmail = page.getByRole('textbox', { name: 'Confirm Email Address *' });
    this.password = page.getByRole('textbox', { name: 'Password *', exact: true });
    this.confirmPassword = page.getByRole('textbox', { name: 'Confirm Password *' });
    this.phoneCountry = page.getByRole('button', { name: /Change country, selected/ }).nth(0);
    this.phone = page.getByRole('textbox', { name: 'Phone Number *' });
    this.alternatePhoneCountry = page.getByRole('button', { name: /Change country, selected/ }).nth(1);
    this.alternatePhone = page.getByRole('textbox', { name: 'Alternate Phone Number' });
    this.submitButton = page.getByRole('button', { name: 'Sign up', exact: true });
  }

  async navigate() {
    await this.page.goto('/signin');
  }

  async openSignup() {
    await this.page.getByRole('link', { name: 'Sign Up' }).click();
    await expect(this.page).toHaveURL(/\/signup$/);
  }

  async selectAccountType() {
    await this.accountType.click();
    await this.page.getByRole('option', { name: 'Individual', exact: false }).click();
  }

  async selectResidenceCountry() {
    await this.residenceCountry.click();
    await this.page.getByRole('option', { name: 'India', exact: true }).click();
  }

  async selectTitle() {
    await this.title.click();
    await this.page.getByRole('option', { name: 'mr', exact: true }).click();
  }

  async enterPersonalDetails({ firstName, lastName, email, password }) {
    await this.firstName.fill(firstName);
    await this.lastName.fill(lastName);
    await this.email.fill(email);
    await this.confirmEmail.fill(email);
    await this.password.fill(password);
    await this.confirmPassword.fill(password);
  }

  async choosePhoneCountry(countrySelector) {
    const selectedCountry = PHONE_COUNTRIES[randomInt(PHONE_COUNTRIES.length)];
    await countrySelector.click();
    await this.page
      .getByRole('option', {
        name: new RegExp(`${selectedCountry.name}\\s*\\${selectedCountry.callingCode}`),
      })
      .click();

    return selectedCountry;
  }

  async selectRandomPhoneCountry() {
    const country = await this.choosePhoneCountry(this.phoneCountry);
    await this.phone.fill(generateUniqueMobile(country.countryCode));
  }

  async selectRandomAlternateCountry() {
    const country = await this.choosePhoneCountry(this.alternatePhoneCountry);
    await this.alternatePhone.fill(generateUniqueMobile(country.countryCode));
  }

  async submit() {
    const signupResponse = this.page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/brand/forms/signup') &&
        response.request().method() === 'POST',
    );
    await this.submitButton.click();
    this.signupResponse = await signupResponse;
  }

  async verifySignupSuccess() {
    expect(this.signupResponse, 'Signup form response should be captured').toBeTruthy();
    expect(this.signupResponse.status(), 'Signup should be created by the application').toBe(201);
    await expect(this.page).toHaveURL(/\/signIn$/i);
  }

  async signup() {
    const credentials = {
      email: `test-${randomUUID()}@example.com`,
      password: PASSWORD,
    };

    await this.navigate();
    await this.openSignup();
    await this.selectAccountType();
    await this.selectResidenceCountry();
    await this.selectTitle();
    await this.enterPersonalDetails({
      firstName: 'Playwright',
      lastName: 'Test',
      ...credentials,
    });
    await this.selectRandomPhoneCountry();
    await this.selectRandomAlternateCountry();
    await this.submit();
    await this.verifySignupSuccess();

    return credentials;
  }
}

module.exports = { SignupPage };
