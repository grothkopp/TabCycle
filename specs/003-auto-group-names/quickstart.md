# Quickstart: Auto-Name Unnamed Groups

## Manual validation

1. Load extension from `src/` in Chrome.
2. Open extension options and confirm defaults:
   - `Enable automatic group naming` is on.
   - `Delay before naming` is `5` minutes.
3. Create a user tab group with an empty title.
4. Keep the group unnamed past the configured delay.
5. Verify the group gets a concise 1-2 word name derived from tab content.

## Edge-case checks

1. Enable `Show group age in title`.
2. Create an unnamed group and wait past delay.
3. Verify result is `<BaseName> (<age>)` and not only `(<age>)`.
4. Start editing an unnamed group title near threshold.
5. Verify auto-naming is skipped while edit lock is active.
6. Confirm a non-empty user base title is never overwritten by auto-naming.

## Test commands

```bash
npm run test:unit
npm run test:integration
node --experimental-vm-modules node_modules/.bin/jest tests/e2e-chrome/auto-group-naming.test.js tests/e2e-chrome/settings-persistence.test.js --testTimeout=60000 --runInBand
```

## Executed matrix

- `npm run test:unit` ✅
- `npm run test:integration` ✅
- Focused real Chrome E2E for this feature (`auto-group-naming`, `settings-persistence`) ✅
- Full `npm test` in sandboxed mode is not a reliable gate here because it includes full e2e-chrome launch, which requires non-sandboxed browser profile access.
