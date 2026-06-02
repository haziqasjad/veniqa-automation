require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { detectFailures } = require('./detect');
const { triage } = require('./triage');
const { analyze } = require('./analyze');
const { applyPatch } = require('./patch');
const { logHealEvent } = require('./log');
const { notify, openDebugConversation } = require('./telegram');
const { load } = require('./decodeBaseLoader');

const TESTS_DIR = path.join(__dirname, '..', 'tests');
const REPO_ROOT = path.join(__dirname, '..');
const SNAPSHOTS_DIR = path.join(__dirname, 'snapshots');
const MASS_FAILURE_THRESHOLD = 5;

// Find the most recent HTML snapshot saved for a given test title.
function findSnapshotPath(testTitle) {
  if (!fs.existsSync(SNAPSHOTS_DIR)) return null;
  const prefix = testTitle.replace(/\s+/g, '_');
  const files = fs.readdirSync(SNAPSHOTS_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith('.html'))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(SNAPSHOTS_DIR, files[0]) : null;
}

// Extract the broken locator expression from a Playwright error message.
// Error: "waiting for getByRole('link', { name: 'Login-BROKEN' })"
// Returns: "getByRole('link', { name: 'Login-BROKEN' })"
// Playwright wraps Call Log lines in ANSI dim codes — strip them first.
function extractBrokenLocator(errorMessage) {
  // Strip full ANSI escape sequences including the leading ESC (\x1b) character.
  // Playwright wraps Call Log lines in \x1b[2m...\x1b[22m — stripping only [Xm
  // leaves the bare ESC character, which makes string comparison with file content fail.
  const clean = errorMessage.replace(/\x1b\[[0-9;]*m/g, '');
  const match = clean.match(/waiting for (.+?)(?:\s*$|\n)/m);
  return match ? match[1].trim() : null;
}

// Run the Playwright suite and return 'PASS' or 'FAIL' based on exit code.
// For verification re-runs, --reporter=list avoids overwriting results.json.
function runPlaywright({ grepTitle, verifyOnly } = {}) {
  const grepArg = grepTitle
    ? ` --grep "${grepTitle.replace(/"/g, '\\"')}"`
    : '';
  const reporterArg = verifyOnly ? ' --reporter=list' : '';
  try {
    execSync(
      `npx playwright test --project=chromium${grepArg}${reporterArg}`,
      {
        cwd: TESTS_DIR,
        stdio: verifyOnly ? 'pipe' : 'inherit',
        env: { ...process.env, PLAYWRIGHT_HTML_OPEN: 'never' },
      }
    );
    return 'PASS';
  } catch {
    return 'FAIL';
  }
}

// Create the pre-heal git snapshot and return its SHA.
// Returns null when there is nothing to commit (file already clean).
function preHealCommit(testFile) {
  try {
    execSync(`git config user.name "healer-bot"`, { cwd: REPO_ROOT, stdio: 'pipe' });
    execSync(`git config user.email "healer-bot@users.noreply.github.com"`, { cwd: REPO_ROOT, stdio: 'pipe' });
    execSync(`git add tests/${testFile}`, { cwd: REPO_ROOT, stdio: 'pipe' });
    execSync(`git commit -m "pre-heal: ${testFile}"`, { cwd: REPO_ROOT, stdio: 'pipe' });
    const sha = execSync('git rev-parse HEAD', { cwd: REPO_ROOT, stdio: 'pipe' }).toString().trim();
    console.log(`[run] Pre-heal commit: ${sha}`);
    return sha;
  } catch {
    // Nothing to commit — HEAD is already the rollback point.
    console.log('[run] No uncommitted changes — HEAD is already the rollback point.');
    return null;
  }
}

// Revert a test file to its last committed state.
function revertPatch(testFile) {
  try {
    execSync(`git checkout -- tests/${testFile}`, { cwd: REPO_ROOT, stdio: 'pipe' });
    console.log(`[run] Reverted: tests/${testFile}`);
  } catch (e) {
    console.warn(`[run] Warning: git revert failed: ${e.message}`);
  }
}

// Write patched=true|false and patched_tests=... to $GITHUB_OUTPUT when in CI.
function emitCIOutputs(healedTests) {
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (!githubOutput) return;
  const patched = healedTests.length > 0;
  fs.appendFileSync(githubOutput, `patched=${patched}\n`);
  fs.appendFileSync(githubOutput, `patched_tests=${healedTests.join(',')}\n`);
  console.log(`[run] GitHub Actions outputs emitted: patched=${patched}`);
}

async function main() {
  const runId = Date.now().toString();

  console.log('='.repeat(60));
  console.log(`HEALER — Starting autonomous healing run (runId: ${runId})`);
  console.log('='.repeat(60));

  // Step 1: Run the full test suite (writes fresh results.json)
  console.log('\n[run] Running Playwright test suite...\n');
  runPlaywright();

  // Step 2: Read results
  const failures = detectFailures();

  if (failures.length === 0) {
    console.log('\nAll tests passing. Nothing to heal.');
    emitCIOutputs([]);
    return;
  }

  // Step 3: Mass-failure guard — too many failures means environment, not selectors
  if (failures.length > MASS_FAILURE_THRESHOLD) {
    console.log(`\n[run] Mass failure: ${failures.length} tests failed (threshold: ${MASS_FAILURE_THRESHOLD}).`);
    console.log('[run] This looks like an environment or config problem. Not healing.');
    await notify(
      `🚨 Mass failure: ${failures.length} tests failed.\nLooks like an environment problem.\nHealer did not attempt any fixes — manual investigation needed.`
    );
    emitCIOutputs([]);
    return;
  }

  console.log(`\n[run] ${failures.length} failure(s) found. Starting triage...\n`);

  const summary = { healed: 0, reverted: 0, flaky: 0, bug: 0, escalated: 0, skipped: 0 };
  const healedTests = [];

  for (const failure of failures) {
    const { testTitle, testFile, errorMessage } = failure;
    console.log('\n' + '-'.repeat(60));
    console.log(`[run] Processing: "${testTitle}"`);

    // Step 4: Triage — classify the failure before doing anything
    const triageResult = await triage(failure);
    const { status } = triageResult;

    // ── FLAKY ─────────────────────────────────────────────────────────────────
    if (status === 'FLAKY') {
      logHealEvent({ runId, triageResult, healStatus: 'SKIPPED_FLAKY' });
      summary.flaky++;
      continue;
    }

    // ── POSSIBLE_BUG ──────────────────────────────────────────────────────────
    if (status === 'POSSIBLE_BUG') {
      console.log('[run] Escalating — element missing from DOM entirely.');
      logHealEvent({ runId, triageResult, healStatus: 'ESCALATED' });
      await notify(
        `🐛 Possible bug — element missing from DOM entirely.\n\nTest: "${testTitle}"\nFile: ${testFile}\n\nHealer cannot fix this — human investigation needed.`
      );
      summary.bug++;
      continue;
    }

    // ── FAILED_SELECTOR ───────────────────────────────────────────────────────

    // Extract the exact broken locator (what to replace in the test file)
    const brokenLocator = extractBrokenLocator(errorMessage);
    if (!brokenLocator) {
      console.log('[run] Cannot extract locator from error message — skipping.');
      logHealEvent({ runId, triageResult, healStatus: 'SKIPPED_NO_CONTRACT' });
      summary.skipped++;
      continue;
    }

    // Step 5: Load decode-base context for this test file
    let loaderResult = {};
    try {
      loaderResult = load({ test_file: testFile });
      console.log(
        `[run] Loader: primary=${loaderResult.primary?.frontmatter?.id ?? '(none)'}, ` +
        `conflicts=${loaderResult.conflicts?.length ?? 0}, ` +
        `index_warnings=${loaderResult.index_warnings?.length ?? 0}`
      );
    } catch (err) {
      console.warn(`[run] decodeBaseLoader unavailable — running without decode-base context: ${err.message}`);
    }

    // Step 6: Analyze — send to LLM for suggested fix (with full context)
    const analyzeResult = await analyze(triageResult, loaderResult);
    if (!analyzeResult) {
      console.log('[run] No contract found or analysis failed — skipping.');
      logHealEvent({ runId, triageResult, loaderResult, healStatus: 'SKIPPED_NO_CONTRACT' });
      summary.skipped++;
      continue;
    }

    const { selector: newSelector, confidence, reasoning, routing } = analyzeResult;
    console.log(`[run] Analyze: routing=${routing}, confidence=${confidence}`);

    const snapshotPath = findSnapshotPath(testTitle);
    const contractPath = (loaderResult.related_contract_paths || [])[0] ?? null;

    // ── ESCALATE ──────────────────────────────────────────────────────────────
    if (routing === 'escalate') {
      console.log('[run] Routing: escalate — LLM cannot suggest a safe fix.');
      logHealEvent({ runId, triageResult, loaderResult, analyzeResult, healStatus: 'ESCALATED' });
      await notify(
        `🚨 Escalated: "${testTitle}"\nFile: ${testFile}\n\nLLM cannot heal safely:\n${analyzeResult.unable_to_heal_reason ?? reasoning}\n\nManual investigation needed.`
      );
      summary.escalated++;
      continue;
    }

    // ── HUMAN_APPROVE ─────────────────────────────────────────────────────────
    if (routing === 'human_approve') {
      console.log(`[run] Routing: human_approve (confidence ${confidence}) — opening Telegram conversation.`);
      const convResult = await openDebugConversation({
        runId,
        failure,
        triageStatus: 'FAILED_SELECTOR',
        snapshotPath,
        contractPath,
        confidence,
        analyzeReason: reasoning,
      });

      if (convResult.decision === 'small_fix') {
        // Human approved — apply the selector Claude already suggested
        console.log(`[run] Human approved. Applying: ${newSelector}`);
        const commitSha = preHealCommit(testFile);
        const patched = applyPatch(testFile, testTitle, brokenLocator, newSelector);
        if (!patched) {
          console.log('[run] Patch could not be applied — skipping.');
          logHealEvent({ runId, triageResult, loaderResult, analyzeResult, healStatus: 'REVERTED', patchApplied: false, preHealCommit: commitSha });
          summary.reverted++;
        } else {
          const verifyResult = runPlaywright({ grepTitle: testTitle, verifyOnly: true });
          if (verifyResult === 'PASS') {
            console.log(`[run] HEALED (human-approved) ✓ "${testTitle}"`);
            logHealEvent({ runId, triageResult, loaderResult, analyzeResult, healStatus: 'HEALED', patchApplied: true, resultAfterHeal: 'PASS', preHealCommit: commitSha });
            await notify(`✅ Healed (human-approved): "${testTitle}"\nFile: ${testFile}\n${brokenLocator}\n→ ${newSelector}`);
            healedTests.push(testFile);
            summary.healed++;
          } else {
            console.log('[run] Patch did not fix the test — reverting.');
            revertPatch(testFile);
            logHealEvent({ runId, triageResult, loaderResult, analyzeResult, healStatus: 'REVERTED', patchApplied: true, patchReverted: true, resultAfterHeal: 'FAIL', preHealCommit: commitSha });
            await notify(`❌ Heal failed after human approval — reverted.\n\nTest: "${testTitle}"\nFile: ${testFile}`);
            summary.reverted++;
          }
        }
      } else if (convResult.decision === 'create_issue') {
        logHealEvent({ runId, triageResult, loaderResult, analyzeResult, healStatus: 'ESCALATED' });
        summary.escalated++;
      } else {
        // skip or timeout
        logHealEvent({ runId, triageResult, loaderResult, analyzeResult, healStatus: 'SKIPPED_LOW_CONFIDENCE' });
        summary.skipped++;
      }
      continue;
    }

    // ── AUTO_PATCH ────────────────────────────────────────────────────────────
    // routing === 'auto_patch'
    console.log(`[run] Routing: auto_patch (confidence ${confidence})`);

    // Pre-heal git snapshot — rollback point before touching any file
    const commitSha = preHealCommit(testFile);

    // Apply the scoped patch
    const patched = applyPatch(testFile, testTitle, brokenLocator, newSelector);
    if (!patched) {
      console.log('[run] Patch could not be applied — selector may not be in this test scope.');
      logHealEvent({ runId, triageResult, loaderResult, analyzeResult, healStatus: 'REVERTED', patchApplied: false, preHealCommit: commitSha });
      summary.reverted++;
      continue;
    }

    // Verify the fix
    console.log(`[run] Verifying patch — re-running: "${testTitle}"`);
    const verifyResult = runPlaywright({ grepTitle: testTitle, verifyOnly: true });

    if (verifyResult === 'PASS') {
      console.log(`[run] HEALED ✓ "${testTitle}"`);
      logHealEvent({ runId, triageResult, loaderResult, analyzeResult, healStatus: 'HEALED', patchApplied: true, resultAfterHeal: 'PASS', preHealCommit: commitSha });
      await notify(`✅ Auto-healed: "${testTitle}"\n\nFile: ${testFile}\nFixed: ${brokenLocator}\n→ ${newSelector}\nConfidence: ${confidence}%\n\nReview when convenient.`);
      healedTests.push(testFile);
      summary.healed++;
    } else {
      console.log('[run] Patch did not fix the test — reverting.');
      revertPatch(testFile);
      logHealEvent({ runId, triageResult, loaderResult, analyzeResult, healStatus: 'REVERTED', patchApplied: true, patchReverted: true, resultAfterHeal: 'FAIL', preHealCommit: commitSha });
      await notify(`❌ Heal failed — patch reverted.\n\nTest: "${testTitle}"\nFile: ${testFile}\nTried: ${newSelector}\nConfidence: ${confidence}%`);
      summary.reverted++;
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('HEALER — Summary');
  console.log('='.repeat(60));
  console.log(`  Healed:                ${summary.healed}`);
  console.log(`  Reverted:              ${summary.reverted}`);
  console.log(`  Flaky (skipped):       ${summary.flaky}`);
  console.log(`  Possible bugs:         ${summary.bug}`);
  console.log(`  Escalated:             ${summary.escalated}`);
  console.log(`  Skipped:               ${summary.skipped}`);
  console.log('='.repeat(60));

  emitCIOutputs(healedTests);
}

main().catch(err => {
  console.error('[run] Fatal error:', err.message);
  process.exit(1);
});
