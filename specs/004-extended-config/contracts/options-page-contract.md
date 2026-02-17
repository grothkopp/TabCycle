# Options Page Contract: Hierarchical Settings UI

**Feature Branch**: `004-extended-config`
**Date**: 2026-02-16

## Overview

The options page (`src/options/options.html`) is restructured into a two-section hierarchical layout with collapsible detail sections and parent-child dependency grey-out.

## Page Structure

### Section 1: Aging

```
┌─ Aging ─────────────────────────────────────────────┐
│ [✓] Aging enabled                                    │
│                                                      │
│ ▶ Details                                            │
│   ┌──────────────────────────────────────────────┐   │
│   │ Time mode: (○) Active time  (○) Wall clock   │   │
│   │ Sorting:                                      │   │
│   │   [✓] Tab sorting                            │   │
│   │   [✓] Tabgroup sorting                       │   │
│   │ [✓] Tabgroup coloring                        │   │
│   │ [✓] Age in group title                       │   │
│   └──────────────────────────────────────────────┘   │
│                                                      │
│ Transitions:                                         │
│                                                      │
│   [✓] Green → Yellow                                │
│       Transition time: [4] [hours ▼]                │
│       ▶ Details                                      │
│         Yellow group name: [________]                │
│                                                      │
│   [✓] Yellow → Red                                  │
│       Transition time: [8] [hours ▼]                │
│       ▶ Details                                      │
│         Red group name: [________]                   │
│                                                      │
│   [✓] Red → Gone                                    │
│       Transition time: [24] [hours ▼]               │
│       [✓] Bookmark closed tabs                      │
│       ▶ Details                                      │
│         Bookmark folder: [Closed Tabs]              │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Section 2: Auto-Tab-Groups

```
┌─ Auto-Tab-Groups ──────────────────────────────────┐
│ [✓] Create auto groups                              │
│                                                     │
│ [✓] Auto-name groups                                │
│     Delay: [5] minutes                              │
│                                                     │
│ (Note: these two toggles are independent siblings.  │
│  Disabling one does NOT grey out the other.)        │
└─────────────────────────────────────────────────────┘
```

## Interaction Contract

### Collapsible Sections
- Use `<details>/<summary>` HTML elements
- Default state: **collapsed** (no `open` attribute)
- Clicking the summary toggles visibility
- Collapsed state is NOT persisted (resets on page reload)

### Grey-out Behavior
- When a parent toggle is unchecked, all child controls receive the `disabled` attribute
- Grey-out is applied synchronously on toggle change (within the same event handler)
- Grey-out applies to: `<input>`, `<select>`, `<label>` (via CSS opacity)
- Disabled controls cannot be focused or interacted with
- Values of disabled controls are preserved (not cleared)

### Dependency Chain (parent → children)

```
agingEnabled →
  timeMode
  tabSortingEnabled
  tabgroupSortingEnabled
  tabgroupColoringEnabled
  showGroupAge
  greenToYellowEnabled →
    thresholds.greenToYellow
    yellowGroupName
    yellowToRedEnabled →
      thresholds.yellowToRed
      redGroupName
      redToGoneEnabled →
        thresholds.redToGone
        bookmarkEnabled →
          bookmarkFolderName

autoGroupEnabled (independent, no children)

autoGroupNamingEnabled (independent, sibling of autoGroupEnabled) →
  autoGroupNamingDelayMinutes
```

### Form Submission
- Save button persists ALL field values (including disabled/greyed-out fields)
- Threshold validation (green < yellow < red) applies only to enabled thresholds
- Success/error feedback message appears below the save button

### Settings Load
- On page load: read `v1_settings` from storage
- Populate all form fields with stored values
- Apply grey-out state based on current toggle values
- Collapse all detail sections

## CSS Classes

| Class | Purpose |
|-------|---------|
| `.section` | Top-level section container |
| `.section-header` | Section title |
| `.hierarchy-child` | Indented child control |
| `.hierarchy-grandchild` | Double-indented grandchild |
| `.disabled-group` | Visual grey-out (opacity, pointer-events) |
| `.detail-section` | Styling for `<details>` elements |
| `.transition-block` | Container for a single transition's controls |
