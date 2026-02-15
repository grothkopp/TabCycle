# Group Title Update Contract: Auto-Name Unnamed Groups

**Branch**: `003-auto-group-names` | **Version**: v1

## Overview

This contract defines deterministic rules for composing group titles when two extension features may update title text:
- auto-naming unnamed groups,
- age-suffix display (`showGroupAge`).

It also defines how user edits take precedence.

---

## Canonical Title Model

Every group title is treated as:

`displayTitle = compose(baseName, ageSuffix)`

Where:
- `baseName`: semantic name (user-entered or auto-generated).
- `ageSuffix`: extension-managed metadata (for example `(23m)`), optional.

### Parsing Rule

- Use existing age-suffix parsing (`stripAgeSuffix` semantics) to extract `baseName`.
- If display title contains only age suffix text, `baseName` is considered empty.

---

## Update Precedence Rules

1. **User edits win**
   - If user is actively editing group title, auto-naming must skip/abort.
2. **Auto-naming writes base name only**
   - Auto-naming cannot directly overwrite age suffix.
3. **Age updater writes suffix only**
   - Age updater preserves current base name.
4. **Deterministic merge**
   - Final title is always recomposed from current `baseName` + current `ageSuffix`.

---

## API Contract: `chrome.tabGroups.onUpdated`

**Used by**: `service-worker.js`  
**Purpose**: detect user title edits and set lock windows that block auto-naming.

Input of interest:
- `group.id`
- `group.windowId`
- `group.title`

Required behavior:
- For non-special groups, update runtime lock metadata so active user editing blocks auto-name attempts.

---

## API Contract: `chrome.tabGroups.query({ windowId })`

**Used by**: `group-manager.js`  
**Purpose**: obtain live group titles for parsing/composition and naming eligibility checks.

Required behavior:
- Parse each group's display title into base/suffix components before any write decision.

---

## API Contract: `chrome.tabGroups.update(groupId, { title })`

**Used by**: `group-manager.js`  
**Purpose**: apply either base-name auto-naming update or age-suffix recomposition.

Required safety checks before write:
- group still exists,
- user-edit lock is not active,
- base name remains eligible (still empty for auto-naming path),
- composed title differs from current title.

---

## Auto-Name Generation Contract

### Inputs

- Live tabs in target group (`title`, `url`),
- current display title parsed into base/suffix,
- settings (`autoGroupNamingEnabled`, `autoGroupNamingDelayMinutes`),
- runtime lock metadata.

### Output

- `generatedBaseName`: string with 1-2 words,
- or skip decision with reason (`disabled`, `not-eligible`, `user-edit-lock`, `insufficient-signal`).

### Constraints

- Output must be max 2 words.
- Generic fallback must be deterministic.
- Age suffix is excluded from naming candidate extraction.

---

## Race/Conflict Handling Contract

When auto-naming and age update are both possible in one cycle:

1. parse current title,
2. compute/choose base name if eligible,
3. compute suffix (if age display enabled),
4. compose once,
5. single `chrome.tabGroups.update` write per group for final merged title.

If user edit occurs between read and write:
- abort write and retain user-provided title.

---

## Observability Contract

Each naming decision should emit structured logs with:
- `groupId`,
- decision (`named`, `skipped`, `aborted`),
- reason code (for skips/aborts),
- candidate metadata (length/score class, not full URL content).
