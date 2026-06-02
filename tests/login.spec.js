// Import Playwright's test runner and the expect assertion library
const { test, expect } = require('playwright/test');

// Import our snapshot helper so we can capture the page HTML on failure
const { saveSnapshot } = require('../healer/snapshot.js');

test('user can login and logout', async ({ page }) => {
  try {
    // Navigate to the shopping homepage
    await page.goto('/');

    // Click the Login link in the nav bar
    await page.getByRole('link', { name: 'Login' }).click();

    // Fill in the email address field
    await page.locator('#username').fill('test@test.com');

    // Fill in the password field
    await page.locator('[name="password"]').fill('password123');

    // Click the Login submit button
    await page.getByRole('button', { name: 'Login' }).click();

    // Assert the success toast message is visible
    await expect(page.getByText('Successfully logged in')).toBeVisible();

    // Click the account dropdown in the nav bar
    await page.locator('a.dropdown-toggle').click();

    // Click the Logout menu item
    await page.getByRole('menuitem', { name: 'Logout' }).click();

    // Assert the logout confirmation message is visible
    await expect(page.getByText('You have been successfully logged out.')).toBeVisible();

  } catch (err) {
    // If anything above failed, save the current page HTML to healer/snapshots/
    await saveSnapshot(page, 'user can login and logout');

    // Re-throw the error so Playwright still marks this test as FAILED
    throw err;
  }
});
