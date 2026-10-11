import { expect, test, type Page } from '@playwright/test';

async function newRoom(page: Page, title: string) {
  await page.goto('/');
  const button = page.getByRole('button', { name: 'New room', exact: true });
  if (await button.isVisible()) await button.click();
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('Goal', { exact: true }).fill('Fix cache concurrency while preserving the public API.');
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}
function composer(page: Page) { return page.getByRole('form', { name: 'Message composer' }); }
function thread(page: Page) { return page.getByRole('list', { name: 'Shared conversation' }); }
async function send(page: Page, text: string) {
  await composer(page).getByLabel('Message', { exact: true }).fill(text);
  await composer(page).getByRole('button', { name: 'Send', exact: true }).click();
  await expect(composer(page).getByLabel('Message', { exact: true })).toHaveValue('');
}

test('built UI completes the persisted two-agent workflow with human guidance and exact-version review', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await newRoom(page, 'Integrated cache review');
  await expect(page.getByTestId('mode-badge')).toContainText('Simulated');
  await send(page, '@claude propose the fix and ask Codex to challenge it');
  await expect(page.getByTestId('provisional')).toBeVisible();
  const question = thread(page).getByTestId('question-card');
  await expect(question).toContainText('which constraint');
  await expect(page.getByTestId('run-status')).toHaveText('Waiting for you');
  await question.getByRole('button', { name: 'Keep the public API unchanged.', exact: true }).click();
  await expect(composer(page).getByLabel('Recipient')).toBeDisabled();
  await composer(page).getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('run-status')).toHaveText('Queue drained');
  await expect(thread(page).locator('[data-kind="handoff"]')).toHaveCount(3);
  await expect(thread(page).locator('[data-kind="completion"]')).toContainText('Unresolved:');
  await expect(page.getByTestId('usage')).toContainText('unavailable');
  const history = page.getByTestId('artifact-history');
  await history.getByRole('button', { name: 'v1', exact: true }).click();
  const viewer = page.getByRole('dialog');
  await expect(viewer.getByTestId('stale-banner')).toContainText('superseded by v2');
  await viewer.getByRole('tab', { name: /Reviews/ }).click();
  await expect(viewer).toContainText('high');
  await expect(viewer).toContainText('Use a generation counter');
  await viewer.getByRole('button', { name: 'Open v2' }).click();
  await viewer.getByRole('tab', { name: 'Changes' }).click();
  await expect(viewer.getByTestId('artifact-diff')).toContainText('generation');
  await page.keyboard.press('Escape');
  const messages = await thread(page).getByRole('article').count();
  await page.reload();
  await expect(page.getByTestId('run-status')).toHaveText('Queue drained');
  await expect(thread(page).getByRole('article')).toHaveCount(messages);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/integrated-room.png', fullPage: true });
});

test('pause, human context, resume and stop operate on the actual dispatcher', async ({ page }) => {
  await newRoom(page, 'Human execution controls');
  await send(page, '@claude investigate');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByTestId('run-status')).toHaveText('Paused');
  await expect(thread(page).locator('[data-kind="handoff"]')).toHaveCount(1);
  await expect(page.getByTestId('active-turn')).toContainText('No agent turn running');
  await expect(page.getByText('1 queued', { exact: true })).toBeVisible();
  await send(page, 'Keep all existing behavior compatible.');
  await expect(thread(page).getByText('Keep all existing behavior compatible.')).toBeVisible();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByTestId('active-turn')).toContainText('Codex is working');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByTestId('run-status')).toHaveText('Stopped');
  await expect(page.getByTestId('provisional')).toHaveCount(0);
  await expect(page.getByTestId('active-turn')).toContainText('No agent turn running');
  await expect(thread(page).locator('[data-kind="handoff"]')).toHaveCount(1);
  await expect(thread(page).getByTestId('question-card')).toHaveCount(0);
});

test('context-only messages persist without scheduling and narrow layout remains usable', async ({ page }) => {
  await newRoom(page, 'Context only');
  await send(page, 'No agent should start for this message.');
  await expect(page.getByTestId('run-status')).toHaveText('No run yet');
  await page.reload();
  await expect(thread(page).getByText('No agent should start for this message.')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 820 });
  await expect(composer(page).getByLabel('Message', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: 'test-results/integrated-mobile.png', fullPage: true });
});
