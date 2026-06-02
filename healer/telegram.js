'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const OLLAMA_URL = 'http://localhost:11434/v1/chat/completions';
const OLLAMA_MODEL = 'qwen2.5-coder:7b';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

// In-memory conversation state, keyed by `${runId}:${testTitle}`
const conversations = new Map();

// ── Telegram bot ───────────────────────────────────────────────────────────────

function makeBot() {
  return new TelegramBot(TOKEN);
}

// ── Simple notification (for high-confidence auto-heals) ──────────────────────

async function notify(message) {
  if (!TOKEN || !CHAT_ID) {
    console.warn('[telegram] Token or chat ID not set — skipping notification.');
    return;
  }
  const bot = makeBot();
  await bot.sendMessage(CHAT_ID, message);
  console.log('[telegram] Notification sent.');
}

// ── Context fetchers ──────────────────────────────────────────────────────────

function fetchTestCodeSnippet(testFile, testTitle) {
  const absPath = path.isAbsolute(testFile)
    ? testFile
    : path.join(__dirname, '..', testFile);
  try {
    const content = fs.readFileSync(absPath, 'utf-8');
    const idx = content.indexOf(`test('${testTitle}'`);
    if (idx === -1) return `(test "${testTitle}" not found in ${testFile})`;
    const lines = content.split('\n');
    const startLine = content.slice(0, idx).split('\n').length - 1;
    return lines.slice(startLine, startLine + 40).join('\n');
  } catch {
    return `(could not read ${testFile})`;
  }
}

function fetchDomExcerpt(snapshotPath) {
  if (!snapshotPath || !fs.existsSync(snapshotPath)) return '(no snapshot available)';
  const html = fs.readFileSync(snapshotPath, 'utf-8');
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  return body.slice(0, 3000) + (body.length > 3000 ? '\n...[truncated]' : '');
}

function fetchContractContent(contractPath) {
  if (!contractPath || !fs.existsSync(contractPath)) return '(no contract file found)';
  return fs.readFileSync(contractPath, 'utf-8');
}

// Walks tests/test-results/ to find the Playwright failure PNG for a given test.
// Playwright slugifies the test title when naming result folders.
function fetchScreenshotPath(testFile, testTitle) {
  const testResultsDir = path.join(__dirname, '..', 'tests', 'test-results');
  if (!fs.existsSync(testResultsDir)) return null;

  const slug = testTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  try {
    for (const entry of fs.readdirSync(testResultsDir)) {
      if (entry.toLowerCase().includes(slug.slice(0, 40))) {
        const pngPath = path.join(testResultsDir, entry, 'test-failed-1.png');
        if (fs.existsSync(pngPath)) return pngPath;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// ── LLM conversation router ───────────────────────────────────────────────────
// Interprets each human message and decides what to do next.
// Returns { action: 'answer'|'small_fix'|'create_issue'|'skip', content?, fixDescription? }

async function routeMessage(state, humanMessage) {
  const historyText = state.messages
    .map(m => `${m.role === 'healer' ? 'HEALER' : 'HUMAN'}: ${m.content}`)
    .join('\n\n');

  const prompt = `You are managing a debugging conversation in Telegram between a QA healer bot and a human engineer. A Playwright test failed and the bot needs human help to decide what to do.

FAILURE CONTEXT:
- Test: "${state.testTitle}"
- Error: ${state.errorMessage}
- Triage: ${state.triageStatus}

Your job: Read the human's latest message and return a JSON action.

Return ONLY one of these JSON objects — no markdown, no text outside the JSON:
{ "action": "answer", "content": "<your reply to send back to the human>" }
{ "action": "send_screenshot" }
{ "action": "small_fix", "fixDescription": "<the description the human gave>" }
{ "action": "create_issue" }
{ "action": "skip" }

Rules:
- If the human asks a question: action = "answer". Use the context below to give a short, factual reply.
- If the human asks to see a screenshot, photo, image, or picture of the failure: action = "send_screenshot".
- If the human says something like "small fix: ...", "change X to Y", "try: ...", "apply fix: ...": action = "small_fix", set fixDescription to their exact description.
- If the human says "create issue", "open issue", "log this", "file a bug": action = "create_issue".
- If the human says "skip", "ignore", "no fix", "move on", "not now": action = "skip".

CONTEXT FOR ANSWERING QUESTIONS:

Test code:
${state.testCodeSnippet}

DOM snapshot excerpt:
${state.domExcerpt}

Contract:
${state.contractContent}

Conversation so far:
${historyText}

Human's latest message: ${humanMessage}`;

  const usingClaude = !!process.env.ANTHROPIC_API_KEY;

  try {
    let raw;
    if (usingClaude) {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const message = await client.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      });
      raw = message.content[0].text.trim();
    } else {
      const response = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 512,
          stream: false,
        }),
      });
      if (!response.ok) throw new Error(`Ollama ${response.status}`);
      const data = await response.json();
      raw = data.choices[0].message.content.trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) parsed = JSON.parse(fenceMatch[1].trim());
    }

    if (parsed && parsed.action) return parsed;
    // Unparseable → treat as a conversational answer
    return { action: 'answer', content: raw.slice(0, 500) };
  } catch (err) {
    console.warn(`[telegram] LLM route error: ${err.message}`);
    return { action: 'answer', content: '(I could not process that — please try again or type "skip")' };
  }
}

// ── GitHub issue creator ───────────────────────────────────────────────────────

async function createGitHubIssue(state) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.warn('[telegram] GITHUB_TOKEN or GITHUB_REPO not set — cannot create issue');
    return null;
  }

  const transcript = state.messages
    .map(m => `**${m.role === 'healer' ? 'Healer' : 'Human'}:** ${m.content}`)
    .join('\n\n');

  const body = `## Test failure report

**Test:** ${state.testTitle}
**File:** ${state.testFile}
**Triage:** ${state.triageStatus}

## Error message
\`\`\`
${state.errorMessage}
\`\`\`

## Healing contract
\`\`\`
${state.contractContent}
\`\`\`

## Telegram debugging transcript
${transcript}

---
*Opened by healer-bot via Telegram HITL — Run ID: ${state.runId}*`;

  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      title: `[healer-bot] Test failure: ${state.testTitle}`,
      body,
      labels: ['healer-escalation'],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[telegram] GitHub issue creation failed: ${response.status} — ${text.slice(0, 200)}`);
    return null;
  }

  const issue = await response.json();
  return issue.html_url;
}

// ── Main export: openDebugConversation ────────────────────────────────────────

/**
 * Opens a Telegram debugging conversation for a failure the healer cannot auto-patch.
 *
 * @param {object} params
 * @param {string} params.runId           Unique run identifier
 * @param {object} params.failure         { testTitle, testFile, errorMessage }
 * @param {string} params.triageStatus    e.g. 'FAILED_SELECTOR', 'POSSIBLE_BUG'
 * @param {string} [params.snapshotPath]  Path to HTML snapshot file
 * @param {string} [params.contractPath]  Path to YAML contract file
 * @param {number} [params.confidence]    Claude confidence score
 * @param {string} [params.analyzeReason] Claude reasoning (shown in briefing)
 * @param {number} [params.timeoutMs]     Override timeout (default: 4 hours)
 * @returns {{ decision: string, fixDescription?: string, issueUrl?: string }}
 */
async function openDebugConversation({
  runId,
  failure,
  triageStatus,
  snapshotPath,
  contractPath,
  confidence,
  analyzeReason,
  timeoutMs = 4 * 60 * 60 * 1000,
}) {
  if (!TOKEN || !CHAT_ID) {
    console.warn('[telegram] Token or chat ID not set — returning skip.');
    return { decision: 'skip' };
  }

  const { testTitle, testFile, errorMessage } = failure;
  const conversationId = `${runId}:${testTitle}`;
  const bot = makeBot();

  // Pre-fetch all context that the human might ask about
  const testCodeSnippet = fetchTestCodeSnippet(testFile, testTitle);
  const domExcerpt = fetchDomExcerpt(snapshotPath);
  const contractContent = fetchContractContent(contractPath);
  const screenshotPath = fetchScreenshotPath(testFile, testTitle);

  // Initial briefing — plain text to avoid Markdown parse errors on special chars
  const briefing = [
    `[HEALER] Needs your help`,
    ``,
    `Test:       ${testTitle}`,
    `File:       ${testFile}`,
    `Triage:     ${triageStatus}`,
    `Confidence: ${confidence ?? 'N/A'}`,
    ``,
    `Error:`,
    (errorMessage ?? '(none)').slice(0, 400),
    ``,
    `Claude's reasoning: ${analyzeReason ?? '(none)'}`,
    ``,
    `Ask me anything. I can show you the test code, DOM snapshot, or contract.`,
    `When ready, reply with one of:`,
    `  small fix: [describe the change]`,
    `  create issue`,
    `  skip`,
  ].join('\n');

  await bot.sendMessage(CHAT_ID, briefing);
  console.log(`[telegram] Opened debug conversation: ${conversationId}`);

  const state = {
    runId, testTitle, testFile, errorMessage, triageStatus,
    snapshotPath, screenshotPath, contractPath, contractContent, testCodeSnippet, domExcerpt,
    messages: [{ role: 'healer', content: briefing }],
    startedAt: Date.now(),
  };
  conversations.set(conversationId, state);

  // Poll loop
  const deadline = Date.now() + timeoutMs;
  let offset = 0;
  const sentAt = Math.floor(Date.now() / 1000);

  while (Date.now() < deadline) {
    let updates = [];
    try {
      updates = await bot.getUpdates({ offset, timeout: 30, limit: 10 });
    } catch (err) {
      console.warn(`[telegram] getUpdates error: ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg) continue;
      if (String(msg.chat.id) !== String(CHAT_ID)) continue;
      if (msg.date < sentAt) continue;

      const humanText = msg.text?.trim();
      if (!humanText) continue;

      console.log(`[telegram] Human: ${humanText}`);
      state.messages.push({ role: 'human', content: humanText });

      const routed = await routeMessage(state, humanText);
      console.log(`[telegram] LLM routed to: ${routed.action}`);

      if (routed.action === 'answer') {
        const reply = routed.content || '(no answer generated)';
        await bot.sendMessage(CHAT_ID, reply);
        state.messages.push({ role: 'healer', content: reply });

      } else if (routed.action === 'send_screenshot') {
        if (state.screenshotPath && fs.existsSync(state.screenshotPath)) {
          await bot.sendPhoto(CHAT_ID, state.screenshotPath, { caption: `Failure screenshot for: ${state.testTitle}` });
          state.messages.push({ role: 'healer', content: '[sent screenshot]' });
        } else {
          const msg = state.screenshotPath
            ? `Screenshot file not found at ${state.screenshotPath} — the test may not have run with screenshot capture enabled.`
            : `No screenshot available for this test. Run the tests first to generate failure screenshots.`;
          await bot.sendMessage(CHAT_ID, msg);
          state.messages.push({ role: 'healer', content: msg });
        }

      } else if (routed.action === 'small_fix') {
        const fixMsg = `Got it. Applying fix: "${routed.fixDescription}". I'll report back once the test re-runs.`;
        await bot.sendMessage(CHAT_ID, fixMsg);
        conversations.delete(conversationId);
        return { decision: 'small_fix', fixDescription: routed.fixDescription };

      } else if (routed.action === 'create_issue') {
        await bot.sendMessage(CHAT_ID, 'Opening a GitHub issue with full context...');
        const issueUrl = await createGitHubIssue(state);
        const issueMsg = issueUrl
          ? `GitHub issue created: ${issueUrl}`
          : 'Could not create GitHub issue — check that GITHUB_TOKEN has issues:write access. Logged as SKIPPED.';
        await bot.sendMessage(CHAT_ID, issueMsg);
        conversations.delete(conversationId);
        return { decision: 'create_issue', issueUrl };

      } else if (routed.action === 'skip') {
        await bot.sendMessage(CHAT_ID, `Logged as SKIPPED. Will flag again if the test continues to fail.`);
        conversations.delete(conversationId);
        return { decision: 'skip' };
      }
    }
  }

  // 4-hour timeout reached
  console.log(`[telegram] Conversation timed out: ${conversationId}`);
  await bot.sendMessage(CHAT_ID, `No reply in ${timeoutMs / 3600000}h — logging "${testTitle}" as SKIPPED.`);
  conversations.delete(conversationId);
  return { decision: 'timeout' };
}

module.exports = { notify, openDebugConversation };

// ── Standalone test ────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    console.log('Test 1: notify()');
    await notify('[healer-bot] Telegram v2 test notification — ignore this.');

    console.log('\nTest 2: openDebugConversation() — 60 second timeout');
    console.log('Reply to the Telegram message to test the conversation.');
    const result = await openDebugConversation({
      runId: 'demo-run-001',
      failure: {
        testTitle: 'logged in user can add item to cart',
        testFile: 'tests/cart.spec.js',
        errorMessage: `locator.click: Timeout 8000ms exceeded.\nwaiting for getByRole('link', { name: 'Login-BROKEN' })`,
      },
      triageStatus: 'FAILED_SELECTOR',
      snapshotPath: null,
      contractPath: path.join(__dirname, 'contracts', 'cart-flow.yaml'),
      confidence: 65,
      analyzeReason: 'Found a nav link with text "Sign In" but not "Login" — may be a rename.',
      timeoutMs: 60_000,
    });

    console.log('\nResult:', JSON.stringify(result, null, 2));
  })();
}
