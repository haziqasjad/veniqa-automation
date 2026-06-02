const fs = require('fs');
const path = require('path');

const RESULTS_FILE = path.join(__dirname, 'results.json');

function detectFailures() {
  if (!fs.existsSync(RESULTS_FILE)) {
    console.log('No results.json found. Run your Playwright tests first.');
    return [];
  }

  const raw = fs.readFileSync(RESULTS_FILE, 'utf-8');
  const report = JSON.parse(raw);
  const failures = [];

  for (const suite of report.suites) {
    for (const spec of suite.specs) {
      // Flatten all retry attempts for this test into one list
      const allResults = spec.tests.flatMap(t => t.results);
      const failedResults = allResults.filter(r => r.status !== 'passed');
      const passedResults = allResults.filter(r => r.status === 'passed');

      // Nothing failed — skip
      if (failedResults.length === 0) continue;

      failures.push({
        testTitle: spec.title,
        testFile: suite.file,
        errorMessage: failedResults[0].error
          ? failedResults[0].error.message
          : 'Unknown error',
        // wasFlaky: true means it eventually passed on a retry — don't heal it
        wasFlaky: passedResults.length > 0,
      });
    }
  }

  return failures;
}

module.exports = { detectFailures };
