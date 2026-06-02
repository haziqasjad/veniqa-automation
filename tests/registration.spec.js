// Import Playwright's test runner and the expect assertion library
const { test, expect } = require('playwright/test');

// Import our snapshot helper so we can capture the page HTML on failure
const { saveSnapshot } = require('../healer/snapshot.js');

test('user registration form', async ({ page }) => {
  try {
    // Generate a unique email using the current timestamp so each test run creates a fresh user
    const uniqueEmail = `testuser+${Date.now()}@gmail.com`;

    // Navigate to the shopping homepage
    await page.goto('/');

    // Click the Login link to open the login/registration page
    await page.getByRole('link', { name: 'Login' }).click();

    // Click the "New User? Register here." link to switch to the registration form
    await page.getByText('New User? Register here.').click();

    // Fill in the full name field
    await page.locator('#name').fill('Test User');

    // Fill in the unique email address
    await page.locator('#username').fill(uniqueEmail);

    // Fill in the password
    await page.locator('#password').fill('password123');

    // Fill in the confirm password field
    await page.locator('#confirmPassword').fill('password123');

    // Fill in the phone number
    await page.locator('#phone').fill('1234567890');

    // Bypass the CAPTCHA by directly setting the Vue component's captchaResp value
    await page.evaluate(() => {
      const el = document.querySelector('.white-bg');
      if (el && el.__vue__) {
        el.__vue__.captchaResp = 'fake-captcha-token';
      }
    });

    // Click the Register submit button
    await page.getByRole('button', { name: 'Register' }).click();

    // Assert the success confirmation message is visible
    await expect(
      page.getByText('User successfully created. Please check your inbox to confirm email')
    ).toBeVisible();

  } catch (err) {
    // If anything above failed, save the current page HTML to healer/snapshots/
    await saveSnapshot(page, 'user registration form');

    // Re-throw the error so Playwright still marks this test as FAILED
    throw err;
  }
});
