# Contract: Group Title Update Coordination

## Title model

All user-group titles are treated as:

- `baseName`: semantic group name
- `ageSuffix`: optional `(<number><m|h|d>)`

Parsing and composition are defined by:

- `parseGroupTitle(title)`
- `composeGroupTitle(baseName, ageSuffix)`

Age-only titles like `(5m)` are considered empty `baseName` values.

## Update precedence

1. User-provided non-empty `baseName` is immutable to auto-naming.
2. Auto-naming may write `baseName` only when `baseName` is empty and delay/lock gates pass.
3. Group-age updates may only rewrite `ageSuffix`; they must preserve `baseName`.

## Auto-naming gate contract

Auto-naming is attempted only when all conditions hold:

- `autoGroupNamingEnabled === true`
- group is not a special group
- parsed `baseName` is empty
- unnamed duration `>= autoGroupNamingDelayMinutes`
- `Date.now() >= userEditLockUntil`
- pre-write revalidation still sees empty `baseName`

## User-edit lock contract

`chrome.tabGroups.onUpdated` title updates for non-special groups create/update
`userEditLockUntil` for a short lock window.

This prevents auto-naming from colliding with active user edits near threshold time.

## Extension-write collision contract

Extension-initiated title writes are tracked briefly and consumed by the
`tabGroups.onUpdated` handler so they are not mistaken for user edits.

This prevents extension features (auto-naming and age suffix updates) from
locking or overwriting each other.
