# Storage Contract: Auto-Name Unnamed Groups

## Settings (`v1_settings`)

### New fields

- `autoGroupNamingEnabled: boolean`
- `autoGroupNamingDelayMinutes: integer (>0)`

### Default values (install-time)

- `autoGroupNamingEnabled = true`
- `autoGroupNamingDelayMinutes = 5`

### Runtime fallback contract

If stored values are missing or invalid:

- `autoGroupNamingEnabled` falls back to `true`
- `autoGroupNamingDelayMinutes` falls back to `5`

No migration to a new storage schema version is required.

## Window state (`v1_windowState`)

### `windowState[windowId].groupNaming`

`groupNaming` is a per-window map keyed by `groupId`:

```json
{
  "<groupId>": {
    "firstUnnamedSeenAt": 1739577600000,
    "lastAutoNamedAt": 1739577900000,
    "lastCandidate": "React Docs",
    "userEditLockUntil": 1739577915000
  }
}
```

### Field semantics

- `firstUnnamedSeenAt`: first observed time that the group had an empty base title.
- `lastAutoNamedAt`: timestamp of the last auto-name write, or `null` if none.
- `lastCandidate`: last auto-generated base title candidate (1-2 words), or `null`.
- `userEditLockUntil`: timestamp until which auto-naming is blocked due to active user title edits.

### Lifecycle rules

- Entries are created/updated only for non-special groups.
- Entries are removed when:
  - the group no longer exists in the window,
  - or the group has a non-empty base title.
- Reconciliation keeps only live groups and normalizes malformed metadata.
