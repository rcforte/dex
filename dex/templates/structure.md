# Program Structure: <feature>

> Answers one question: HOW DO WE GET THERE IN SAFE, OBSERVABLE STEPS?
> Closer to header files than to code: types, signatures, file locations,
> call flow, execution order, verification points. No implementation bodies.
> Requires explicit human approval.

## Approved Design

Reference: `04-design.md`

## Change Surface

### Existing files modified

- `path` — what changes

### New files

- `path` — what it holds

### Deleted files

- `path` — why

## Important Types

```text
TypeName
  fields:
  responsibilities:
  invariants:
```

## Important Interfaces

```text
ReturnType Component.method(ParamType param)
METHOD /path/to/endpoint  ->  ResponseShape
event: EventName { field: type }
```

No implementation bodies.

## End-to-End Call Flow

```text
UserAction
  -> Controller.method()
  -> ApplicationService.method()
  -> DomainObject.method()
  -> Repository.save()
  -> response
```

## Testing Strategy

> Decide what proves the work BEFORE writing it.
> "Ensure everything works" is not a verification.

### Existing tests extended

-

### New unit tests

-

### Integration tests

-

### End-to-end tests

-

## Implementation Shape

Tracer bullet required: YES | NO

Reason:

> A vertical slice describes the SHAPE of a change: end-to-end through the
> relevant layers.
>
> A tracer bullet describes the PURPOSE and DEPTH of an early slice: the
> thinnest end-to-end implementation needed to prove the architectural path
> works. It is optional. Use one when significant integration or architecture
> uncertainty exists (a new external integration, a new persistence technology,
> a cross-service feature, a first touch of a legacy subsystem). Skip it for
> localized behavior changes, well-understood refactors, and simple business
> rule extensions.
>
> If YES, state exactly which uncertainty the tracer resolves.

Uncertainty the tracer resolves:

### Checkpoint S1

Objective:

Vertical path:

```text
entry -> application -> domain -> persistence -> observable result
```

Implementation depth:

Verification:

Expected approximate change surface:

### Checkpoint S2

Objective:

Vertical path:

Implementation depth:

Verification:

### Checkpoint S3

Objective:

Vertical path:

Verification:

## Horizontal dependency exception

> Delete this section unless it is genuinely needed.
> Horizontal sequencing — all schema, then all repositories, then all services,
> then the API, then tests — hides failures until the end. Prefer vertical
> checkpoints that each produce an observable result.

Reason verticalization is impractical:

Earliest executable checkpoint:

## Backout / Reversibility

How this can be backed out safely, per checkpoint.

## Risk Checkpoints

Where implementation should stop and return to design if an assumption fails.

-

## Least-Confident Structural Decisions

1.
2.
