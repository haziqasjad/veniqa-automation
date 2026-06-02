'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'log');
const LEGACY_LOG_FILE = path.join(__dirname, 'healing-log.json');

function sanitizeFilename(str) {
  return str.replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
}

/**
 * Write a full Phase 6 heal event to healer/log/<timestamp>_<test>.json.
 *
 * @param {object} opts
 * @param {string}       opts.runId            - unique ID for this healer run
 * @param {object}       opts.triageResult      - from triage.js
 * @param {object}       [opts.loaderResult={}] - from decodeBaseLoader.js
 * @param {object|null}  [opts.analyzeResult]   - from analyze.js (post-validation)
 * @param {string}       opts.healStatus        - HEALED | REVERTED | ESCALATED |
 *                                                SKIPPED_FLAKY | SKIPPED_BUG | SKIPPED_NO_CONTRACT
 * @param {boolean}      [opts.patchApplied=false]
 * @param {boolean}      [opts.patchReverted=false]
 * @param {string|null}  [opts.resultAfterHeal]  - 'PASS' | 'FAIL' | null
 * @param {string|null}  [opts.preHealCommit]    - git SHA of pre-heal snapshot commit
 * @returns {string} absolute path to the written log file
 */
function logHealEvent({
  runId = null,
  triageResult,
  loaderResult = {},
  analyzeResult = null,
  healStatus,
  patchApplied = false,
  patchReverted = false,
  resultAfterHeal = null,
  preHealCommit = null,
}) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

  const { failure, status: triageStatus } = triageResult;
  const { testFile, testTitle, errorMessage } = failure;
  const ts = new Date().toISOString();
  // ISO timestamps contain colons which are illegal in filenames on some OS
  const slug = sanitizeFilename(testTitle);
  const filename = `${ts.replace(/[:.]/g, '-')}_${slug}.json`;
  const filepath = path.join(LOG_DIR, filename);

  const entry = {
    schema_version: '2.0',
    run_id: runId,
    timestamp: ts,

    test: {
      file: testFile,
      title: testTitle,
    },

    triage: {
      status: triageStatus,
      was_flaky: failure.wasFlaky || false,
      error_message: errorMessage,
    },

    // Loader section: empty fields when no decode-base context was available
    loader: {
      primary_id: loaderResult.primary?.frontmatter?.id ?? null,
      primary_domain: loaderResult.primary?.frontmatter?.domain ?? null,
      primary_status: loaderResult.primary?.frontmatter?.status ?? null,
      related_count: (loaderResult.related || []).length,
      contract_paths: loaderResult.related_contract_paths || [],
      conflicts_count: (loaderResult.conflicts || []).length,
      conflicts: loaderResult.conflicts || [],
      index_warnings_count: (loaderResult.index_warnings || []).length,
      index_warnings: loaderResult.index_warnings || [],
      decode_base_sha: loaderResult.decode_base_sha || null,
    },

    // Full analyze.js v2 response — null when analysis was not run (FLAKY, BUG, NO_CONTRACT)
    analysis: analyzeResult
      ? {
          selector: analyzeResult.selector,
          selector_strategy: analyzeResult.selector_strategy,
          confidence: analyzeResult.confidence,
          routing: analyzeResult.routing,
          reasoning: analyzeResult.reasoning,
          citations: analyzeResult.citations,
          conflicts: analyzeResult.conflicts,
          evidence_gaps: analyzeResult.evidence_gaps,
          unable_to_heal_reason: analyzeResult.unable_to_heal_reason,
        }
      : null,

    patch: {
      applied: patchApplied,
      reverted: patchReverted,
      result_after_heal: resultAfterHeal,
      pre_heal_commit: preHealCommit,
    },

    heal_status: healStatus,
  };

  fs.writeFileSync(filepath, JSON.stringify(entry, null, 2), 'utf-8');
  console.log(`[log] ${healStatus} — "${testTitle}" → ${filename}`);
  return filepath;
}

/**
 * Backwards-compatible wrapper used by the Phase 4 run.js.
 * Continues to write to healing-log.json (single-file format).
 */
function appendLog(entry) {
  const existing = fs.existsSync(LEGACY_LOG_FILE)
    ? JSON.parse(fs.readFileSync(LEGACY_LOG_FILE, 'utf-8'))
    : [];

  existing.push({ timestamp: new Date().toISOString(), ...entry });
  fs.writeFileSync(LEGACY_LOG_FILE, JSON.stringify(existing, null, 2), 'utf-8');
  console.log(`[log] Recorded: ${entry.healStatus} — "${entry.testTitle}"`);
}

module.exports = { logHealEvent, appendLog };

// ── Standalone smoke test ──────────────────────────────────────────────────────
if (require.main === module) {
  const syntheticTriage = {
    status: 'FAILED_SELECTOR',
    failure: {
      testFile: 'tests/cart.spec.js',
      testTitle: 'logged in user can add item to cart',
      errorMessage: "locator.click: Timeout 8000ms exceeded.\nwaiting for getByRole('link', { name: 'Login-BROKEN' })",
      wasFlaky: false,
    },
    snapshotHTML: '<nav><a href="/login">Sign In</a></nav>',
  };

  const syntheticLoader = {
    primary: {
      frontmatter: { id: 'login', domain: 'auth', status: 'stable' },
      content: '## User Flow\nLogin flow...',
      filePath: '/home/asjad/decode-base/domains/auth/login.md',
    },
    related: [],
    related_contract_paths: ['healer/contracts/cart-flow.yaml'],
    conflicts: [],
    index_warnings: [],
    decode_base_sha: 'abc123def456',
  };

  const syntheticAnalysis = {
    selector: "getByRole('link', { name: 'Sign In' })",
    selector_strategy: "Nav link whose text contains 'Sign In', replacing the old 'Login' text.",
    confidence: 88,
    routing: 'auto_patch',
    reasoning: "Found anchor with text 'Sign In' in nav [dom_snapshot]. Contract confirms this is the login nav link [contracts].",
    citations: [
      { claim: "Nav link with text 'Sign In' found", source: 'dom_snapshot', location: '<a href="/login">Sign In</a>' },
      { claim: 'Element is the login nav link', source: 'contracts', location: 'intent field' },
    ],
    conflicts: [],
    evidence_gaps: [],
    unable_to_heal_reason: null,
  };

  const filepath = logHealEvent({
    runId: 'demo-run-001',
    triageResult: syntheticTriage,
    loaderResult: syntheticLoader,
    analyzeResult: syntheticAnalysis,
    healStatus: 'HEALED',
    patchApplied: true,
    patchReverted: false,
    resultAfterHeal: 'PASS',
    preHealCommit: 'deadbeef',
  });

  console.log('\nLog file written to:');
  console.log(filepath);
  console.log('\nContent:');
  console.log(require('fs').readFileSync(filepath, 'utf-8'));
}
