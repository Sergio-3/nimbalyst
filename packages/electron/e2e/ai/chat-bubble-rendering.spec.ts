/**
 * Chat Bubble Rendering E2E Tests
 *
 * Verifies that chat message bubbles render correctly in the transcript.
 * The canonical transcript system projects TranscriptViewMessages directly
 * without converting back to legacy Message format. These tests ensure
 * that user and assistant message bubbles are visible, contain text,
 * and appear in the correct order (user above, assistant below), and that
 * the copy button on a rendered code block reaches the native clipboard.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  TEST_TIMEOUTS,
} from '../helpers';
import {
  createTestSession,
  insertUserPrompt,
  insertAssistantText,
  cleanupTestSessions,
} from '../utils/interactivePromptTestHelpers';
import {
  switchToAgentMode,
  PLAYWRIGHT_TEST_SELECTORS,
} from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspacePath: string;

test.beforeAll(async () => {
  workspacePath = await createTempWorkspace();
  await fs.writeFile(
    path.join(workspacePath, 'test.md'),
    '# Test Document\n\nHello world.\n',
    'utf8'
  );

  electronApp = await launchElectronApp({
    workspace: workspacePath,
    permissionMode: 'allow-all',
    env: { PLAYWRIGHT_TEST: 'true' },
  });
  page = await electronApp.firstWindow();
  await waitForAppReady(page);
  await switchToAgentMode(page);
  await page.waitForTimeout(500);
});

test.afterAll(async () => {
  if (page) {
    await cleanupTestSessions(page, workspacePath);
  }
  await electronApp?.close();
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
});

test('user and assistant chat bubbles render with correct content and order', async () => {
  // Create a test session with pre-inserted messages in the database
  const sessionId = await createTestSession(page, workspacePath, {
    title: 'Chat Bubble Test',
  });

  // Insert a user prompt and an assistant response into ai_agent_messages
  // The canonical transcript pipeline will transform these on load
  await insertUserPrompt(page, sessionId, 'What is the capital of France?');
  await insertAssistantText(page, sessionId, 'The capital of France is Paris.');

  // Wait for session to appear in the list
  await page.waitForTimeout(1000);

  // Navigate to the test session
  const sessionItem = page.locator(`#session-list-item-${sessionId}`);
  await expect(sessionItem).toBeVisible({ timeout: TEST_TIMEOUTS.MEDIUM });
  await sessionItem.click();
  await page.waitForTimeout(1000);

  // Wait for messages to render
  const userBubble = page.locator('.rich-transcript-message.user');
  const assistantBubble = page.locator('.rich-transcript-message.assistant');

  // Verify user bubble is visible and has content
  await expect(userBubble.first()).toBeVisible({ timeout: TEST_TIMEOUTS.MEDIUM });
  await expect(userBubble.first()).toContainText('What is the capital of France?');

  // Verify assistant bubble is visible and has content (not empty)
  await expect(assistantBubble.first()).toBeVisible({ timeout: TEST_TIMEOUTS.MEDIUM });
  await expect(assistantBubble.first()).toContainText('The capital of France is Paris.');

  // Verify ordering: user bubble should appear before assistant bubble in the DOM
  // Get the bounding boxes to compare vertical positions
  const userBox = await userBubble.first().boundingBox();
  const assistantBox = await assistantBubble.first().boundingBox();
  expect(userBox).not.toBeNull();
  expect(assistantBox).not.toBeNull();
  expect(userBox!.y).toBeLessThan(assistantBox!.y);

  // Wait 3 seconds to ensure bubbles persist (don't flicker away on reload)
  await page.waitForTimeout(3000);

  // Re-verify after delay
  await expect(userBubble.first()).toBeVisible();
  await expect(userBubble.first()).toContainText('What is the capital of France?');
  await expect(assistantBubble.first()).toBeVisible();
  await expect(assistantBubble.first()).toContainText('The capital of France is Paris.');
});

/**
 * The unit tests around the copy button stub the clipboard bridge, so the one
 * thing they cannot answer is whether a click reaches Electron's clipboard at
 * all -- `navigator.clipboard` resolves in Electron without writing anything,
 * which is why `copyToClipboard` prefers the IPC route. This exercises that
 * route against a real window and reads the result back from the main process.
 *
 * It also covers the currency escape: the transcript escapes `$1 ... $2` pairs
 * before parsing, code fences included, so the clipboard must carry the shell
 * command the author wrote rather than the backslashes the escape inserted.
 *
 * Note this writes to the machine's real clipboard.
 */
test('code block copy button writes the code to the native clipboard', async () => {
  const sessionId = await createTestSession(page, workspacePath, {
    title: 'Code Copy Test',
  });

  const multiLineCode = "awk '{print $1, $2}' input.txt\necho done";
  const singleLineCode = 'npm run build';

  await insertAssistantText(page, sessionId, [
    'Here is the script:',
    '',
    '```bash',
    multiLineCode,
    '```',
    '',
    'And the build step:',
    '',
    '```bash',
    singleLineCode,
    '```',
  ].join('\n'));

  await page.waitForTimeout(1000);

  const sessionItem = page.locator(`#session-list-item-${sessionId}`);
  await expect(sessionItem).toBeVisible({ timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });
  await sessionItem.click();
  await page.waitForTimeout(1000);

  const assistantMessage = page.locator('.rich-transcript-message.assistant');
  await expect(assistantMessage).toBeVisible({ timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });

  const readClipboard = () => electronApp.evaluate(({ clipboard }) => clipboard.readText());
  // Overwriting first is the point: without it a clipboard left over from
  // anything else on the machine could pass for a successful copy.
  const seedClipboard = (text: string) =>
    electronApp.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);

  await seedClipboard('clipboard-not-written');
  await assistantMessage.locator('.overflow-wrapper .code-copy-button').click();
  await expect
    .poll(readClipboard, { timeout: TEST_TIMEOUTS.SAVE_OPERATION })
    .toBe(multiLineCode);

  // Single-line blocks render through a different wrapper.
  await seedClipboard('clipboard-not-written');
  await assistantMessage.locator('.code-block-compact .code-copy-button').click();
  await expect
    .poll(readClipboard, { timeout: TEST_TIMEOUTS.SAVE_OPERATION })
    .toBe(singleLineCode);
});

test('optimistic user message persists after debounced reload', async () => {
  // Create a fresh session so we don't pick up messages from the previous test
  const freshSessionId = await createTestSession(page, workspacePath, {
    title: 'Persistence Test',
  });
  await page.waitForTimeout(500);
  const freshSession = page.locator(`#session-list-item-${freshSessionId}`);
  await expect(freshSession).toBeVisible({ timeout: TEST_TIMEOUTS.MEDIUM });
  await freshSession.click();
  await page.waitForTimeout(500);

  // Submit a message (will fail without API key, but optimistic bubble should persist)
  const chatInput = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentChatInput);
  await expect(chatInput).toBeVisible({ timeout: 5000 });
  await chatInput.fill('Hello, this is a persistence test');
  await page.waitForTimeout(100);
  await chatInput.press('Enter');

  // Wait for the user message bubble to appear
  const userBubble = page.locator('.rich-transcript-message.user');
  await expect(userBubble.first()).toBeVisible({ timeout: 5000 });
  await expect(userBubble.first()).toContainText('Hello, this is a persistence test');

  // Wait 3 seconds (through debounce reload cycle)
  await page.waitForTimeout(3000);

  // Verify bubble persists
  await expect(userBubble.first()).toBeVisible();
  await expect(userBubble.first()).toContainText('Hello, this is a persistence test');
});
