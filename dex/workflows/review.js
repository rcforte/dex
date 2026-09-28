export const meta = {
  name: 'dex-review',
  description: 'Independently review a Dex feature diff from several angles and consolidate the findings',
  phases: [
    { title: 'Scope', detail: 'summarize the diff and pick what each dimension must examine' },
    { title: 'Review', detail: 'one isolated reviewer per dimension' },
    { title: 'Consolidate', detail: 'deduplicate, check evidence, drop trivia, rank by severity' },
    { title: 'Report', detail: 'write 08-review.md' },
  ],
}

/*
 * Dex AI review.
 *
 * Unlike research, review is SUPPOSED to know what was intended: checking the
 * code against the approved design is most of the value. What it must never do is
 * record an approval. This workflow returns findings and a conclusion; a human
 * still reads the diff and runs /dex:approve code.
 *
 * Dimensions are chosen by the caller from the shape of the change. Running every
 * category on every change produces noise, and noise gets skimmed.
 */

const input = args || {}
const slug = input.slug || 'unknown-feature'
const base = input.base || ''
const worktree = input.worktree || '.'
const artifactRoot = input.artifactRoot || 'docs/dex'
const stateRoot = input.stateRoot || '.dex'
const reviewPath = input.reviewPath || `${artifactRoot}/${slug}/08-review.md`
const intentPath = `${artifactRoot}/${slug}/01-intent.md`
const designPath = `${artifactRoot}/${slug}/04-design.md`
const structurePath = `${artifactRoot}/${slug}/05-structure.md`
const verification = input.verification || null

const DEFAULT_DIMENSIONS = ['correctness', 'design-conformance', 'error-handling', 'test-adequacy']
const requested = Array.isArray(input.dimensions) && input.dimensions.length ? input.dimensions : DEFAULT_DIMENSIONS
const dimensions = requested.slice(0, 9)

const DIMENSION_BRIEF = {
  correctness:
    'Does the code do what it claims for every input it will actually receive? Look for off-by-one errors, wrong conditionals, unhandled null or empty cases, incorrect arithmetic or rounding, wrong ordering, and state that can be observed mid-update.',
  'design-conformance':
    'Does the diff implement the approved design and structure? Name every divergence: a component that took on a responsibility the design gave elsewhere, a boundary crossed, an interface that differs from the agreed shape, a checkpoint implemented more deeply or shallowly than agreed.',
  regressions:
    'What existing behavior could this break? Examine every caller of every changed signature, changed default values, altered ordering or timing, and behavior that existing tests assert but the change alters.',
  security:
    'Authentication and authorization checks and where they execute relative to persistence; injection through query construction, templating, or deserialization; secrets in code, logs, or error messages; unvalidated input crossing a trust boundary; access-control decisions made from client-supplied data.',
  'error-handling':
    'What happens on every failure path? Swallowed exceptions, errors logged and then ignored, partial writes left behind, retries without limits or backoff, error messages that leak internals, and failures that surface to the caller as success.',
  'concurrency-transactions':
    'Transaction boundaries and what is inside versus outside them; work that must be atomic but is not; lock ordering; shared mutable state across threads or requests; idempotency of retried operations; events published before the transaction commits.',
  'test-adequacy':
    'What do the tests actually pin down, and what do they leave unprotected? Look for tests that assert the implementation rather than the behavior, missing failure-path tests, missing boundary cases, and new code paths with no test at all.',
  'architecture-boundaries':
    'Does the change respect the layering this repository actually uses? Look for a domain object importing infrastructure, a controller reaching past the application layer, business rules placed in a mapper or a DTO, and new dependencies pointing the wrong direction.',
  'backward-compatibility':
    'Existing callers, persisted data, and in-flight messages. Look for changed response shapes, removed or renamed fields, narrowed types, new required parameters, schema changes without a migration path, and enum values old consumers cannot interpret.',
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['dimension', 'findings'],
  additionalProperties: false,
  properties: {
    dimension: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'file', 'claim', 'evidence', 'failureScenario', 'impact', 'recommendation', 'confidence'],
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          symbol: { type: 'string' },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          failureScenario: { type: 'string' },
          impact: { type: 'string' },
          recommendation: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    designConformance: {
      type: 'object',
      additionalProperties: false,
      properties: { conforms: { type: 'boolean' }, divergences: { type: 'array', items: { type: 'string' } } },
    },
    notes: { type: 'string' },
  },
}

const CONSOLIDATED_SCHEMA = {
  type: 'object',
  required: ['findings', 'conclusion', 'blockerCount'],
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'file', 'claim', 'evidence', 'impact', 'recommendation', 'confidence', 'dimensions'],
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          symbol: { type: 'string' },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          failureScenario: { type: 'string' },
          impact: { type: 'string' },
          recommendation: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          dimensions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    dropped: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'reason'],
        additionalProperties: false,
        properties: { claim: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    unverifiedConcerns: { type: 'array', items: { type: 'string' } },
    designConformance: {
      type: 'object',
      additionalProperties: false,
      properties: { conforms: { type: 'boolean' }, divergences: { type: 'array', items: { type: 'string' } } },
    },
    testAssessment: { type: 'string' },
    conclusion: { type: 'string', enum: ['PASS', 'REMEDIATION REQUIRED'] },
    blockerCount: { type: 'integer' },
    highCount: { type: 'integer' },
  },
}

const diffCommands = [
  `git -C ${worktree} --no-pager diff --stat ${base}`.trim(),
  `git -C ${worktree} --no-pager diff ${base}`.trim(),
  `git -C ${worktree} status --porcelain`,
].join('\n  ')

// --- Phase 1: scope ---------------------------------------------------------

phase('Scope')

const SCOPE_SCHEMA = {
  type: 'object',
  required: ['summary', 'changedFiles'],
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    newFiles: { type: 'array', items: { type: 'string' } },
    sensitiveAreas: { type: 'array', items: { type: 'string' } },
  },
}

const scope = await agent(
  [
    `Summarize the production change under review for Dex feature "${slug}".`,
    '',
    'Inspect it with:',
    `  ${diffCommands}`,
    '',
    `Ignore changes under ${artifactRoot}/ and ${stateRoot}/ — those are Dex's own documents, not production code.`,
    '',
    'Return a short factual summary of what changed, the list of changed and new files,',
    'and which of these sensitive areas the change touches: public API or boundary,',
    'database schema or migration, authorization or security, transactions or',
    'concurrency, configuration or deployment, tests.',
    '',
    'Describe only what the diff does. Do not evaluate it — that is the reviewers’ job.',
    'Read-only inspection only: do not modify the repository.',
  ].join('\n'),
  { label: 'scope:diff', phase: 'Scope', schema: SCOPE_SCHEMA }
)

if (!scope) {
  log('Could not scope the diff. Aborting review rather than reviewing an unknown change.')
  return { ok: false, slug, reason: 'diff could not be scoped' }
}

log(`Reviewing ${(scope.changedFiles || []).length} changed and ${(scope.newFiles || []).length} new file(s) across ${dimensions.length} dimension(s).`)

// --- Phase 2: independent reviews ------------------------------------------
//
// parallel, not pipeline: consolidation genuinely needs every dimension's
// findings at once in order to deduplicate across them.

const sharedContext = [
  `Dex feature: ${slug}`,
  '',
  'Read these for what was intended:',
  `  intent:    ${intentPath}`,
  `  design:    ${designPath}   (approved by a human)`,
  `  structure: ${structurePath} (approved by a human)`,
  '',
  'Inspect the change with:',
  `  ${diffCommands}`,
  '',
  `Ignore changes under ${artifactRoot}/ and ${stateRoot}/.`,
  '',
  'What the change does, for orientation:',
  scope.summary || '(no summary available)',
  '',
  verification
    ? `Deterministic verification already ran and reported: ${JSON.stringify(verification)}`
    : 'Deterministic verification results were not supplied.',
].join('\n')

const REVIEWER_RULES = [
  'Method:',
  '',
  '1. Read the diff, then read the surrounding code. A diff read in isolation hides the',
  '   bug that lives in the function it calls.',
  '2. Check the code against the design that was approved, not against the design you',
  '   would have chosen.',
  '3. For each candidate problem, construct the concrete failure: which input, which',
  '   state, which sequence, and what goes wrong. If you cannot construct one, it is not',
  '   a finding.',
  '4. Check what is missing, not only what is wrong. An unhandled failure path, an absent',
  '   authorization check, and an untested branch are all findings.',
  '',
  'Severity: BLOCKER will cause incorrect behavior, data loss, a security hole, or an',
  'incident. HIGH is likely to cause a defect or leaves significant risk unhandled.',
  'MEDIUM is a real problem with limited blast radius. LOW is genuine but minor.',
  '',
  'Not findings: formatting, naming preference, import order, comment style, "consider',
  'extracting this" with no defect behind it, a rewrite in your preferred idiom when the',
  'code matches the repository’s conventions, or speculation you could not ground in the code.',
  '',
  'If your dimension yields nothing, return zero findings. An honest empty report is a',
  'useful result; padding it with trivia buries the real findings someone else found.',
  '',
  'You may run read-only commands and the existing test suite. Do not modify the',
  'repository, do not commit, do not install anything.',
  '',
  'You are not approving this code. A human reads it and owns it. A false alarm costs',
  'that person real time.',
].join('\n')

const reviews = await parallel(
  dimensions.map((dimension) => () =>
    agent(
      [
        `Review this production change along ONE dimension: ${dimension}.`,
        '',
        DIMENSION_BRIEF[dimension] || `Examine the change specifically for problems of the kind described by "${dimension}".`,
        '',
        'Stay on your dimension. Another reviewer covers each of the others:',
        dimensions.filter((d) => d !== dimension).join(', ') || '(none)',
        '',
        sharedContext,
        '',
        REVIEWER_RULES,
      ].join('\n'),
      { label: `review:${dimension}`, phase: 'Review', schema: FINDINGS_SCHEMA }
    )
  )
)

const ok = reviews.filter(Boolean)
const failedDimensions = dimensions.filter((d, i) => !reviews[i])
if (failedDimensions.length) {
  log(`${failedDimensions.length} dimension(s) returned no result and are NOT covered: ${failedDimensions.join(', ')}`)
}

const rawFindings = ok.flatMap((r) => (r.findings || []).map((f) => ({ ...f, dimension: r.dimension || 'unknown' })))
log(`${rawFindings.length} raw finding(s) from ${ok.length}/${dimensions.length} dimension(s).`)

// --- Phase 3: consolidation ------------------------------------------------

phase('Consolidate')

const consolidated = await agent(
  [
    'Consolidate these independent review findings into one ranked list.',
    '',
    'Raw findings:',
    JSON.stringify(rawFindings, null, 2),
    '',
    'Design conformance reports from each reviewer:',
    JSON.stringify(ok.map((r) => ({ dimension: r.dimension, designConformance: r.designConformance || null })), null, 2),
    '',
    sharedContext,
    '',
    'Do all of the following:',
    '',
    '1. Merge duplicates. Several reviewers finding the same defect from different angles',
    '   is one finding; record every dimension that found it, and keep the clearest',
    '   description and the highest severity assigned.',
    '2. Check each finding’s evidence against the actual code. Open the cited file. A',
    '   finding whose evidence does not hold does not belong in the report — move it to',
    '   unverifiedConcerns, or drop it and record why in `dropped`.',
    '3. Remove style trivia, naming preference, and any recommendation with no defect',
    '   behind it. Record what you dropped and why.',
    '4. Re-rank by severity, then by confidence. Correct a severity that does not match',
    '   the failure scenario: a defect nobody can trigger is not a BLOCKER, and silent',
    '   data corruption is not a MEDIUM.',
    '5. Assess the tests: what they actually pin down, and what they leave unprotected.',
    '',
    'Conclusion is REMEDIATION REQUIRED when any BLOCKER survives, otherwise PASS.',
    'blockerCount must equal the number of BLOCKER findings you return.',
    '',
    failedDimensions.length
      ? `These dimensions returned no result and must be listed in unverifiedConcerns as not covered: ${failedDimensions.join(', ')}`
      : 'Every requested dimension returned a result.',
    '',
    'Do not add findings of your own that no reviewer raised and you cannot evidence.',
    'Do not modify the repository.',
  ].join('\n'),
  { label: 'consolidate:findings', phase: 'Consolidate', schema: CONSOLIDATED_SCHEMA }
)

if (!consolidated) {
  log('Consolidation failed. Returning raw findings so nothing is silently lost.')
  return {
    ok: false,
    slug,
    reason: 'consolidation agent returned no result',
    rawFindings,
    dimensionsNotCovered: failedDimensions,
  }
}

const finalFindings = consolidated.findings || []
const blockers = finalFindings.filter((f) => f.severity === 'BLOCKER')
const highs = finalFindings.filter((f) => f.severity === 'HIGH')
const mediums = finalFindings.filter((f) => f.severity === 'MEDIUM')
const lows = finalFindings.filter((f) => f.severity === 'LOW')

// The conclusion is derived here, not taken on trust: a report that lists a
// BLOCKER and concludes PASS is the one outcome this workflow must never produce.
const conclusion = blockers.length > 0 ? 'REMEDIATION REQUIRED' : consolidated.conclusion || 'PASS'

// --- Phase 4: report -------------------------------------------------------

phase('Report')

await agent(
  [
    `Write the AI review report to ${reviewPath}.`,
    '',
    'Section order: Scope, Verification Evidence, Findings (BLOCKER, HIGH, MEDIUM, LOW),',
    'Design Conformance, Test Assessment, Unverified Concerns, AI Review Conclusion.',
    '',
    'The report must open with this line, on its own, in bold:',
    '**AI REVIEW DOES NOT REPLACE HUMAN CODE REVIEW.**',
    '',
    'followed by: this report is supplemental evidence, it records no approval, and a',
    'human must read the production diff and run `/dex:approve code ' + slug + '`.',
    '',
    'Scope section: what was reviewed, the base, which dimensions ran and which did not.',
    failedDimensions.length ? `Dimensions NOT covered: ${failedDimensions.join(', ')}` : 'All requested dimensions ran.',
    `Dimensions run: ${dimensions.join(', ')}`,
    `Base: ${base || '(none recorded)'}`,
    '',
    verification ? `Verification evidence to tabulate: ${JSON.stringify(verification)}` : 'No verification evidence was supplied; say so.',
    '',
    'Consolidated findings to write up:',
    JSON.stringify(consolidated, null, 2),
    '',
    `The conclusion is: ${conclusion}`,
    '',
    'Each finding gets: severity, file, line or symbol, claim, evidence, impact,',
    'recommended correction, confidence. Write a severity heading even when it is empty —',
    'write "None." under it.',
    '',
    'Unverified Concerns holds anything that could not be substantiated from repository',
    'evidence, so it is neither lost nor trusted.',
    '',
    'Write the report and nothing else. Do not modify any source file.',
    'Return a one-line confirmation.',
  ].join('\n'),
  { label: 'write:review-report', phase: 'Report' }
)

return {
  ok: true,
  slug,
  artifact: reviewPath,
  conclusion,
  counts: {
    blocker: blockers.length,
    high: highs.length,
    medium: mediums.length,
    low: lows.length,
  },
  dimensionsRun: dimensions.filter((d) => !failedDimensions.includes(d)),
  dimensionsNotCovered: failedDimensions,
  dropped: (consolidated.dropped || []).length,
  humanReviewStillRequired: true,
  recordCommand:
    conclusion === 'PASS'
      ? `node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" record-review ${slug} pass --blockers 0`
      : `node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" record-review ${slug} remediation-required --blockers ${blockers.length} --high ${highs.length}`,
}
