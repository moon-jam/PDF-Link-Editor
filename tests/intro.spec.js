import { test, expect } from '@playwright/test';

test('intro shows on first visit and the opt-out is remembered', async ({ page }) => {
  // First visit: the intro modal is shown automatically.
  await page.goto('/');
  await expect(page.locator('#help-panel')).toBeVisible();

  // Opt out of the startup intro, then close it.
  await page.check('#help-dontshow');
  await page.click('#help-close');
  await expect(page.locator('#help-panel')).toBeHidden();

  // Reload: it no longer auto-shows, but the help button still opens it, and
  // the checkbox reflects the saved preference.
  await page.reload();
  await expect(page.locator('#help-panel')).toBeHidden();
  await page.click('#help-btn');
  await expect(page.locator('#help-panel')).toBeVisible();
  await expect(page.locator('#help-dontshow')).toBeChecked();
});
