# Design: <feature>

> Answers one question: WHERE ARE WE GOING?
> Requires explicit human approval. Optimize for decision leverage, not length.

## Problem

Concise problem statement.

## Current State

What exists today, grounded in the research findings.

## Desired End State

What should exist after the feature.

## Relevant Existing Patterns

### Pattern 1: <name>

Evidence:
- `path:lines`

Applicability to this change:

### Pattern 2: <name>

Evidence:
- `path:lines`

Applicability to this change:

## Proposed Design

High-level technical design. No method bodies.

## End-to-End Flow

```text
actor
  -> boundary
  -> application
  -> domain
  -> persistence / external system
  -> result
```

## Interfaces / Contracts

APIs, messages, schemas, domain boundaries. Shapes, not implementations.

## Data Changes

Schema and state implications. Migration direction. Backfill needs.

## Security / Authorization

Which controls apply, and where they execute relative to persistence.

## Failure Semantics

What happens when each dependency fails. What the caller sees. What is retried.

## Compatibility

Backward compatibility for existing callers, stored data, and in-flight messages.

## Observability

Logs, metrics, traces, events — only what is actually needed to operate this.

## Resolved Decisions

| Decision | Resolution | Reason |
| -------- | ---------- | ------ |
|          |            |        |

## Open Questions

Questions requiring human judgment. Do not answer these by guessing.

-

## Alternatives Considered

### Alternative A: <name>

Advantages:

Risks:

Reason rejected / retained:

## Non-Goals

Explicitly excluded behavior.

## Least-Confident Decisions

1.
2.
3.

These are the decisions the human reviewer should challenge first.
