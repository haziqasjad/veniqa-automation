// Built-in modules for file and path operations
const fs = require('fs');
const path = require('path');

// Folder where snapshot HTML files are saved by snapshot.js
const SNAPSHOTS_DIR = path.join(__dirname, 'snapshots');

// Strip ANSI color codes from Playwright error messages so they print cleanly
function stripAnsi(str) {
  return str.replace(/\[[0-9;]*m/g, '');
}

// Find the most recent snapshot file for a given test name
function findSnapshot(testTitle) {
  // If no snapshots exist yet, return null
  if (!fs.existsSync(SNAPSHOTS_DIR)) return null;

  // Get all .html files in the snapshots folder
  const files = fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith('.html'));

  // Convert the test title to the same underscore format used in the filename
  const prefix = testTitle.replace(/\s+/g, '_');

  // Find files that match this test's name
  const matches = files.filter(f => f.startsWith(prefix));

  // Return the most recently created one (last alphabetically by timestamp)
  return matches.length > 0 ? path.join(SNAPSHOTS_DIR, matches[matches.length - 1]) : null;
}

// Print a readable report for each failure
function generateReport(failures) {
  if (failures.length === 0) {
    console.log('No failures detected. All tests passed!');
    return;
  }

  console.log('='.repeat(60));
  console.log('HEALER REPORT — FAILING TESTS');
  console.log('='.repeat(60));

  for (const failure of failures) {
    console.log('\nTEST:  ', failure.testTitle);
    console.log('FILE:  ', failure.testFile);
    console.log('ERROR: ', stripAnsi(failure.errorMessage));

    // Try to find a DOM snapshot for this test
    const snapshotPath = findSnapshot(failure.testTitle);

    if (snapshotPath) {
      // Read the snapshot HTML and show the first 3000 characters
      const html = fs.readFileSync(snapshotPath, 'utf-8');
      console.log('\n--- DOM SNAPSHOT (first 3000 chars) ---');
      console.log(html.slice(0, 3000));
      console.log('--- END SNAPSHOT ---');
    } else {
      // No snapshot found — remind the user how to generate one
      console.log('\n[No snapshot found for this test.]');
      console.log('Tip: add saveSnapshot(page, testTitle) to your test\'s catch block to capture DOM on failure.');
    }

    // Print a ready-to-paste AI prompt so the user can copy it into Claude/ChatGPT
    console.log('\n--- COPY THIS PROMPT INTO CLAUDE / CHATGPT ---');
    console.log(`
You are a Playwright test automation expert.

A Playwright test has failed. Here are the details:

TEST NAME: ${failure.testTitle}
TEST FILE: ${failure.testFile}
ERROR: ${stripAnsi(failure.errorMessage)}

${snapshotPath ? `Here is the HTML of the page at the moment of failure:\n${fs.readFileSync(snapshotPath, 'utf-8').slice(0, 5000)}` : 'No DOM snapshot available.'}

Based on the error and the HTML above:
1. What was the broken selector trying to find?
2. Why did it fail?
3. What is the exact corrected Playwright locator to fix the test?
`);
    console.log('--- END OF PROMPT ---');
    console.log('\n' + '-'.repeat(60));
  }

  console.log('\nCopy the prompt above into Claude or ChatGPT to get the fix.');
  console.log('Then apply it with: node -e "require(\'./healer/patch\').applyPatch(\'<file>\', \'<old>\', \'<new>\')"');
}

// Export so run.js can call generateReport()
module.exports = { generateReport };
