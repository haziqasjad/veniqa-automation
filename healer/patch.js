const fs = require('fs');
const path = require('path');

const TESTS_DIR = path.join(__dirname, '..', 'tests');

// Finds the character range [start, end) of a specific test() block by title.
// Skips past '=>' before counting braces so parameter destructuring like
// async ({ page }) doesn't fool the counter into thinking the test ended early.
function findTestScope(source, testTitle) {
  const escaped = testTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`test\\((['"\`])${escaped}\\1`);
  const match = pattern.exec(source);
  if (!match) return null;

  let i = match.index + match[0].length;

  // Skip forward to '=>' — the function body always starts after it
  while (i < source.length - 1) {
    if (source[i] === '=' && source[i + 1] === '>') {
      i += 2;
      break;
    }
    i++;
  }

  // Skip whitespace/newlines to the opening '{' of the function body
  while (i < source.length && source[i] !== '{') i++;
  if (i >= source.length) return null;

  // Count braces from the function body opening brace
  let depth = 0;
  while (i < source.length) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return { start: match.index, end: i + 1 };
    }
    i++;
  }

  return null;
}

// Replaces oldSelector with newSelector, but ONLY within the failing test's scope.
// testTitle must exactly match the string inside test('...') in the file.
function applyPatch(testFile, testTitle, oldSelector, newSelector) {
  const filePath = path.join(TESTS_DIR, testFile);

  if (!fs.existsSync(filePath)) {
    console.log(`File not found: ${filePath}`);
    return false;
  }

  const original = fs.readFileSync(filePath, 'utf-8');

  if (!original.includes(oldSelector)) {
    console.log(`Selector not found in file: "${oldSelector}"`);
    return false;
  }

  const scope = findTestScope(original, testTitle);
  if (!scope) {
    console.log(`Could not locate test scope for: "${testTitle}"`);
    console.log('Aborting — will not do a blind replace.');
    return false;
  }

  const before = original.slice(0, scope.start);
  const testBody = original.slice(scope.start, scope.end);
  const after = original.slice(scope.end);

  // Warn if the same selector exists outside the failing test — those are untouched
  const outsideCount = (before + after).split(oldSelector).length - 1;
  if (outsideCount > 0) {
    console.log(`Warning: "${oldSelector}" also appears ${outsideCount} time(s) outside the failing test — those are NOT changed.`);
  }

  if (!testBody.includes(oldSelector)) {
    console.log(`Selector "${oldSelector}" not found within scope of: "${testTitle}"`);
    return false;
  }

  const patchedBody = testBody.split(oldSelector).join(newSelector);
  fs.writeFileSync(filePath, before + patchedBody + after, 'utf-8');

  console.log(`Patched: ${testFile} (scoped to: "${testTitle}")`);
  console.log(`  OLD: ${oldSelector}`);
  console.log(`  NEW: ${newSelector}`);
  return true;
}

module.exports = { applyPatch };
