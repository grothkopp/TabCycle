# Quickstart: Auto-Name Unnamed Groups

**Branch**: `003-auto-group-names` | **Date**: 2026-02-15

## Prerequisites

- Google Chrome (MV3 extension support)
- Node.js 18+ and npm
- TabCycle repository cloned locally

## Setup

```bash
cd /Users/sg/dev/TabCycle
git checkout 003-auto-group-names
npm install
```

## Load Extension

1. Open `chrome://extensions/`
2. Enable Developer mode
3. Click `Load unpacked` and choose `/Users/sg/dev/TabCycle/src`
4. For updates, click `Reload` on the TabCycle extension card

## New Settings

Open extension options and verify:

- `Auto-name unnamed groups` (default: enabled)
- `Auto-name delay (minutes)` (default: `5`)

Existing setting interaction:
- `Show group age in title` may be on/off and must not conflict with auto-naming.

## Manual Validation Flow

### Scenario 1: Basic auto-naming

1. Create an unnamed tab group with related tabs (same topic).
2. Wait until delay threshold is reached.
3. Confirm group receives a 1-2 word descriptive base name.

### Scenario 2: User naming wins

1. Create unnamed group.
2. Start editing its title near/at threshold time.
3. Confirm auto-naming is skipped/aborted and user input remains.

### Scenario 3: Age suffix coexistence

1. Enable `Show group age in title`.
2. Let unnamed group reach naming threshold.
3. Confirm final display title keeps both:
   - auto-generated base name,
   - age suffix.
4. Confirm no overwrite ping-pong between features across multiple cycles.

### Scenario 4: Age-only title eligibility

1. Create group whose visible title is only age suffix metadata.
2. Confirm feature treats base name as empty and can auto-name the group.

## Test Commands

```bash
# Unit
npm run test:unit

# Integration
npm run test:integration

# Mocked E2E
npm run test:e2e

# Real Chrome E2E (required for this feature)
npm run test:e2e-chrome
```

## Progressive E2E Re-run Strategy

Use this order when debugging failures:

```bash
# 1) failing file only
npm run test:e2e-chrome -- --testPathPattern='auto-group-naming.test.js'

# 2) failing + related interaction file(s)
npm run test:e2e-chrome -- --testPathPattern='auto-group-naming.test.js|settings-persistence.test.js'

# 3) full suite after isolation passes
npm run test:e2e-chrome
```

## Debugging Notes

- Service worker logs: `chrome://extensions/` -> TabCycle -> `Inspect views: service worker`
- Focus log lines for naming decisions (`named`, `skipped`, `aborted`) and race/collision handling.
- Validate storage state in DevTools Application tab:
  - `v1_settings` new fields
  - `v1_windowState` group naming metadata
