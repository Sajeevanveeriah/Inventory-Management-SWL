import { expect, type Page } from '../fixture';

/** Navigate through the compact application's real, operator-visible menu. */
export async function navigateFromCompactMenu(page: Page, name: string) {
  const menuButton = page.getByRole('button', { name: 'Menu', exact: true });
  await expect(menuButton).toBeVisible();
  await menuButton.click();

  const navigation = page.getByRole('dialog', {
    name: 'Application navigation',
  });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Close menu', exact: true })).toBeVisible();
  await navigation.getByRole('button', { name, exact: true }).click();
  await expect(navigation).toBeHidden();
}
