'use strict';

const fs = require('fs');
const path = require('path');

const DOM_SNAPSHOT_LIMIT = 15000;
const TEST_SOURCE_LIMIT = 5000;
const OLLAMA_URL = 'http://localhost:11434/v1/chat/completions';
const OLLAMA_MODEL = 'llama3.1:8b';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'qwen-2.5-coder-32b';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

const VALID_SOURCE_TAGS = new Set([
  'primary_decode_base',
  'related_decode_base',
  'contracts',
  'dom_snapshot',
  'test_source',
  'error_message',
  'pre_detected_conflicts',
  'index_warnings',
]);

const VALID_LOCATOR_PREFIXES = [
  'getByRole(',
  'getByText(',
  'getByLabel(',
  'getByPlaceholder(',
  'getByAltText(',
  'getByTitle(',
  'getByTestId(',
  'locator(',
];

// ── Source preparation ────────────────────────────────────────────────────────

function trimSnapshot(html) {
  if (!html) return '(no snapshot available)';
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const content = bodyMatch ? bodyMatch[1] : html;
  return content.length <= DOM_SNAPSHOT_LIMIT
    ? content
    : content.slice(0, DOM_SNAPSHOT_LIMIT) + '\n... [truncated]';
}

function readContractFiles(contractPaths) {
  const results = [];
  for (const p of contractPaths || []) {
    try {
      results.push({ path: p, content: fs.readFileSync(p, 'utf-8') });
    } catch {
      // skip unreadable contract
    }
  }
  return results;
}

function readTestSource(testFile) {
  // testFile may be relative (e.g. "tests/cart.spec.js") — resolve from repo root
  const absPath = path.isAbsolute(testFile)
    ? testFile
    : path.join(__dirname, '..', testFile);
  try {
    const content = fs.readFileSync(absPath, 'utf-8');
    return content.length <= TEST_SOURCE_LIMIT
      ? content
      : content.slice(0, TEST_SOURCE_LIMIT) + '\n... [truncated]';
  } catch {
    return null;
  }
}

// ── Prompt builder ─────────────────────────────────────────────────────────────

function buildPrompt({
  testTitle,
  testFile,
  errorMessage,
  trimmedDOM,
  contracts,
  testSource,
  primaryContent,
  relatedContents,
  conflicts,
  indexWarnings,
}) {
  const parts = [];

  parts.push(`You are a Playwright test healing assistant. A UI test failed because a selector no longer matches any element on the page.

## CRITICAL RULE — CITATION REQUIRED
Every factual claim you make in your reasoning and citations array MUST reference one of the sources below.

Allowed source tags (use ONLY these exact strings):
  primary_decode_base    — the primary decode-base domain entry for this feature
  related_decode_base    — a related decode-base entry
  contracts              — the healing contract YAML file
  dom_snapshot           — the page DOM at the exact moment of failure
  test_source            — the Playwright test file source code
  error_message          — the Playwright error output
  pre_detected_conflicts — structural conflicts pre-detected between decode-base entries
  index_warnings         — staleness warnings from the decode-base index

If you cannot cite a source for a claim, do NOT make that claim.
If no source in the DOM snapshot supports the selector you want to suggest, set confidence to 0.`);

  parts.push(`## Error message [source: error_message]
Test title: "${testTitle}"
Test file: ${testFile}
${errorMessage}`);

  parts.push(`## DOM snapshot at failure time [source: dom_snapshot]
${trimmedDOM}`);

  if (testSource) {
    parts.push(`## Test file source [source: test_source]
File: ${testFile}
${testSource}`);
  }

  if (contracts.length > 0) {
    const contractText = contracts
      .map(c => `File: ${path.basename(c.path)}\n${c.content}`)
      .join('\n\n---\n\n');
    parts.push(`## Healing contracts [source: contracts]
${contractText}`);
  }

  if (primaryContent) {
    parts.push(`## Primary decode-base entry [source: primary_decode_base]
${primaryContent}`);
  }

  for (const rel of relatedContents) {
    parts.push(`## Related decode-base entry [source: related_decode_base]
File: ${path.basename(rel.filePath)}
${rel.content}`);
  }

  if (conflicts.length > 0) {
    const conflictLines = conflicts.map(
      c =>
        `Entries "${c.between[0]}" and "${c.between[1]}" share YAML keys: ${c.shared_keys.join(', ')}`
    );
    parts.push(`## Pre-detected conflicts [source: pre_detected_conflicts]
The following structural overlaps were found between decode-base entries before this prompt was built:
${conflictLines.join('\n')}`);
  }

  if (indexWarnings.length > 0) {
    parts.push(`## Index staleness warnings [source: index_warnings]
${indexWarnings.join('\n')}`);
  }

  // Extract the broken selector name to give the model an explicit focus point
  const brokenNameMatch = errorMessage.match(/name:\s*['"]([^'"]+)['"]/);
  const brokenName = brokenNameMatch ? brokenNameMatch[1] : null;
  const focusHint = brokenName
    ? `FOCUS: The test is failing because the element named "${brokenName}" cannot be found. Your ONLY goal is to find a replacement selector for THAT element. Do NOT suggest selectors for other elements in the test.`
    : '';

  parts.push(`## Your task
${focusHint ? focusHint + '\n' : ''}1. Read the error message [error_message] to identify the broken selector.
2. Search the DOM snapshot [dom_snapshot] for the element using the contract's heal_hint [contracts].
3. If a decode-base entry is available [primary_decode_base], use it to confirm the element's purpose.
4. Suggest a corrected Playwright locator method call.
5. In every sentence of your reasoning, cite which source the fact came from.

## Behavioral rubric
- Element exists in DOM with a different selector: suggest the new selector; cite the exact DOM line.
- Element completely absent from DOM: set confidence=0, routing="escalate"; explain in unable_to_heal_reason.
- Conflicting evidence across sources: cap confidence at 50, routing="human_approve".
- No citation available for a claim: do NOT make the claim.
- NEVER invent a selector that does not appear in the DOM snapshot.

## Selector format requirement
The "selector" field MUST be a Playwright locator method call:
  getByRole('button', { name: 'Add to Cart' })
  getByText('Sign In')
  getByLabel('Email address')
  getByPlaceholder('Enter your email')
  getByTestId('submit-btn')
  locator('#email-input')
CSS selectors (.class, #id) are REJECTED and will cause the entire suggestion to be discarded.

## Response — JSON ONLY, no markdown fences, no text outside the JSON
{
  "selector": "<Playwright locator method call, or null if cannot heal>",
  "selector_strategy": "<one sentence: what you looked for and why>",
  "confidence": <integer 0-100>,
  "routing": "<auto_patch | human_approve | escalate>",
  "reasoning": "<two to three sentences; cite a source for every factual claim>",
  "citations": [
    { "claim": "<the specific fact>", "source": "<one of the 8 source tags>", "location": "<section header or line excerpt>" }
  ],
  "conflicts": ["<conflicting evidence found — empty array if none>"],
  "evidence_gaps": ["<what you needed but could not find in any source — empty array if none>"],
  "unable_to_heal_reason": <null or string explaining why healing is not possible>
}`);

  return parts.join('\n\n');
}

// ── Post-Claude validation ────────────────────────────────────────────────────

function extractSectionHeaders(markdownContent) {
  const headers = new Set();
  for (const line of (markdownContent || '').split('\n')) {
    const m = line.match(/^#{1,4}\s+(.+)/);
    if (m) headers.add(m[1].trim());
  }
  return headers;
}

function validateAndCap(result, loaderResult) {
  let confidence = typeof result.confidence === 'number' ? result.confidence : 0;
  let routing = result.routing || 'escalate';

  // 1. Unknown citation source tags → confidence 0
  const badTags = (result.citations || [])
    .map(c => c.source)
    .filter(s => !VALID_SOURCE_TAGS.has(s));
  if (badTags.length > 0) {
    console.warn(`[analyze] Unknown citation tags: ${badTags.join(', ')} — forcing confidence to 0`);
    confidence = 0;
  }

  // 2. No citations at all → confidence 0
  if (!result.citations || result.citations.length === 0) {
    console.warn('[analyze] No citations provided — forcing confidence to 0');
    confidence = 0;
  }

  // 3. Verify decode-base section headers are real (warn only — advisory)
  const allDecodeBaseContent = [
    loaderResult?.primary?.content,
    ...(loaderResult?.related || []).map(r => r.content),
  ].filter(Boolean);
  const allHeaders = new Set();
  for (const c of allDecodeBaseContent) {
    for (const h of extractSectionHeaders(c)) allHeaders.add(h);
  }
  const decodeBaseSources = new Set(['primary_decode_base', 'related_decode_base']);
  for (const citation of result.citations || []) {
    if (!decodeBaseSources.has(citation.source)) continue;
    const headerMatch = (citation.location || '').match(/^##\s+(.+)/);
    if (headerMatch && !allHeaders.has(headerMatch[1].trim())) {
      console.warn(
        `[analyze] Cited section "${citation.location}" not found in loaded decode-base — may be hallucinated`
      );
    }
  }

  // 4. Confidence caps — stack via minimum
  if ((loaderResult?.conflicts || []).length > 0) {
    console.warn('[analyze] Pre-detected conflicts — capping confidence at 50');
    confidence = Math.min(confidence, 50);
  }
  if ((loaderResult?.index_warnings || []).length > 0) {
    console.warn('[analyze] Index warnings present — capping confidence at 70');
    confidence = Math.min(confidence, 70);
  }

  // 5. Enforce routing — downgrade only, never upgrade
  //    Permissiveness order (most → least): auto_patch > human_approve > escalate
  if (confidence === 0) {
    routing = 'escalate';
  } else if (confidence < 80 && routing === 'auto_patch') {
    // Downgrade: auto_patch requires confidence >= 80
    console.warn(`[analyze] Confidence ${confidence} is below 80 — downgrading routing from auto_patch to human_approve`);
    routing = 'human_approve';
  }
  // If Claude chose human_approve or escalate, keep it — it is already conservative

  return { ...result, confidence, routing };
}

// ── Locator format guard ───────────────────────────────────────────────────────

function guardLocatorFormat(result) {
  if (!result.selector) return result;
  const valid = VALID_LOCATOR_PREFIXES.some(p => result.selector.startsWith(p));
  if (!valid) {
    console.warn(`[analyze] Rejected non-Playwright selector: ${result.selector}`);
    return {
      ...result,
      selector: null,
      confidence: 0,
      routing: 'escalate',
      reasoning: `Rejected: "${result.selector}" is a CSS selector, not a Playwright locator method call.`,
      unable_to_heal_reason: `Format violation: selector must begin with getByRole(, getByText(, etc.`,
    };
  }
  return result;
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Analyze a triage result and return a grounded heal suggestion.
 *
 * @param {object} triageResult  Output from triage.js: { status, failure, snapshotHTML }
 * @param {object} loaderResult  Output from decodeBaseLoader.load() — optional, defaults to {}
 * @returns {object} { selector, selector_strategy, confidence, routing, reasoning,
 *                     citations, conflicts, evidence_gaps, unable_to_heal_reason }
 */
async function analyze(triageResult, loaderResult = {}) {
  const { failure, snapshotHTML } = triageResult;
  const { testTitle, testFile, errorMessage } = failure;

  const trimmedDOM = trimSnapshot(snapshotHTML);
  const contracts = readContractFiles(loaderResult.related_contract_paths);
  const testSource = readTestSource(testFile);

  const prompt = buildPrompt({
    testTitle,
    testFile,
    errorMessage,
    trimmedDOM,
    contracts,
    testSource,
    primaryContent: loaderResult.primary?.content || null,
    relatedContents: loaderResult.related || [],
    conflicts: loaderResult.conflicts || [],
    indexWarnings: loaderResult.index_warnings || [],
  });

  const sourceCount = [
    loaderResult.primary ? 'primary' : null,
    (loaderResult.related || []).length > 0 ? `${loaderResult.related.length} related` : null,
    contracts.length > 0 ? `${contracts.length} contract(s)` : null,
    (loaderResult.conflicts || []).length > 0 ? `${loaderResult.conflicts.length} conflict(s)` : null,
    (loaderResult.index_warnings || []).length > 0 ? `${loaderResult.index_warnings.length} index warning(s)` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const usingClaude = !!process.env.ANTHROPIC_API_KEY;
  const usingGroq = !usingClaude && (process.env.LLM_PROVIDER === 'groq' || !!process.env.GROQ_API_KEY);
  const modelLabel = usingClaude
    ? `Claude API (${CLAUDE_MODEL})`
    : usingGroq
    ? `Groq (${GROQ_MODEL})`
    : `Ollama (${OLLAMA_MODEL})`;
  console.log(`[analyze] Sending grounded prompt to ${modelLabel}`);
  console.log(`[analyze] Test: "${testTitle}"`);
  console.log(`[analyze] Sources loaded: ${sourceCount || 'contracts only'}`);

  let raw;
  if (usingClaude) {
    // Use Claude API when a key is available (local dev override)
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    raw = message.content[0].text.trim();
  } else if (usingGroq) {
    // Use Groq free tier in CI (OpenAI-compatible, no download, no cost)
    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1024,
        stream: false,
      }),
    });
    if (!response.ok) {
      throw new Error(`Groq API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    raw = data.choices[0].message.content.trim();
  } else {
    // Fall back to local Ollama
    const response = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1024,
        stream: false,
      }),
    });
    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    raw = data.choices[0].message.content.trim();
  }

  // Parse JSON — try raw first, then strip code fences
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim());
      } catch {
        console.error(`[analyze] Response not valid JSON even after fence strip:\n${raw.slice(0, 300)}`);
        return {
          selector: null,
          selector_strategy: null,
          confidence: 0,
          routing: 'escalate',
          reasoning: 'LLM response could not be parsed as JSON.',
          citations: [],
          conflicts: [],
          evidence_gaps: [],
          unable_to_heal_reason: `Parse failure. Raw response: ${raw.slice(0, 200)}`,
        };
      }
    } else {
      console.error(`[analyze] Response not valid JSON:\n${raw.slice(0, 300)}`);
      return {
        selector: null,
        selector_strategy: null,
        confidence: 0,
        routing: 'escalate',
        reasoning: 'LLM response could not be parsed as JSON.',
        citations: [],
        conflicts: [],
        evidence_gaps: [],
        unable_to_heal_reason: `Parse failure. Raw response: ${raw.slice(0, 200)}`,
      };
    }
  }

  // Ensure all required fields exist
  parsed.citations = Array.isArray(parsed.citations) ? parsed.citations : [];
  parsed.conflicts = Array.isArray(parsed.conflicts) ? parsed.conflicts : [];
  parsed.evidence_gaps = Array.isArray(parsed.evidence_gaps) ? parsed.evidence_gaps : [];
  parsed.unable_to_heal_reason = parsed.unable_to_heal_reason || null;
  parsed.selector_strategy = parsed.selector_strategy || null;

  // Guard locator format before validation
  parsed = guardLocatorFormat(parsed);

  // Post-Claude validation: citation checks + confidence caps + routing enforcement
  parsed = validateAndCap(parsed, loaderResult);

  console.log(`[analyze] selector:   ${parsed.selector}`);
  console.log(`[analyze] confidence: ${parsed.confidence}`);
  console.log(`[analyze] routing:    ${parsed.routing}`);
  console.log(`[analyze] citations:  ${parsed.citations.length}`);
  if (parsed.evidence_gaps.length > 0)
    console.log(`[analyze] gaps:       ${parsed.evidence_gaps.join('; ')}`);

  return parsed;
}

module.exports = { analyze };

// ── Standalone demo ─────────────────────────────────────────────────────────────
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '.env') });

  const DEMO_SNAPSHOT = `
    <nav>
      <a href="/login">Sign In</a>
      <a href="/cart">Cart (0)</a>
    </nav>
    <main>
      <h1>Welcome to Veniqa</h1>
    </main>
  `;

  const demoTriageResult = {
    status: 'FAILED_SELECTOR',
    failure: {
      testTitle: 'logged in user can add item to cart',
      testFile: 'tests/cart.spec.js',
      errorMessage: `locator.click: Timeout 8000ms exceeded.\nCall log:\n  - waiting for getByRole('link', { name: 'Login-BROKEN' })`,
      wasFlaky: false,
    },
    snapshotHTML: DEMO_SNAPSHOT,
  };

  (async () => {
    let loaderResult = {};
    try {
      const { load } = require('./decodeBaseLoader');
      loaderResult = load({ test_file: demoTriageResult.failure.testFile });
      console.log(
        `[demo] Loader: primary=${loaderResult.primary?.frontmatter?.id ?? 'none'}, contracts=${loaderResult.related_contract_paths.length}, conflicts=${loaderResult.conflicts.length}, index_warnings=${loaderResult.index_warnings.length}\n`
      );
    } catch (e) {
      console.warn(`[demo] Loader unavailable (${e.message}) — running with empty loader result\n`);
    }

    try {
      const result = await analyze(demoTriageResult, loaderResult);
      console.log('\nFull result:');
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('[analyze] Error:', err.message);
      process.exit(1);
    }
  })();
}
