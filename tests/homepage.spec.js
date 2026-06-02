// Import Playwright's test runner and the expect assertion library
const { test, expect } = require('playwright/test');

// Import our snapshot helper so we can capture the page HTML on failure
const { saveSnapshot } = require('../healer/snapshot.js');

test('homepage loads correctly', async ({ page }) => {
  try {
    // Navigate to the shopping homepage
    await page.goto('/');

    // Assert the browser tab title matches exactly
    await expect(page).toHaveTitle('Veniqa New York');

    // Assert the Women nav link is visible
    await expect(page.getByRole('link', { name: 'Women' })).toBeVisible();

    // Assert the Login nav link is visible
    await expect(page.getByRole('link', { name: 'Login' })).toBeVisible();

  } catch (err) {
    // If anything above failed, save the current page HTML to healer/snapshots/
    await saveSnapshot(page, 'homepage loads correctly');

    // Re-throw the error so Playwright still marks this test as FAILED
    throw err;
  }
});
