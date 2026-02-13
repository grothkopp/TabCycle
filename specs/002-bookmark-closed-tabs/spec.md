# Feature Specification: Bookmark Closed Tabs

**Feature Branch**: `002-bookmark-closed-tabs`  
**Created**: 2026-02-13  
**Status**: Clarified  
**Input**: User description: "I want the option that tabs and tabgroups that are closed by TabCycle because they reach the 'gone' state are saved as bookmarks. This functionality should be able to be turned on and off in the options (default=on). The bookmarks should be stored in a subfolder of All Bookmarks named 'Closed Tabs' (configurable in options). TabGroups should be saved as a subfolder of this folder with the TabGroup Name (or '(unnamed)' if no name was set), individual tabs should just be saved in that folder."

## Clarifications

### Session 2026-02-13

- Q: When the user changes the bookmark folder name in settings and a folder with the old name already exists, should the old folder be left as-is (new folder created) or renamed? → A: The existing folder should be renamed to the new name. Existing bookmarks in the folder persist.
- Q: If multiple folders under "Other Bookmarks" share the configured name, which one should the extension use? → A: Track the folder by its internal ID after first use; only fall back to name matching if the stored ID is missing or invalid.
- Q: Should empty/blank tabs (chrome://newtab, about:blank, empty URL) be bookmarked when closed? → A: No. Empty tabs should be closed without creating a bookmark.
- Q: What should happen when the user manually renames the bookmark folder in Chrome's bookmark manager? → A: The extension should detect the rename via the stored internal folder ID and update the folder name setting in the options to match.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Save Individual Tabs as Bookmarks on Close (Priority: P1)

As a user, I want tabs that are automatically closed by TabCycle when they reach the "Gone" state to be saved as bookmarks in a dedicated folder, so that I can recover closed tabs later without losing access to their content.

**Why this priority**: This is the core value of the feature — preserving access to automatically closed content. Without this, the feature has no purpose.

**Independent Test**: Can be tested by letting an ungrouped tab age through Green → Yellow → Red → Gone and verifying that a bookmark is created in the "Closed Tabs" folder with the tab's title and URL.

**Acceptance Scenarios**:

1. **Given** an ungrouped tab reaches the "Gone" state, **When** TabCycle closes the tab, **Then** a bookmark is created in the "Closed Tabs" folder with the tab's title and URL.
2. **Given** the "Closed Tabs" bookmark folder does not yet exist, **When** a tab is closed for the first time by TabCycle, **Then** the folder is created under the top-level bookmarks and the bookmark is saved inside it.
3. **Given** the "Closed Tabs" bookmark folder already exists, **When** a tab is closed by TabCycle, **Then** the bookmark is added to the existing folder without duplicating or recreating the folder.
4. **Given** a tab with no title (empty or undefined) but a valid URL, **When** TabCycle closes it, **Then** the bookmark is created using the tab's URL as the bookmark title.
5. **Given** a tab with an empty URL, `chrome://newtab`, or `about:blank`, **When** TabCycle closes it, **Then** no bookmark is created and the tab is closed silently.

---

### User Story 2 - Save Tab Groups as Bookmark Subfolders on Close (Priority: P1)

As a user, I want tab groups that are closed by TabCycle when they reach the "Gone" state to be saved as a subfolder of "Closed Tabs" containing bookmarks for each tab in the group, so that I can recover an entire group's worth of tabs at once.

**Why this priority**: Tab groups represent a coherent set of related tabs. Saving them as a subfolder preserves the grouping context, which is equally important as saving individual tabs.

**Independent Test**: Can be tested by letting a user-created tab group age to Gone status and verifying that a subfolder is created inside "Closed Tabs" named after the group, containing bookmarks for each tab that was in the group.

**Acceptance Scenarios**:

1. **Given** a user-created tab group with a name reaches the "Gone" state, **When** TabCycle closes the group and its tabs, **Then** a subfolder named after the group is created inside "Closed Tabs" and each tab is saved as a bookmark inside that subfolder.
2. **Given** a user-created tab group with no name (empty name) reaches the "Gone" state, **When** TabCycle closes the group, **Then** a subfolder named "(unnamed)" is created inside "Closed Tabs" containing bookmarks for each tab.
3. **Given** multiple groups with the same name are closed at different times, **When** each group is closed, **Then** each group creates its own separate subfolder (multiple subfolders with the same name are permitted).
4. **Given** a tab inside the special "Red" group reaches the "Gone" state and is closed individually (not as part of a group close), **When** TabCycle closes the tab, **Then** the tab is saved as an individual bookmark directly in the "Closed Tabs" folder (not in a subfolder).

---

### User Story 3 - Toggle Bookmark Saving On/Off (Priority: P2)

As a user, I want to be able to enable or disable the bookmark-saving behavior in the extension settings, so that I can choose whether I want closed tabs preserved or silently discarded.

**Why this priority**: User control over the feature is essential for adoption but depends on the core saving mechanism (P1) being in place first.

**Independent Test**: Can be tested by toggling the setting off, letting a tab reach Gone, and verifying no bookmark is created. Then toggling it on, letting another tab reach Gone, and verifying a bookmark is created.

**Acceptance Scenarios**:

1. **Given** the bookmark-saving setting is enabled (default), **When** a tab or group is closed by TabCycle, **Then** bookmarks are created as described in User Stories 1 and 2.
2. **Given** the bookmark-saving setting is disabled, **When** a tab or group is closed by TabCycle, **Then** no bookmarks are created and tabs are closed silently.
3. **Given** the user opens the settings page for the first time (no prior configuration), **When** the page loads, **Then** the bookmark-saving toggle is shown as enabled by default.

---

### User Story 4 - Configure Bookmark Folder Name (Priority: P3)

As a user, I want to customize the name of the bookmark folder where closed tabs are saved, so that I can organize my bookmarks according to my own naming preferences.

**Why this priority**: Configurability of the folder name is a nice-to-have that adds flexibility but is not essential for the core feature to work.

**Independent Test**: Can be tested by changing the folder name in settings to a custom value, letting a tab reach Gone, and verifying the bookmark appears in a folder with the custom name.

**Acceptance Scenarios**:

1. **Given** the user has not changed the folder name setting, **When** a tab is closed by TabCycle, **Then** bookmarks are saved under a folder named "Closed Tabs".
2. **Given** the user changes the folder name to "My Archived Tabs" in settings, **When** a tab is closed by TabCycle, **Then** bookmarks are saved under a folder named "My Archived Tabs".
3. **Given** the user changes the folder name and a folder with the old name already exists containing bookmarks, **When** the settings are saved, **Then** the existing folder is renamed to the new name and all existing bookmarks inside it are preserved.
4. **Given** the user enters an empty string as the folder name, **When** attempting to save settings, **Then** the settings form rejects the input and displays a validation error.
5. **Given** the user manually renames the bookmark folder in Chrome's bookmark manager, **When** the extension next accesses the folder (by stored ID), **Then** the extension detects the name change and updates the folder name setting in the options to match the new name.

---

### Edge Cases

- What happens when the bookmarks permission is not granted or the bookmarks API is unavailable? The extension should log an error and continue closing the tab without creating a bookmark, rather than failing the close operation.
- What happens when a tab's URL is an empty/blank URL (e.g., `chrome://newtab`, `about:blank`, empty string)? The tab is closed without creating a bookmark — these tabs have no meaningful content to preserve.
- What happens when a group close includes tabs that have already been individually closed (e.g., race conditions during batch processing)? The extension should create bookmarks only for tabs that still exist at the time of closure.
- What happens when the bookmark folder is manually deleted by the user between closures? The extension should detect that the folder is missing and recreate it on the next tab close.
- What happens when the user manually renames the bookmark folder in Chrome's bookmark manager? The extension should detect the rename via the stored folder ID and sync the folder name setting in the options to match the new name.
- What happens when the user renames the bookmark folder setting while tabs are actively being closed? The extension should use the setting value at the time each tab is closed; in-flight closures use the value read when they started.
- What happens when many tabs or groups are closed simultaneously (e.g., after returning from a long absence)? The extension should handle batch bookmark creation gracefully without hitting rate limits or causing errors.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When bookmark saving is enabled and TabCycle closes a tab due to reaching the "Gone" state, the extension MUST create a bookmark with the tab's title and URL.
- **FR-002**: When bookmark saving is enabled and TabCycle closes a user-created tab group due to reaching the "Gone" state, the extension MUST create a bookmark subfolder named after the group, containing a bookmark for each tab in the group.
- **FR-003**: When a tab group with no name (empty name) is bookmarked, the extension MUST use "(unnamed)" as the subfolder name.
- **FR-004**: Individual tabs closed by TabCycle (including tabs from the special "Red" group) MUST be saved as bookmarks directly in the root bookmark folder (e.g., "Closed Tabs"), not in a subfolder.
- **FR-005**: The bookmark folder MUST be created as a child of the top-level "Other Bookmarks" node if it does not already exist.
- **FR-006**: The extension MUST track the bookmark folder by its internal ID after first use. On subsequent operations, the extension MUST look up the folder by stored ID first. If the stored ID is missing or invalid (e.g., folder was deleted), the extension MUST fall back to matching by name under "Other Bookmarks". If neither yields a result, the extension MUST create a new folder.
- **FR-007**: The extension MUST provide a toggle in the settings page to enable or disable bookmark saving. The default value MUST be enabled (on).
- **FR-008**: The extension MUST provide a text input in the settings page to configure the bookmark folder name. The default value MUST be "Closed Tabs".
- **FR-009**: The settings page MUST validate that the bookmark folder name is not empty before allowing the user to save.
- **FR-010**: When the bookmark folder name setting is changed, the extension MUST rename the existing bookmark folder to the new name. All existing bookmarks and subfolders inside the folder MUST be preserved. If no folder with the old name exists, the new name is simply stored and used when the folder is next created.
- **FR-011**: If the configured bookmark folder is deleted by the user, the extension MUST recreate it on the next bookmark save operation.
- **FR-012**: If bookmark creation fails for any reason, the extension MUST NOT prevent the tab or group from being closed. The closure MUST proceed regardless of bookmark success or failure.
- **FR-013**: The extension MUST log a warning when a bookmark creation fails, including the tab URL and the reason for failure.
- **FR-014**: When multiple tabs or groups reach "Gone" simultaneously, the extension MUST create bookmarks for all of them, processing them in sequence or handling errors independently so that one failure does not block others.
- **FR-015**: The extension MUST require the "bookmarks" browser permission to support this feature.
- **FR-016**: The extension MUST persist the bookmark folder's internal ID in extension storage so it survives browser restarts and service worker reloads.
- **FR-017**: The extension MUST NOT create bookmarks for tabs whose URL is empty, `chrome://newtab`, or `about:blank`. These tabs MUST be closed silently without bookmark creation.
- **FR-018**: When the extension detects that the tracked bookmark folder (identified by stored ID) has been renamed externally (e.g., by the user in Chrome's bookmark manager), the extension MUST update the folder name setting in extension storage to match the folder's current name.

### Key Entities

- **Bookmark Folder**: A folder in the browser's bookmark tree where closed-tab bookmarks are stored. Key attributes: name (configurable, default "Closed Tabs"), parent location (under "Other Bookmarks"), persistence across sessions.
- **Bookmark**: An individual bookmark representing a tab closed by TabCycle. Key attributes: title (from tab title, falling back to URL), URL, parent folder (either the root bookmark folder or a group subfolder).
- **Group Subfolder**: A bookmark folder representing a closed tab group. Key attributes: name (from group name, or "(unnamed)" if empty), parent (the root bookmark folder), contains bookmarks for each tab that was in the group.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of tabs with meaningful URLs closed by TabCycle due to "Gone" status have a corresponding bookmark created (when the feature is enabled). Tabs with empty, `chrome://newtab`, or `about:blank` URLs are excluded and closed silently.
- **SC-002**: 100% of group closures result in a correctly named subfolder containing bookmarks for every tab that was in the group at the time of closure.
- **SC-003**: Toggling the feature off results in zero bookmarks being created for subsequently closed tabs.
- **SC-004**: The default experience (no user configuration) results in bookmark saving being active with the folder named "Closed Tabs" under "Other Bookmarks".
- **SC-005**: Bookmark creation does not delay or block tab closure — tabs are closed within the same evaluation cycle regardless of bookmark API latency.
- **SC-006**: The extension handles batch closures of 50+ tabs without bookmark creation errors or lost bookmarks.
