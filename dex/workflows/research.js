export const meta = {
  name: 'dex-research',
  description: 'Run isolated objective codebase research for an approved Dex feature',
  phases: [
    { title: 'Check gate', detail: 'confirm the questions approval is current' },
    { title: 'Parse questions', detail: 'read the approved question list' },
    { title: 'Research', detail: 'one isolated probe per question' },
    { title: 'Verify', detail: 'adversarially check each probe’s cited evidence' },
    { title: 'Synthesize', detail: 'write 03-research.md from verified findings' },
  ],
}

/*
 * Dex research.
 *
 * The point of this workflow is context isolation. Each probe receives ONE
 * research question and nothing else: not the feature request, not the intent
 * artifact, not the design discussion. A probe that knows what someone wants to
 * build starts reporting where the feature should go instead of how the system
 * works today, and that opinion then travels downstream disguised as a finding.
 *
 * Probes and verifiers run as the plugin's own read-only agents (agents/
 * research-probe.md and research-verifier.md: Read, Grep, Glob only), so the
 * isolation does not rest on the prompt alone. The prompts repeat the rules.
 *
 * Paths come in through args. Workflow agents' shells do not have the plugin
 * root variable, so the /dex:research skill resolves the plugin paths and
 * passes them here.
 */

const input = args || {}
const slug = input.slug || 'unknown-feature'
const artifactRoot = input.artifactRoot || 'docs/dex'
const stateRoot = input.stateRoot || '.dex'
const stateScript = input.stateScript || 'state.mjs'
const templatesDir = input.templatesDir || null
const questionsPath = input.questionsPath || `${artifactRoot}/${slug}/02-questions.md`
const researchPath = input.researchPath || `${artifactRoot}/${slug}/03-research.md`
// How many research agents run at once. Every question is researched.
const maxWorkers = Number(input.maxWorkers) > 0 ? Math.min(Number(input.maxWorkers), 24) : 6
const probeAgent = input.probeAgentType || 'dex:research-probe'
const verifierAgent = input.verifierAgentType || 'dex:research-verifier'

const QUESTIONS_SCHEMA = {
  type: 'object',
  required: ['questions'],
  additionalProperties: false,
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'question'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Q1, Q2, ...' },
          question: { type: 'string' },
          category: { type: 'string' },
        },
      },
    },
    humanQuestions: {
      type: 'array',
      description: 'Questions the human added under "Human Notes", verbatim',
      items: {
        type: 'object',
        required: ['question'],
        additionalProperties: false,
        properties: { question: { type: 'string' } },
      },
    },
    humanNotes: { type: 'string', description: 'Anything else under "Human Notes" that changes scope' },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['questionId', 'facts', 'inferences', 'unknowns'],
  additionalProperties: false,
  properties: {
    questionId: { type: 'string' },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['statement', 'evidence'],
        additionalProperties: false,
        properties: {
          statement: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'path:startLine-endLine' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    inferences: {
      type: 'array',
      items: {
        type: 'object',
        required: ['statement'],
        additionalProperties: false,
        properties: { statement: { type: 'string' }, basedOn: { type: 'array', items: { type: 'string' } } },
      },
    },
    unknowns: {
      type: 'array',
      items: {
        type: 'object',
        required: ['statement'],
        additionalProperties: false,
        properties: { statement: { type: 'string' }, wouldBeResolvedBy: { type: 'string' } },
      },
    },
    relatedTests: { type: 'array', items: { type: 'string' } },
    contradictions: { type: 'array', items: { type: 'string' } },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['questionId', 'verdicts'],
  additionalProperties: false,
  properties: {
    questionId: { type: 'string' },
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['statement', 'verdict', 'reason'],
        additionalProperties: false,
        properties: {
          statement: { type: 'string' },
          verdict: { type: 'string', enum: ['VERIFIED', 'PARTIALLY VERIFIED', 'UNVERIFIED', 'CONTRADICTED'] },
          reason: { type: 'string' },
          correctedStatement: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    missedContext: { type: 'array', items: { type: 'string' } },
    overallConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
}

const PROBE_RULES = [
  'You are performing objective brownfield codebase research.',
  '',
  'You have not been told what anyone wants to build, and you must not try to infer it.',
  'If you catch yourself reasoning about what feature this question serves, stop: that',
  'reasoning is out of scope and it contaminates the finding.',
  '',
  'Report:',
  '  1. facts about the system as it exists today',
  '  2. evidence for each fact, as path:startLine-endLine',
  '  3. related tests that pin down the behavior you found',
  '  4. unresolved ambiguity',
  '',
  'Classify every statement. A FACT is directly readable in the repository and must',
  'cite file and line range. An INFERENCE is your reading of the facts and must say',
  'which facts it rests on. An UNKNOWN is something you could not establish.',
  '',
  'Do not propose a feature implementation.',
  'Do not recommend an architecture, a pattern, or a refactor.',
  'Do not say a pattern should be used; say where it exists and where it does not.',
  'Do not modify any file.',
  '',
  `Do not read anything under ${artifactRoot}/** or ${stateRoot}/**. Those folders hold`,
  'planning documents about work that has not been built. They are not the system, and',
  'reading them would tell you what someone wants to build.',
  '',
  'If you did not open the file, it is not a fact. If the repository contains nothing',
  'relevant, return empty facts and an unknown explaining what you searched. An honest',
  'empty result is a successful outcome; a plausible invention is not.',
  '',
  'Keep the result concise.',
].join('\n')

// --- Phase 0: the questions approval must be current ------------------------
//
// The /dex:research skill checks this before invoking the workflow. Checking it
// again here means the gate still holds when the workflow is run directly, which
// it can be. The check runs the deterministic state CLI rather than reasoning
// about the gate.

phase('Check gate')

const GATE_SCHEMA = {
  type: 'object',
  required: ['questionsGateStatus'],
  additionalProperties: false,
  properties: {
    questionsGateStatus: { type: 'string', description: 'the gates.questions.status value, verbatim' },
    featureExists: { type: 'boolean' },
    message: { type: 'string', description: 'the CLI error, when it failed' },
  },
}

const gate = await agent(
  [
    `Run exactly this command and report what it says about the questions gate:`,
    '',
    `  node "${stateScript}" check ${slug}`,
    '',
    'It prints JSON. Return gates.questions.status verbatim — one of APPROVED,',
    'DRAFT, STALE, or MISSING — and whether the feature exists.',
    '',
    'If the command fails, set featureExists to false and put its error in message.',
    '',
    'Run only that command. Do not modify anything. Do not interpret the gate.',
  ].join('\n'),
  { label: 'gate:questions', phase: 'Check gate', schema: GATE_SCHEMA }
)

// Fail closed: an unreadable gate is treated as an unapproved gate.
if (!gate || gate.featureExists === false || gate.questionsGateStatus !== 'APPROVED') {
  const status = gate ? gate.questionsGateStatus || 'UNKNOWN' : 'UNREADABLE'
  log(`Questions gate is ${status}. Research needs an approved, current question list.`)
  return {
    ok: false,
    slug,
    reason:
      status === 'STALE'
        ? `02-questions.md changed after it was approved. Re-approve it: /dex:approve questions ${slug}`
        : status === 'UNREADABLE' || gate?.featureExists === false
          ? `Dex could not read the state for "${slug}". ${gate?.message || 'Check /dex:status.'}`
          : `The research questions are ${status}. Approve them first: /dex:approve questions ${slug}`,
    questionsGateStatus: status,
  }
}

// --- Phase 1: read the approved questions -----------------------------------

phase('Parse questions')

const parsed = await agent(
  [
    `Read the file ${questionsPath} and extract its research questions.`,
    '',
    'Return every numbered question under the "Questions" heading, in document order,',
    'assigning ids Q1, Q2, Q3... Use the nearest preceding subheading as the category.',
    '',
    'Skip headings that have no questions under them. Skip the "Explicitly excluded',
    'from research" section entirely.',
    '',
    'If the human added questions under "Human Notes", return each one in humanQuestions,',
    'verbatim. Return any other scope instruction from Human Notes in humanNotes.',
    '',
    'Do not invent questions. Do not rewrite them. Return exactly what the file says.',
  ].join('\n'),
  { label: 'parse:questions', phase: 'Parse questions', schema: QUESTIONS_SCHEMA }
)

if (!parsed || !parsed.questions || parsed.questions.length === 0) {
  log(`No research questions could be read from ${questionsPath}. Nothing to research.`)
  return {
    ok: false,
    slug,
    reason: `no questions parsed from ${questionsPath}`,
    questionCount: 0,
  }
}

// Every approved question is researched, including the ones the human added.
const humanQuestions = (parsed.humanQuestions || []).map((h, i) => ({
  id: `H${i + 1}`,
  question: h.question,
  category: 'Human Notes',
}))
const questions = [...parsed.questions, ...humanQuestions]
log(`Researching ${questions.length} question(s) in isolated contexts, at most ${maxWorkers} agents at a time.`)

// maxResearchWorkers limits how many agents run at once, not how many questions
// are researched. A small queue enforces it across the probe and verify stages.
let running = 0
const waiting = []
async function withSlot(start) {
  if (running >= maxWorkers) await new Promise((resolve) => waiting.push(resolve))
  running++
  try {
    return await start()
  } finally {
    running--
    const next = waiting.shift()
    if (next) next()
  }
}

// --- Phases 2 and 3: probe, then verify, per question -----------------------
//
// pipeline, not parallel: question Q1's findings can be under verification while
// Q5 is still being researched. No barrier is needed because verification is
// per-question and never references another question's findings.

const researched = await pipeline(
  questions,
  (question) =>
    withSlot(() => agent(
      [
        'Investigate this question in the current repository:',
        '',
        question.question,
        '',
        PROBE_RULES,
      ].join('\n'),
      {
        label: `probe:${question.id}`,
        phase: 'Research',
        schema: FINDINGS_SCHEMA,
        agentType: probeAgent,
      }
    )),
  (findings, question) => {
    if (!findings) return null
    const claims = [...(findings.facts || []), ...(findings.inferences || [])]
    if (claims.length === 0) {
      // Nothing was claimed, so there is nothing to falsify. Spending a verifier
      // here would burn a context to confirm an empty result.
      return { question, findings, verification: null, skippedVerification: 'no claims to verify' }
    }
    return withSlot(() => agent(
      [
        'Check whether the cited repository evidence actually supports these findings.',
        '',
        `Question investigated:`,
        question.question,
        '',
        'Candidate findings:',
        JSON.stringify({ facts: findings.facts, inferences: findings.inferences }, null, 2),
        '',
        'Your job is to try to falsify these claims, not to confirm them. Findings that',
        'survive you become the factual basis for a design decision, so a citation that',
        'does not say what it is claimed to say is the most expensive error possible here.',
        '',
        'For each claim: open the cited file at the cited lines and read them. Ask whether',
        'the code says what the claim says. Ask whether the citation is the real mechanism',
        'or an incidental match in a comment, a test fixture, or dead code. Search for code',
        'elsewhere that contradicts it. Ask whether the claim overreaches.',
        '',
        'Classify each claim exactly one of:',
        '  VERIFIED            the cited evidence supports the claim as stated',
        '  PARTIALLY VERIFIED  true but narrower than stated; give the correct narrower claim',
        '  UNVERIFIED          you could not confirm it from the cited evidence',
        '  CONTRADICTED        repository evidence shows it is wrong; cite what contradicts it',
        '',
        'Do not design a solution. Do not recommend codebase changes. Do not modify any file.',
        'Do not soften a CONTRADICTED verdict to be agreeable.',
      ].join('\n'),
      {
        label: `verify:${question.id}`,
        phase: 'Verify',
        schema: VERDICT_SCHEMA,
        agentType: verifierAgent,
      }
    )).then((verification) => ({ question, findings, verification, skippedVerification: null }))
  }
)

const results = researched.filter(Boolean)
const failedQuestions = questions.filter((q) => !results.some((r) => r.question.id === q.id))

// Tally verdicts. A question whose verifier died counts as unverified, never as
// verified by default — an unavailable check is not a passing check.
let verified = 0
let partial = 0
let unverified = 0
let contradicted = 0
for (const r of results) {
  const verdicts = r.verification && r.verification.verdicts ? r.verification.verdicts : null
  if (!verdicts) {
    unverified += (r.findings.facts || []).length + (r.findings.inferences || []).length
    continue
  }
  for (const v of verdicts) {
    if (v.verdict === 'VERIFIED') verified++
    else if (v.verdict === 'PARTIALLY VERIFIED') partial++
    else if (v.verdict === 'CONTRADICTED') contradicted++
    else unverified++
  }
}

if (failedQuestions.length) {
  log(`${failedQuestions.length} question(s) returned no result: ${failedQuestions.map((q) => q.id).join(', ')}`)
}
log(`Findings: ${verified} verified, ${partial} partially verified, ${unverified} unverified, ${contradicted} contradicted.`)

// --- Phase 4: synthesis -----------------------------------------------------
//
// The synthesis agent also does not receive the feature request. It writes a map
// of the existing system, not a proposal.

phase('Synthesize')

const synthesisPayload = results.map((r) => ({
  id: r.question.id,
  question: r.question.question,
  category: r.question.category || null,
  facts: r.findings.facts || [],
  inferences: r.findings.inferences || [],
  unknowns: r.findings.unknowns || [],
  relatedTests: r.findings.relatedTests || [],
  contradictions: r.findings.contradictions || [],
  verdicts: r.verification ? r.verification.verdicts || [] : [],
  verificationMissing: !r.verification,
  missedContext: r.verification ? r.verification.missedContext || [] : [],
}))

const report = await agent(
  [
    `Write the codebase research report to ${researchPath}.`,
    '',
    templatesDir
      ? `Use the template at ${templatesDir}/research.md for structure, or if`
      : `Use`,
    `${templatesDir ? 'that path is unavailable, ' : ''}the section order: Scope, Executive Map, Current System Flow,`,
    `Findings, Existing Patterns, Relevant Tests, Relevant Configuration, Relevant`,
    `Dependencies, Contradictions / Ambiguities, Research Confidence, Files Most Relevant`,
    `to Design.`,
    '',
    'This is an objective description of how the system works today. You have not been',
    'told what anyone intends to build, and you must not speculate about it.',
    '',
    'Verified research data:',
    JSON.stringify(synthesisPayload, null, 2),
    '',
    failedQuestions.length
      ? `These questions returned no result and must be listed in Scope as unanswered: ${failedQuestions.map((q) => `${q.id} (${q.question})`).join('; ')}`
      : 'Every question returned a result.',
    '',
    'Rules:',
    '',
    '1. Every FACT keeps its evidence as path:startLine-endLine. Never write a fact',
    '   without evidence, and never invent evidence to support one.',
    '2. Carry each verification verdict into the report. A PARTIALLY VERIFIED claim is',
    '   recorded using its corrected narrower statement. An UNVERIFIED or CONTRADICTED',
    '   claim is recorded with that verdict attached, not quietly upgraded or dropped.',
    '   Where verification was unavailable, mark the finding UNVERIFIED.',
    '3. Label INFERENCE and UNKNOWN explicitly. An unknown that says what would resolve',
    '   it is useful; an unknown padded into a guess is not.',
    '4. Existing Patterns states where patterns exist and where they do not. It never',
    '   says a pattern should be used — that is a design decision owned by a human.',
    '5. Contradictions / Ambiguities is the most valuable section. Record every place the',
    '   repository disagrees with itself, so the design stage can put the choice to a',
    '   human instead of silently inheriting whichever pattern was found first.',
    '6. Be concise. Cut anything that does not help someone make a design decision.',
    '',
    'You may read files to resolve a citation or check a line range. Do not change any',
    'source file. Write only the report.',
    '',
    'Return a short plain-text summary: what the report covers and which areas are',
    'low-confidence.',
  ].join('\n'),
  { label: 'synthesize:research', phase: 'Synthesize' }
)

return {
  ok: true,
  slug,
  artifact: researchPath,
  questionCount: questions.length,
  answered: results.length,
  unanswered: failedQuestions.map((q) => q.id),
  findings: { verified, partiallyVerified: partial, unverified, contradicted },
  summary: report || '(synthesis agent returned no summary)',
}
