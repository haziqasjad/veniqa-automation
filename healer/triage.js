const fs = require('fs');
const path = require('path');

const SNAPSHOTS_DIR = path.join(__dirname, 'snapshots');

function findSnapshot(testTitle) {
  if (!fs.existsSync(SNAPSHOTS_DIR)) return null;
  const prefix = testTitle.replace(/\s+/g, '_');
  const files = fs.readdirSync(SNAPSHOTS_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith('.html'))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(SNAPSHOTS_DIR, files[0]) : null;
}

// Extract the name value from a Playwright error message
// e.g. "waiting for getByRole('link', { name: 'Login-BROKEN' })" → "Login-BROKEN"
function extractTargetName(errorMessage) {
  const match = errorMessage.match(/name:\s*['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}

// Strip test-only suffixes to get the real word to search for in the DOM
// "Login-BROKEN" → "login",  "Submit-OLD" → "submit"
function getSearchTerm(targetName) {
  if (!targetName) return null;
  return targetName.split(/[-_]/)[0].toLowerCase();
}

async function triage(failure) {
  const { testTitle, errorMessage, wasFlaky } = failure;
  console.log(`\nTriaging: "${testTitle}"`);

  // Playwright already retried this test — if it passed on any retry, it's flaky
  if (wasFlaky) {
    console.log('  → FLAKY (passed on Playwright retry — do not heal)');
    return { status: 'FLAKY', failure, snapshotHTML: null };
  }

  // Load the DOM snapshot saved at the moment of failure
  const snapshotPath = findSnapshot(testTitle);
  if (!snapshotPath) {
    console.log('  → No snapshot found — defaulting to FAILED_SELECTOR');
    return { status: 'FAILED_SELECTOR', failure, snapshotHTML: null };
  }
  const snapshotHTML = fs.readFileSync(snapshotPath, 'utf-8');
  console.log(`  → Snapshot loaded: ${path.basename(snapshotPath)}`);

  // Extract what Playwright was trying to find
  const targetName = extractTargetName(errorMessage);
  const searchTerm = getSearchTerm(targetName);
  console.log(`  → Target: "${targetName}" → search term: "${searchTerm}"`);

  if (!searchTerm) {
    console.log('  → Cannot extract target — defaulting to FAILED_SELECTOR');
    return { status: 'FAILED_SELECTOR', failure, snapshotHTML };
  }

  // Is any version of this element still in the DOM?
  if (snapshotHTML.toLowerCase().includes(searchTerm)) {
    console.log('  → Element found in DOM (wrong selector) → FAILED_SELECTOR');
    return { status: 'FAILED_SELECTOR', failure, snapshotHTML };
  } else {
    console.log('  → Element NOT in DOM → POSSIBLE_BUG (escalate, do not heal)');
    return { status: 'POSSIBLE_BUG', failure, snapshotHTML };
  }
}

module.exports = { triage };

// Standalone demo
if (require.main === module) {
  const { detectFailures } = require('./detect.js');
  const failures = detectFailures();
  if (failures.length === 0) {
    console.log('No failures in results.json — run a failing test first.');
    process.exit(0);
  }
  (async () => {
    for (const f of failures) {
      const result = await triage(f);
      console.log('  → Final status:', result.status);
    }
  })();
}
