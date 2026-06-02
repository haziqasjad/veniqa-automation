'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const yaml = require('js-yaml');

// ── helpers ──────────────────────────────────────────────────────────────────

function getDecodeBasePath() {
  const p = process.env.DECODE_BASE_PATH;
  if (!p) throw new Error('DECODE_BASE_PATH is not set in healer/.env');
  if (!fs.existsSync(p)) throw new Error(`DECODE_BASE_PATH does not exist on disk: ${p}`);
  return p;
}

/** Extract YAML frontmatter (the --- block) from a markdown file. */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    return yaml.load(match[1]);
  } catch {
    return null;
  }
}

/** Recursively flatten an object into dotted key paths ("a.b.c"). */
function flattenKeys(obj, prefix = '') {
  const keys = new Set();
  for (const [k, v] of Object.entries(obj)) {
    const dotted = prefix ? `${prefix}.${k}` : k;
    keys.add(dotted);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const sub of flattenKeys(v, dotted)) keys.add(sub);
    }
  }
  return keys;
}

/** Parse every yaml-fenced code block in a markdown file and return all dotted keys. */
function extractYamlKeys(content) {
  const keys = new Set();
  const blocks = content.match(/```yaml\n([\s\S]*?)```/g) || [];
  for (const block of blocks) {
    const raw = block.replace(/^```yaml\n/, '').replace(/\n?```$/, '');
    try {
      const parsed = yaml.load(raw);
      if (parsed && typeof parsed === 'object') {
        for (const k of flattenKeys(parsed)) keys.add(k);
      }
    } catch {
      // ignore malformed blocks
    }
  }
  return keys;
}

/** Read the git HEAD SHA of the decode-base repo (for traceability). */
function getDecodeBaseSHA(decodeBasePath) {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: decodeBasePath,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** Walk domains/**\/*.md and return all file paths. */
function getAllDomainFiles(decodeBasePath) {
  const domainsDir = path.join(decodeBasePath, 'domains');
  if (!fs.existsSync(domainsDir)) return [];
  const results = [];
  for (const domain of fs.readdirSync(domainsDir)) {
    const domainDir = path.join(domainsDir, domain);
    if (!fs.statSync(domainDir).isDirectory()) continue;
    for (const file of fs.readdirSync(domainDir)) {
      if (file.endsWith('.md')) results.push(path.join(domainDir, file));
    }
  }
  return results;
}

function readEntry(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  return { filePath, content, frontmatter: parseFrontmatter(content) };
}

// ── main export ──────────────────────────────────────────────────────────────

/**
 * Load all decode-base context relevant to a failing test file.
 *
 * Reads from disk on every call — no caching — so CI always sees the
 * current state of decode-base checked out alongside the repo.
 *
 * @param {{ test_file: string }} options  e.g. { test_file: 'tests/login.spec.js' }
 * @returns {{
 *   primary: { filePath: string, content: string, frontmatter: object } | null,
 *   related: Array<{ filePath: string, content: string, frontmatter: object }>,
 *   related_contract_paths: string[],
 *   conflicts: Array<{ between: [string, string], shared_keys: string[] }>,
 *   decode_base_sha: string | null,
 *   index_warnings: string[]
 * }}
 */
function load({ test_file }) {
  const decodeBasePath = getDecodeBasePath();

  // "tests/cart.spec.js" → "cart"
  const testStem = path.basename(test_file, '.js').replace(/\.spec$/, '');

  const allEntries = getAllDomainFiles(decodeBasePath).map(readEntry);

  // Primary: the domain file whose filename stem matches the test stem.
  // e.g. "login" matches domains/auth/login.md
  const primaryEntry =
    allEntries.find(e => path.basename(e.filePath, '.md') === testStem) || null;

  // Related: every id listed in primary's `related:` frontmatter field.
  const relatedEntries = [];
  if (primaryEntry?.frontmatter?.related) {
    for (const relatedId of primaryEntry.frontmatter.related) {
      const found = allEntries.find(
        e => e !== primaryEntry && e.frontmatter?.id === relatedId
      );
      if (found) relatedEntries.push(found);
    }
  }

  // Conflicts: keys that appear in both primary's YAML blocks and a related entry's
  // YAML blocks. Shared key names suggest possible inconsistency in API contracts.
  const conflicts = [];
  if (primaryEntry) {
    const primaryKeys = extractYamlKeys(primaryEntry.content);
    for (const rel of relatedEntries) {
      const relKeys = extractYamlKeys(rel.content);
      const shared = [...primaryKeys].filter(k => relKeys.has(k));
      if (shared.length > 0) {
        conflicts.push({
          between: [
            primaryEntry.frontmatter?.id ?? path.basename(primaryEntry.filePath),
            rel.frontmatter?.id ?? path.basename(rel.filePath),
          ],
          shared_keys: shared,
        });
      }
    }
  }

  // Index verification: check that _meta/index.json predictions match frontmatter.
  // Mismatches become index_warnings, which cap Claude's confidence in analyze.js v2.
  const index_warnings = [];
  const indexPath = path.join(decodeBasePath, '_meta', 'index.json');
  if (fs.existsSync(indexPath)) {
    let index;
    try {
      index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    } catch {
      index_warnings.push('Could not parse _meta/index.json');
      index = { entries: [] };
    }
    for (const entry of index.entries || []) {
      const actual = allEntries.find(e => e.frontmatter?.id === entry.id);
      if (!actual) {
        index_warnings.push(
          `Index references id "${entry.id}" but no domain file has that frontmatter id`
        );
        continue;
      }
      if (entry.domain && actual.frontmatter?.domain !== entry.domain) {
        index_warnings.push(
          `Index says domain="${entry.domain}" for "${entry.id}" but frontmatter says domain="${actual.frontmatter?.domain}"`
        );
      }
      if (entry.status && actual.frontmatter?.status !== entry.status) {
        index_warnings.push(
          `Index says status="${entry.status}" for "${entry.id}" but frontmatter says status="${actual.frontmatter?.status}"`
        );
      }
    }
  }

  // Contract paths: healer/contracts/{testStem}-flow.yaml
  // Returns path only — analyze.js is responsible for reading the content.
  const contractsDir = path.join(__dirname, 'contracts');
  const contractPath = path.join(contractsDir, `${testStem}-flow.yaml`);
  const related_contract_paths = fs.existsSync(contractPath) ? [contractPath] : [];

  const decode_base_sha = getDecodeBaseSHA(decodeBasePath);

  return {
    primary: primaryEntry
      ? { filePath: primaryEntry.filePath, content: primaryEntry.content, frontmatter: primaryEntry.frontmatter }
      : null,
    related: relatedEntries.map(e => ({
      filePath: e.filePath,
      content: e.content,
      frontmatter: e.frontmatter,
    })),
    related_contract_paths,
    conflicts,
    decode_base_sha,
    index_warnings,
  };
}

module.exports = { load };

// ── standalone demo ───────────────────────────────────────────────────────────
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '.env') });

  console.log('=== decodeBaseLoader demo ===\n');

  // login.spec.js → should find domains/auth/login.md as primary,
  // auth-registration as a related entry (per login.md's `related:` field)
  const loginResult = load({ test_file: 'tests/login.spec.js' });
  console.log('[tests/login.spec.js]');
  console.log('  primary:               ', loginResult.primary?.frontmatter?.id ?? '(none)');
  console.log('  related:               ', loginResult.related.map(r => r.frontmatter?.id));
  console.log('  related_contract_paths:', loginResult.related_contract_paths);
  console.log('  conflicts (count):     ', loginResult.conflicts.length);
  if (loginResult.conflicts.length > 0) {
    console.log('  conflicts detail:      ', JSON.stringify(loginResult.conflicts, null, 4));
  }
  console.log('  decode_base_sha:       ', loginResult.decode_base_sha);
  console.log('  index_warnings:        ', loginResult.index_warnings);

  console.log('');

  // cart.spec.js → no domains/cart/ folder yet, primary should be null
  const cartResult = load({ test_file: 'tests/cart.spec.js' });
  console.log('[tests/cart.spec.js]');
  console.log('  primary:               ', cartResult.primary?.frontmatter?.id ?? '(none — expected, no cart domain file yet)');
  console.log('  related_contract_paths:', cartResult.related_contract_paths);
  console.log('  decode_base_sha:       ', cartResult.decode_base_sha);
  console.log('  index_warnings:        ', cartResult.index_warnings);
}
