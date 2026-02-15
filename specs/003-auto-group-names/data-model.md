# Data Model: Auto-Name Unnamed Groups

**Branch**: `003-auto-group-names` | **Date**: 2026-02-15

## Storage Schema Version

**Current**: `v1` (additive extension only)  
**Key**: `v1_schemaVersion` remains `1`

No schema-version bump is required because all changes are backward-compatible additions.

## Modified Entities

### 1. Settings (`v1_settings`) — Extended

Add auto-naming controls to existing settings:

```json
{
  "timeMode": "active",
  "thresholds": {
    "greenToYellow": 14400000,
    "yellowToRed": 28800000,
    "redToGone": 86400000
  },
  "showGroupAge": false,
  "bookmarkEnabled": true,
  "bookmarkFolderName": "Closed Tabs",
  "autoGroupNamingEnabled": true,
  "autoGroupNamingDelayMinutes": 5
}
```

| Field | Type | Default | Constraints |
|-------|------|---------|-------------|
| `autoGroupNamingEnabled` | `boolean` | `true` | Must be boolean |
| `autoGroupNamingDelayMinutes` | `number` | `5` | Positive whole number |

**Backward compatibility**:
- If fields are absent (upgrade case), code must use defaults: `true` and `5`.

### 2. Window State (`v1_windowState`) — Extended

Add per-window runtime metadata for group naming decisions:

```json
{
  "1": {
    "specialGroups": { "yellow": 456, "red": null },
    "groupZones": { "789": "green" },
    "groupNaming": {
      "789": {
        "firstUnnamedSeenAt": 1708135200000,
        "lastAutoNamedAt": null,
        "lastCandidate": null,
        "userEditLockUntil": 1708135500000
      }
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `groupNaming[groupId].firstUnnamedSeenAt` | `number` | First timestamp when base group name was observed as empty |
| `groupNaming[groupId].lastAutoNamedAt` | `number \| null` | Last timestamp of successful auto-name write |
| `groupNaming[groupId].lastCandidate` | `string \| null` | Last generated candidate used/considered |
| `groupNaming[groupId].userEditLockUntil` | `number` | Timestamp until which auto-naming must not run for this group |

**Lifecycle/cleanup**:
- Create metadata on first observation of a group with empty base name.
- Remove metadata when group is removed, no longer present in window, or no longer trackable.
- Group IDs are session-scoped; stale entries must be reconciled during cycle/state reconciliation.

## New Conceptual Entities

### 3. Base Group Name (Derived)

Semantic group name excluding extension-managed age suffix.

| Attribute | Type | Notes |
|-----------|------|-------|
| `value` | `string` | Empty means unnamed |
| `source` | `user \| auto \| empty` | Decision metadata for behavior and testing |

### 4. Group Display Title (Derived)

Composed visible title in Chrome:

`displayTitle = compose(baseGroupName, ageSuffix?)`

Where:
- `baseGroupName` is user/auto semantic name.
- `ageSuffix` is extension-managed metadata (e.g., `(23m)`), optional.

### 5. Generated Name Candidate (Ephemeral)

Keyword extraction output prior to persistence.

| Attribute | Type | Constraints |
|-----------|------|-------------|
| `text` | `string` | 1-2 words |
| `wordCount` | `number` | `1` or `2` |
| `confidence` | `number` | `0.0`-`1.0` for internal gating |
| `reason` | `string` | Scoring path/fallback reason |

## Validation Rules

- Auto-name settings:
  - `autoGroupNamingEnabled` must be boolean.
  - `autoGroupNamingDelayMinutes` must be integer and `> 0`.
- Generated name:
  - Maximum 2 words.
  - Non-empty after normalization.
- Eligibility:
  - Group is eligible only when base group name is empty.
  - Age suffix text alone does not count as a base name.
  - Auto-name blocked while user edit lock is active.

## State Transitions

```text
New/Observed Group
  -> (base name empty) PendingDelay
  -> (delay reached, no user lock, feature enabled) Eligible
  -> (candidate generated) NamingAttempt
  -> (write success) AutoNamed
  -> (user edit detected) SkippedUserEdit
  -> (feature disabled) SkippedDisabled
  -> (group removed) Removed
```

Transition notes:
- `PendingDelay` timer is based on unnamed duration from `firstUnnamedSeenAt`.
- `SkippedUserEdit` can be revisited only if base name becomes empty again and lock expires.
- Once base name is non-empty, auto-naming is no longer applicable unless user clears it.

## Invariants

- User-provided base names are never overwritten by auto-naming.
- Auto-naming and age-suffix updater modify different logical parts of title composition.
- Title composition is deterministic and idempotent (re-running produces same display title for same inputs).
