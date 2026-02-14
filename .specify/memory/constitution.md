<!--
Sync Impact Report
- Version change: 1.0.0 -> 1.1.0
- Modified principles:
  - I. Mandatory Multi-Layer Testing -> I. Mandatory Multi-Layer Testing (expanded with E2E Puppeteer mandate)
- Added sections:
  - E2E Testing with Puppeteer (sub-section under Principle I)
- Removed sections:
  - None
- Templates requiring updates:
  - ✅ updated: .specify/templates/plan-template.md (E2E testing phase added)
  - ✅ updated: .specify/templates/spec-template.md (E2E test considerations added)
  - ⚠ pending: .specify/templates/tasks-template.md
- Follow-up TODOs:
  - None
-->
# Chrome Extension Project Constitution

## Core Principles

### I. Mandatory Multi-Layer Testing
Every change MUST ship with tests at the right layers: unit tests for pure logic,
integration tests for background/content-script messaging and storage behavior, and
end-to-end tests for user-visible flows. Bug fixes MUST include a failing
regression test before the fix. A change cannot merge while any related tests fail.
When a test fails, always investigate whether it has caught a real bug before
assuming the test itself is wrong — a failing test is evidence, not noise.
This is non-negotiable because Chrome extension behavior spans isolated runtimes
where regressions are hard to detect manually.

#### E2E Testing with Puppeteer

Chrome extension projects MUST include an E2E test suite that launches a real Chrome
instance with the extension installed and observes actual outcomes via the Chrome
DevTools Protocol (CDP). This is mandatory because unit tests with mocked Chrome APIs
cannot catch real-world issues such as:
- `chrome.tabGroups.query()` returning groups in creation order instead of visual order
- `openerTabId` not propagating when tabs are created from the service worker context
- Service worker suspension/restart invalidating CDP sessions
- Storage write races between event handlers and evaluation cycles
- Chrome closing when the last tab is removed during test cleanup

**Architecture requirements for the E2E harness:**
- Use Puppeteer's bundled "Chrome for Testing" binary (stable Chrome blocks
  `--load-extension`).
- Communicate with the extension's service worker via CDP (`Runtime.evaluate`),
  not `page.evaluate` (which runs in page context, not the SW).
- The extension MUST expose `self.__runEvaluationCycle` on `globalThis` so the
  harness can trigger evaluation cycles deterministically (no alarm timing or
  sleep-based guessing).
- The extension MUST expose `self.__evaluationCycleRunning` (as a getter) on
  `globalThis` so the harness can poll for in-flight cycles before triggering
  new ones.
- The harness MUST maintain a pinned keeper tab to prevent Chrome from exiting
  when tests close all tracked tabs.
- The harness MUST clear `tabMeta` and `windowState` between tests to prevent
  state leakage.

**When E2E tests MUST run:**
- After creating or substantially changing core extension logic (service worker,
  group management, tab placement, status evaluation, sorting).
- After changing Chrome API usage patterns or adding new Chrome API calls.
- After modifying the evaluation cycle, event handlers, or guard flags.
- Before any release or version bump.
- When debugging a behavior that unit tests cannot reproduce.

**When E2E tests need NOT run:**
- After cosmetic changes (CSS, options page layout, icon updates).
- After documentation-only changes.
- After changes to unit test files themselves.
- After changes isolated to pure-logic modules with full unit test coverage.

E2E tests are NOT part of the default `npm test` command. They run via a separate
command (e.g., `npm run test:e2e-chrome`) and require a display server.

### II. Structured Logging and Privacy-Safe Diagnostics
Runtime diagnostics MUST use structured logs with stable fields: timestamp,
severity, context (`background`, `content-script`, `popup`, `options`), and a
correlation ID for cross-context flows. Logs MUST never include secrets, full URLs
with sensitive query parameters, or user content unless explicitly redacted. New
error paths MUST expose stable error codes that are asserted in tests and
documented for support. This is mandatory to debug asynchronous extension failures
without violating user privacy.

### III. Documentation Is a Release Artifact
Any feature that changes behavior MUST update developer and user documentation in
the same change set. At minimum, updates MUST cover setup/usage notes, changed
permissions or host access, message/storage contract changes, and operator
troubleshooting steps. Architecture decisions that change context boundaries or data
ownership MUST be recorded in project docs. Documentation drift is treated as a
defect because extension reviews and maintenance depend on accurate written context.

### IV. Least-Privilege Manifest and Permission Governance
The extension MUST target Manifest V3 and request the minimum permissions and host
access required for the feature. Each added permission, host pattern, or externally
reachable endpoint MUST include a written rationale, test coverage, and reviewer
sign-off. Remote code execution patterns (for example dynamic code eval from network
responses) are prohibited. This principle exists to keep the extension compliant
with Chrome Web Store policy and to reduce security risk.

### V. Context Isolation and Contract-Driven Messaging
Communication between background scripts, content scripts, and UI surfaces MUST use
explicit, versioned message contracts with schema validation. Storage keys and
payload schemas MUST be versioned whenever compatibility may break, with migration
behavior defined before rollout. Features MUST degrade gracefully when permissions
are unavailable, a tab is inaccessible, or the service worker is restarted. This
guards against brittle coupling across extension execution contexts.

## Extension Architecture & Operational Constraints

- The canonical source of capability is `manifest.json`; code and docs MUST match
  declared permissions and host access.
- Default behavior MUST be privacy-preserving: collect the minimum data, retain it
  for the shortest useful duration, and document retention rules.
- Network access MUST be limited to allowlisted origins documented in feature specs.
- Background work MUST be resilient to Manifest V3 service-worker suspension and
  restart.
- Any third-party dependency added to extension runtime code MUST be reviewed for
  size, permissions impact, and supply-chain risk.

## Development Workflow & Quality Gates

- Every feature plan MUST include a constitution check that maps planned changes to
  all five core principles.
- Every spec MUST include an extension impact assessment: contexts touched,
  manifest/permission deltas, logging changes, documentation changes, and contract
  migrations.
- Task lists MUST include explicit work items for tests, logging, documentation, and
  permission review when applicable.
- Pull requests MUST not merge until automated tests pass, documentation updates are
  present, and manifest/permission changes are reviewed.
- Release candidates MUST pass a manual smoke test on a clean Chrome profile and
  policy/compliance checklist review.

## Governance

This constitution overrides conflicting local conventions for this repository.
Amendments require a pull request that includes: proposed text changes, rationale,
migration steps for existing templates/processes, and approval from project
maintainers. Compliance is reviewed in planning (`plan.md` constitution gate),
specification quality checks, and pull request review.

Versioning policy for this constitution follows semantic versioning:
- MAJOR: Removal or incompatible redefinition of a principle or governance rule.
- MINOR: New principle/section or materially expanded mandatory guidance.
- PATCH: Clarifications, wording improvements, or non-semantic edits.

Compliance expectations:
- Reviewers MUST block changes that do not satisfy applicable principles.
- Exceptions MUST be documented in the implementation plan's complexity tracking with
  an expiry or follow-up task.

**Version**: 1.1.0 | **Ratified**: 2026-02-12 | **Last Amended**: 2026-02-14
