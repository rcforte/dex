# Codebase Research: <feature>

> Objective findings about the system as it exists today.
> Produced by isolated workers that never saw the feature request.

## Scope

Questions investigated:

1.

Questions that could not be answered, and why:

-

## Executive Map

A concise map of the relevant part of the system. Components and their
responsibilities, nothing aspirational.

## Current System Flow

```text
entry point
  -> component
  -> component
  -> persistence / event / external system
```

## Findings

### Q1: <question>

Verification: VERIFIED | PARTIALLY VERIFIED | UNVERIFIED | CONTRADICTED

#### Facts

- FACT: <statement>
  Evidence:
  - `path/to/file.ext:120-163`

#### Inferences

- INFERENCE: <statement>
  Based on:
  - `path/to/file.ext:48-71`

#### Unknowns

- UNKNOWN: <what could not be established, and what would establish it>

## Existing Patterns

Patterns observed in the repository. State that they exist and where.
Do not state that they should be used — that is a design decision.

### Pattern: <name>

Where it appears:
- `path:lines`

What it does:

Where it is NOT used:

## Relevant Tests

- `path:lines` — what behavior it pins down

## Relevant Configuration

- `path` — what it controls

## Relevant Dependencies

- `name@version` — where it is used

## Contradictions / Ambiguities

Places where different parts of the repository disagree, or where two patterns
compete. These are the questions the design stage must put to the human.

-

## Research Confidence

High-confidence areas:

-

Low-confidence areas:

-

## Files Most Relevant to Design

- `path`
- `path`
