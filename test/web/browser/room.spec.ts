import { expect, test, type Page } from '@playwright/test';

const apiUrl = 'http://127.0.0.1:4399';

async function createRoom(page: Page, title = `Room ${Date.now()}`) {
  await page.goto('/');
  const newRoom = page.getByRole('button', { name: 'New room' });
  if (await newRoom.isVisible()) await newRoom.click();
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Goal').fill('Produce a reviewed release checklist.');
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  return title;
}

function composer(page: Page) {
  return page.getByRole('form', { name: 'Message composer' });
}

async function send(page: Page, body: string) {
  await composer(page).getByLabel('Message').fill(body);
  await composer(page).getByRole('button', { name: 'Send' }).click();
  await expect(composer(page).getByLabel('Message')).toHaveValue('');
}

function thread(page: Page) {
  return page.getByRole('list', { name: 'Shared conversation' });
}

function roomIdFrom(page: Page) {
  return decodeURIComponent(new URL(page.url()).hash.replace('#/rooms/', ''));
}

test('demo flow: human → Claude → Codex question → Claude revision → Codex review, restored after refresh', async ({ page }) => {
  await createRoom(page, 'Release room');
  await expect(page.getByTestId('mode-badge')).toContainText('Simulated');

  await composer(page).getByLabel('Message').fill('@claude draft a release checklist');
  await expect(page.getByTestId('composer-hint')).toContainText('Starts work: queues a turn for Claude (from @mention)');
  await composer(page).getByRole('button', { name: 'Send' }).click();

  const provisional = page.getByTestId('provisional');
  await expect(provisional).toContainText('Provisional · not committed to the thread');
  await expect(provisional).toContainText('Simulated');
  await expect(page.getByTestId('active-turn')).toContainText('Claude is working');

  const handoffToCodex = thread(page).locator('[data-kind="handoff"][data-author="claude"]').first();
  await expect(handoffToCodex).toContainText('Handoff → Codex');
  await expect(handoffToCodex).toContainText('Simulated');

  const question = thread(page).getByTestId('question-card');
  await expect(question).toContainText('Node 24 LTS only');
  await expect(page.getByTestId('run-status')).toHaveText('Waiting for you');

  await question.getByRole('button', { name: 'Node 24 only' }).click();
  await expect(composer(page).getByLabel('Message')).toHaveValue('Node 24 only');
  await expect(page.getByTestId('composer-hint')).toContainText("Answers Codex's question");
  await expect(composer(page).getByLabel('Recipient')).toBeDisabled();
  await composer(page).getByRole('button', { name: 'Send' }).click();

  await expect(thread(page).getByText('Correction round')).toBeVisible({ timeout: 15_000 });
  await expect(thread(page).getByTestId('review-card').first()).toContainText('1 finding');
  await expect(thread(page).locator('[data-kind="task_completed"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('run-status')).toHaveText('Queue drained');
  await expect(page.getByTestId('run-explanation')).toContainText('does not by itself mean the goal is met');

  const history = page.getByTestId('artifact-history');
  await expect(history.getByRole('button', { name: 'v2 (latest)' })).toBeVisible();
  await expect(page.getByTestId('task')).toContainText('Completed');
  await expect(page.getByTestId('task')).toContainText('corrections 1/2');
  await expect(page.getByTestId('usage')).toContainText('usage unavailable');

  // Stale inspection: v1 is pinned with its own review, and flagged as superseded.
  await history.getByRole('button', { name: 'v1', exact: true }).click();
  const viewer = page.getByRole('dialog');
  await expect(viewer.getByTestId('stale-banner')).toContainText('superseded by v2');
  await expect(viewer.getByTestId('artifact-content')).toContainText('Node (any recent version)');
  await viewer.getByRole('tab', { name: /Reviews/ }).click();
  await expect(viewer).toContainText('major');
  await viewer.getByRole('button', { name: 'Open v2' }).click();
  await viewer.getByRole('tab', { name: 'Changes' }).click();
  await expect(viewer.getByTestId('artifact-diff')).toContainText('+ - Runtime: Node 24 only');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();

  const countBefore = await thread(page).getByRole('article').count();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Release room' })).toBeVisible();
  await expect(thread(page).getByRole('article')).toHaveCount(countBefore);
  await expect(page.getByTestId('task')).toContainText('Completed');
  await expect(page.getByTestId('artifact-history').getByRole('button', { name: 'v2 (latest)' })).toBeVisible();
});

test('pause before handoff holds the queued Codex turn until resume', async ({ page }) => {
  await createRoom(page);
  await send(page, '@claude draft it');
  await expect(page.getByTestId('active-turn')).toContainText('Claude is working');

  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByTestId('run-status')).toHaveText('Paused');
  await expect(page.getByTestId('run-explanation')).toContainText("Claude's current turn is still running");

  await expect(thread(page).locator('[data-kind="handoff"]')).toBeVisible();
  await expect(page.getByTestId('active-turn')).toContainText('No agent turn running');
  await expect(page.getByText('1 queued')).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('active-turn')).toContainText('No agent turn running');

  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByTestId('active-turn')).toContainText('Codex is working');
});

test('stop during stream reflects unconfirmed cancellation then drops provisional output', async ({ page }) => {
  await createRoom(page);
  await send(page, '@claude draft it');
  await expect(page.getByTestId('provisional')).toBeVisible();

  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByTestId('run-status')).toHaveText('Stopped');
  await expect(page.getByTestId('run-explanation')).toContainText(/has not confirmed it ended|Queued work was cancelled/);
  await expect(page.getByTestId('provisional')).toHaveCount(0);
  await expect(page.getByTestId('active-turn')).toContainText('No agent turn running');
  await expect(thread(page).locator('[data-kind="handoff"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
});

test('guidance sent mid-turn is saved and marked for the next turn', async ({ page }) => {
  await createRoom(page);
  await send(page, '@claude draft it');
  await expect(page.getByTestId('active-turn')).toContainText('Claude is working');

  await composer(page).getByLabel('Message').fill('Keep it short please');
  await expect(page.getByTestId('composer-hint')).toContainText('Adds shared context only');
  await expect(page.getByTestId('composer-hint')).toContainText('not injected into the current one');
  await composer(page).getByRole('button', { name: 'Send' }).click();

  const guidance = thread(page).getByRole('article').filter({ hasText: 'Keep it short please' });
  await expect(guidance.getByText('Saved · delivered next turn')).toBeVisible();
  // Codex's turn starts after the guidance was saved, so it is no longer pending.
  await expect(page.getByTestId('active-turn')).toContainText('Codex is working', { timeout: 10_000 });
  await expect(guidance.getByText('Saved · delivered next turn')).toHaveCount(0);
});

test('API failure shows the HTTP error and retry reuses the idempotency key', async ({ page }) => {
  await createRoom(page);
  const keys: string[] = [];
  let failNext = true;
  await page.route('**/api/rooms/*/messages', async (route) => {
    keys.push((await route.request().headerValue('idempotency-key')) ?? '');
    if (failNext) {
      failNext = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'Engine busy.' } }) });
    } else {
      await route.continue();
    }
  });

  await composer(page).getByLabel('Message').fill('Context for later');
  await composer(page).getByRole('button', { name: 'Send' }).click();
  const alert = composer(page).getByRole('alert');
  await expect(alert).toContainText('HTTP 503');
  await expect(composer(page).getByLabel('Message')).toHaveValue('Context for later');

  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(thread(page).getByText('Context for later')).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(keys[1]).toBe(keys[0]);

  await send(page, 'Context for later');
  expect(keys).toHaveLength(3);
  expect(keys[2]).not.toBe(keys[0]);
});

test('SSE reconnect refetches history that was committed while disconnected', async ({ page, request }) => {
  await createRoom(page);
  await expect(page.getByTestId('connection')).toContainText('Connected');
  const roomId = roomIdFrom(page);

  await request.post(`${apiUrl}/__test/drop-sse`);
  await request.post(`${apiUrl}/__test/quiet-message/${roomId}`, { data: { body: 'Committed while you were disconnected' } });
  await expect(thread(page).getByText('Committed while you were disconnected')).toBeVisible();
  await expect(page.getByTestId('connection')).toContainText('Connected');
});

test('interrupted work requires acknowledging unknown side effects', async ({ page, request }) => {
  await createRoom(page);
  await send(page, '@claude draft it');
  await expect(page.getByTestId('active-turn')).toContainText('Claude is working');
  await request.post(`${apiUrl}/__test/interrupt/${roomIdFrom(page)}`);

  await expect(page.getByTestId('run-status')).toHaveText('Interrupted');
  await expect(page.getByTestId('run-explanation')).toContainText('side effects are unknown');
  await page.getByRole('button', { name: 'Recover…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Recover interrupted work' });
  const confirm = dialog.getByRole('button', { name: 'Recover', exact: true });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/side effects that are unknown/).check();
  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect(thread(page).getByText('It was not replayed; its side effects are unknown.')).toBeVisible();
});

test('fresh session is explicit and never labelled resumed', async ({ page, request }) => {
  await createRoom(page);
  await send(page, '@claude draft it');
  await expect(page.getByTestId('active-turn')).toContainText('Claude is working', { timeout: 10_000 });
  await request.post(`${apiUrl}/__test/interrupt/${roomIdFrom(page)}`);
  await expect(page.getByTestId('run-status')).toHaveText('Interrupted');

  await page.getByTestId('participant-claude').getByRole('button', { name: 'Start fresh session…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start a fresh Claude session' });
  await expect(dialog).toContainText('The previous session is not resumed');
  await dialog.getByRole('button', { name: 'Start fresh session' }).click();
  await expect(page.getByTestId('participant-claude')).toContainText('session fresh');
  await expect(page.locator('body')).not.toContainText(/resumed session/i);
});

test('composer rejects ambiguous mentions and supports keyboard send', async ({ page }) => {
  await createRoom(page);
  const input = composer(page).getByLabel('Message');
  await input.fill('@claude and @codex both look');
  await expect(page.getByTestId('composer-hint')).toContainText('mentions both');
  await expect(composer(page).getByRole('button', { name: 'Send' })).toBeDisabled();

  await input.fill('Plain shared context');
  await input.press('ControlOrMeta+Enter');
  await expect(thread(page).getByText('Plain shared context')).toBeVisible();
  await expect(page.getByTestId('active-turn')).toContainText('No agent turn running');
  await expect(page.getByTestId('run-status')).toHaveText('No run yet');
});

test('live mode and repository association are disabled with reasons', async ({ page }) => {
  await page.goto('/');
  const newRoom = page.getByRole('button', { name: 'New room' });
  if (await newRoom.isVisible()) await newRoom.click();
  await expect(page.getByLabel('Live providers')).toBeDisabled();
  await expect(page.getByText(/Live is off: live Claude\/Codex adapters/)).toBeVisible();
  await expect(page.getByLabel('Repository path (optional)')).toBeDisabled();
  await expect(page.getByText(/Repository association is off/)).toBeVisible();
});

test('untrusted markdown cannot inject HTML, scripts or remote images; token not rendered', async ({ page, request }) => {
  await createRoom(page);
  await send(page, 'Look <img src="https://example.invalid/x.png" onerror="window.__pwned=1"> [click](javascript:window.__pwned=1) ![pic](https://example.invalid/p.png)');
  const message = thread(page).getByRole('article').filter({ hasText: 'Look' });
  await expect(message).toBeVisible();
  await expect(message.locator('img')).toHaveCount(0);
  await expect(message.getByText('[image: pic]')).toBeVisible();
  await expect(message.locator('a[href^="javascript"]')).toHaveCount(0);
  await expect(message.getByText('click')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();

  const { token } = (await (await request.get(`${apiUrl}/api/bootstrap`)).json()) as { token: string };
  expect(await page.content()).not.toContain(token);
});

test('narrow layout keeps the thread readable with drawers for rooms and details', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Show rooms' }).click();
  const newRoom = page.getByRole('button', { name: 'New room' });
  if (await newRoom.isVisible()) await newRoom.click();
  await page.getByLabel('Title').fill('Narrow room');
  await page.getByLabel('Goal').fill('Check narrow layout.');
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Narrow room' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Rooms' })).toBeHidden();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(composer(page).getByLabel('Message')).toBeVisible();

  await page.getByRole('button', { name: 'Show room details' }).click();
  await expect(page.getByTestId('goal')).toBeVisible();
});
