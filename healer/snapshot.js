// Built-in Node.js module for reading and writing files
const fs = require('fs');

// Built-in Node.js module for building file paths that work on any OS
const path = require('path');

// This function captures the page HTML and saves it to a file
// 'page' is the Playwright browser page, 'testName' is the name of the failing test
async function saveSnapshot(page, testName) {
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('snapshot timeout')), 3000)
    );
    const html = await Promise.race([page.content(), timeoutPromise]);
    const timestamp = Date.now();
    const filename = `${testName.replace(/\s+/g, '_')}_${timestamp}.html`;
    const filepath = path.join(__dirname, 'snapshots', filename);
    fs.mkdirSync(path.join(__dirname, 'snapshots'), { recursive: true });
    fs.writeFileSync(filepath, html);
    console.log(`Snapshot saved: ${filepath}`);
    return filepath;
  } catch (e) {
    console.log(`Snapshot skipped: ${e.message}`);
    return null;
  }
}

// Export the function so other scripts (like analyze.js) can use it
module.exports = { saveSnapshot };
