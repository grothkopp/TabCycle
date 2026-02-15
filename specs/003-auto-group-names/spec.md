# Feature Specification: Auto-Name Unnamed Groups

**Feature Branch**: `003-auto-group-names`  
**Created**: 2026-02-15  
**Status**: Draft  
**Input**: User description: "I want groups with no name to automatically be given a fitting name after a short time. When a group with no name is created (by the extension or by the user) and it's not given a name for 5 minutes, the extension should give the group a fitting name. The name should be as short as possible (1-2 words max) and describe the content of the tabs in the group. This feature should be configurable by the user on the config page (on/off, default on. group age in minutes: default 5)."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Auto-Name Unnamed Groups (Priority: P1)

As a user, I want unnamed tab groups to receive a concise descriptive name automatically after a short delay, so I can quickly understand what each group contains without manually naming everything.

**Why this priority**: This is the core feature value and primary behavior requested.

**Independent Test**: Create a group with no title, wait past the configured age threshold, and verify the group receives a descriptive name with one or two words.

**Acceptance Scenarios**:

1. **Given** a newly created group has no name, **When** it remains unnamed for the configured threshold (default 5 minutes), **Then** the system assigns a descriptive name to that group.
2. **Given** the feature is enabled and an unnamed group crosses the threshold, **When** naming is applied, **Then** the assigned name uses at most two words.
3. **Given** the feature is enabled and multiple unnamed groups cross the threshold, **When** the system processes them, **Then** each group is named independently based on its own tab content.

---

### User Story 2 - Respect User Control Over Names (Priority: P1)

As a user, I want my manual group names to be preserved, so the extension never overrides names I have already chosen.

**Why this priority**: Protecting user intent is mandatory for trust and usability.

**Independent Test**: Create an unnamed group, manually name it before the threshold, and verify no automatic rename occurs.

**Acceptance Scenarios**:

1. **Given** an unnamed group is created, **When** the user assigns a name before the threshold, **Then** automatic naming is skipped for that group.
2. **Given** a group already has any non-empty name (user-provided or previously assigned), **When** evaluation runs, **Then** the group is not auto-renamed.
3. **Given** a group is auto-named, **When** the user later edits the name, **Then** the user-edited name is preserved.

---

### User Story 3 - Configure Auto-Naming Behavior (Priority: P2)

As a user, I want to enable or disable automatic group naming and set the age threshold in minutes, so the feature matches my workflow.

**Why this priority**: Configurability is explicitly requested and required for adoption across different usage styles.

**Independent Test**: Change settings in the options page (toggle and threshold), save, and verify subsequent unnamed groups follow the configured behavior.

**Acceptance Scenarios**:

1. **Given** a fresh install or no saved settings, **When** the options page is opened, **Then** auto-naming is enabled by default and threshold is 5 minutes.
2. **Given** auto-naming is disabled, **When** unnamed groups pass the configured age, **Then** no automatic name is assigned.
3. **Given** the threshold is changed to a custom value, **When** unnamed groups age past the new threshold, **Then** naming follows the new threshold.

### Edge Cases

- A group is created unnamed and then deleted before reaching threshold: no naming attempt should occur.
- A group has tabs with mixed/unrelated topics: the assigned name should remain short and neutral rather than misleadingly specific.
- A group has too little useful context (for example, temporary or blank tabs): the system should still assign a short fallback label.
- The user disables auto-naming after groups have been created but before they reach threshold: pending unnamed groups should remain unnamed while disabled.
- The user changes the threshold while some groups are already aging unnamed: eligibility should be evaluated against the currently configured threshold.

### E2E Test Considerations

- **E2E required for**: unnamed group creation in real Chrome, delayed naming after threshold, user naming just before threshold, toggle-off behavior, and custom threshold behavior.
- **Why unit tests are insufficient**: real browser behavior is needed for tab-group title updates, timing interactions, and service-worker lifecycle behavior across real extension events.
- **Harness requirements**: deterministic cycle triggering, ability to create both user-like and extension-created groups, utilities to backdate group age without sleep-heavy tests, and guard-state polling before assertions.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST detect groups that currently have no name.
- **FR-002**: The system MUST track unnamed-group age from group creation time.
- **FR-003**: When auto-naming is enabled, the system MUST assign a generated name once an unnamed group reaches the configured age threshold.
- **FR-004**: The default unnamed-group age threshold MUST be 5 minutes.
- **FR-005**: The generated group name MUST be concise and limited to one or two words.
- **FR-006**: The generated group name MUST be based on the content of tabs in that group and aim to describe the dominant topic.
- **FR-007**: The system MUST NOT overwrite any group that has a non-empty name at evaluation time.
- **FR-008**: The system MUST provide an options-page toggle to enable or disable automatic naming, defaulting to enabled.
- **FR-009**: The system MUST provide an options-page numeric setting for unnamed-group age threshold in minutes, defaulting to 5.
- **FR-010**: The system MUST validate that the threshold setting is a positive whole number of minutes before saving.
- **FR-011**: Changes to auto-naming settings MUST be persisted and applied to subsequent evaluations.
- **FR-012**: If auto-naming is disabled, the system MUST skip automatic naming for all unnamed groups.
- **FR-013**: If generated naming context is insufficient, the system MUST assign a short generic fallback name.
- **FR-014**: Automatic naming MUST apply to unnamed groups regardless of whether they were created by the extension or by the user.

### Key Entities

- **Unnamed Group**: A tab group whose displayed name is empty. Attributes: group identifier, creation timestamp, current tabs, current name state.
- **Auto-Naming Settings**: User preferences controlling behavior. Attributes: enabled flag (default true), age threshold minutes (default 5).
- **Generated Group Name**: A short label created from group tab content. Attributes: text value, word count limit (1-2), fallback status when context is weak.

### Assumptions & Dependencies

- Group creation time is available or can be reliably inferred at the moment the group first enters extension tracking.
- A concise fallback label is acceptable when tab content does not provide a clear topic.
- Automatic naming is a one-time assignment for unnamed groups; later manual edits by users take precedence.
- Options-page settings for this feature are part of the existing extension configuration model and persist across restarts.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of eligible unnamed groups receive an automatic name within 30 seconds after crossing the configured threshold when the feature is enabled.
- **SC-002**: 0% of groups that already have a non-empty name are renamed automatically.
- **SC-003**: 100% of automatically assigned names contain no more than two words.
- **SC-004**: In default configuration, users see auto-naming enabled and threshold set to 5 minutes on first settings load.
- **SC-005**: After users change and save settings, at least 95% of qualifying groups follow the updated behavior in the next evaluation window.
