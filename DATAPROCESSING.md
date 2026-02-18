# Privacy Policy / Data Processing Document

**TabCycle** — Chrome extension for managing the lifecycle of open tabs
**Date:** 2026-02-18
**Version:** 0.2.0

---

## 1. Data Controller

The developer of the "TabCycle" extension is responsible for data processing within the meaning of the GDPR. Contact: via the contact address listed on the Chrome Web Store or the associated GitHub repository.

## 2. Core Principle: No Data Transmitted to Third Parties

TabCycle operates **entirely locally** on the user's device. **No data is transmitted to external servers, third parties, or the developer.** The extension makes no network requests and contains no analytics, tracking, or telemetry features.

## 3. Processed Data

TabCycle processes only the following data, all of which remains locally in the browser:

### 3.1 Tab Metadata

- Tab IDs, window numbers, and group assignments
- Tab creation and update timestamps
- Tab lifecycle status (green / yellow / red / closed)
- URLs and titles of open tabs (used solely for contextual grouping and bookmark archival)

### 3.2 Window and Group State

- Assignment of tab groups to windows
- Group names and color status
- Timestamp of the last user edit to group names

### 3.3 User Settings

- Configured thresholds for tab aging (green → yellow → red → closed)
- Enabled/disabled features (aging, grouping, bookmarks, time mode)
- Custom group names and bookmark folder name

### 3.4 Active Usage Time

- Cumulative Chrome window focus time (in milliseconds)
- Timestamp of the last focus change

**No** passwords, form data, browsing history, personal data, or other sensitive information is collected or stored.

## 4. Storage

All data is stored exclusively in `chrome.storage.local`. This is a browser-local storage mechanism that:

- remains only on the user's device,
- is **not** synchronized across browser instances or devices,
- is completely deleted when the extension is uninstalled.

## 5. Permissions and Their Purpose

TabCycle uses the following Chrome permissions:

| Permission       | Purpose |
|------------------|---------|
| `tabs`           | Querying and managing open tabs (status, moving, grouping, closing) |
| `tabGroups`      | Creating and managing tab groups for visual aging indicators |
| `storage`        | Local storage of tab metadata and user settings |
| `alarms`         | Periodic evaluation of tab status (every 30 seconds) |
| `webNavigation`  | Detecting page navigation to reset tab age |
| `bookmarks`      | Archiving closed tabs as bookmarks (optional, user-configurable) |

None of these permissions are used for collecting or transmitting user data.

## 6. Legal Basis

Processing is based on the **user's consent** (Art. 6(1)(a) GDPR) through the deliberate installation and use of the extension. The user may withdraw consent at any time by uninstalling the extension, which deletes all stored data.

## 7. Rights of the Data Subject

Since no personal data is transmitted to the developer, there is no centralized data storage. Nevertheless, the user is entitled to the following rights:

- **Access and inspection:** All stored data can be viewed via Chrome DevTools (`chrome.storage.local`).
- **Deletion:** Uninstalling the extension completely removes all data.
- **Withdrawal of consent:** Possible at any time by uninstalling the extension.
- **Restriction of processing:** Individual features (aging, grouping, bookmarks) can be disabled in the extension's settings.

## 8. Protection of Minors

TabCycle is not specifically directed at minors and does not collect personal data. Since the extension does not transmit data to third parties, there are no special risks for minors.

## 9. Changes to This Privacy Policy

Changes to this privacy policy will be published in this document with an updated date. In the event of material changes, the user will be notified via the extension's release notes.

---

*This extension was developed following the principle of "Privacy by Design." All data processing occurs locally, transparently, and under the full control of the user.*
