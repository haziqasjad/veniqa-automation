// Import Playwright's test runner and the expect assertion library
const { test, expect } = require('playwright/test');

// Import our snapshot helper so we can capture the page HTML on failure
const { saveSnapshot } = require('../healer/snapshot.js');

test('logged in user can add item to cart', async ({ page }) => {
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

    // Navigate directly to a known product page
    await page.goto('/#/products/5c8d65266a4db90048956610');

    // Click the Add to Cart button on that product
    await page.getByRole('button', { name: 'Add to Cart' }).click();

    // Assert the cart confirmation message appears
    await expect(page.getByText('Added to Cart')).toBeVisible();

  } catch (err) {
    // If anything above failed, save the current page HTML to healer/snapshots/
    await saveSnapshot(page, 'logged in user can add item to cart');

    // Re-throw the error so Playwright still marks this test as FAILED
    throw err;
  }
});
