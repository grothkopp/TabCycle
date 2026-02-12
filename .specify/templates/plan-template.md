# Implementation Plan: [FEATURE]

**Branch**: `[###-feature-name]` | **Date**: [DATE] | **Spec**: [link]
**Input**: Feature specification from `/specs/[###-feature-name]/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command.

## Summary

[Extract from feature spec: primary requirement + technical approach from research]

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: [e.g., TypeScript 5.x or NEEDS CLARIFICATION]  
**Primary Dependencies**: [e.g., webextension-polyfill, zod, vite or NEEDS CLARIFICATION]  
**Storage**: [e.g., chrome.storage.local/sync, IndexedDB, or N/A]  
**Testing**: [e.g., Vitest + Playwright + extension integration harness or NEEDS CLARIFICATION]  
**Target Platform**: [e.g., Chrome Stable (latest + previous) on macOS/Windows/Linux]
**Manifest Version**: [MUST be Manifest V3 unless explicitly exempted]
**Extension Contexts**: [e.g., background service worker, content scripts, popup, options]
**Project Type**: [chrome-extension/monorepo-extension - determines source structure]  
**Performance Goals**: [e.g., popup interactive <500ms, event handler p95 <200ms]  
**Constraints**: [e.g., least-privilege permissions, no remote code execution, privacy-safe logging]  
**Scale/Scope**: [domain-specific, e.g., 10k users, 1M LOC, 50 screens or NEEDS CLARIFICATION]

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [ ] Testing strategy includes unit, integration, and end-to-end coverage for each changed journey.
- [ ] Logging plan defines structured fields, redaction rules, and stable error codes for new failures.
- [ ] Documentation plan covers user guidance, developer notes, and changed contracts/permissions.
- [ ] Extension impact is explicit: contexts touched, service-worker lifecycle risks, and fallback behavior.
- [ ] Manifest and permission changes follow least privilege with written rationale and review sign-off.

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```text
# [REMOVE IF UNUSED] Option 1: Single extension project (DEFAULT)
extension/
├── manifest.json
├── src/
│   ├── background/
│   ├── content/
│   ├── popup/
│   ├── options/
│   └── shared/
└── assets/

tests/
├── unit/
├── integration/
└── e2e/

# [REMOVE IF UNUSED] Option 2: Monorepo extension
apps/
└── extension/
    ├── manifest.json
    ├── src/
    └── assets/

packages/
├── shared/
└── tooling/
```

**Structure Decision**: [Document the selected structure and reference the real
directories captured above]

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., 4th project] | [current need] | [why 3 projects insufficient] |
| [e.g., Repository pattern] | [specific problem] | [why direct DB access insufficient] |
