# Changelog

Notable changes, newest first. This log starts with the update below.

## 2026-11-11

### Added

- Session rows use a single status light. Working rows share a host clock, so later-started sessions flash in phase; waiting, permission, completion and failure stay steady.
- Composer footer shows native context usage, capacity and percentage, with exact counts on hover and unknown values left blank until reported. Compatible UI reloads retain per-session estimates.

### Changed

- Opening a completed task's activity keeps individual commands folded. Open a command separately to inspect its output; reopening the activity starts with those commands folded again.
- Running command and tool groups use a small text label and trailing chevron without a full-width background. Counts remain available on hover, errors keep a warning icon, and details open on demand without an automatic live preview.
- Completed activity uses a small duration label and trailing chevron, with tool counts and error details available on hover instead of in a full-width bar.
- Completed tasks fold their progress replies, public summaries, plans and tools together, leaving the final reply expanded. Live progress stays visible, and the folded history can be reopened.
- Remove the standalone terminal-result label and redundant completion banner/toast for the currently visible conversation. Background reminders and read-aware sidebar lights remain available.

## 2026-11-10

### Added

- Session rows show compact traffic lights: flashing cyan while working, yellow while waiting for input, slow red while waiting for permission, steady green for unread completion, and fast red for unread failure. Reduced Motion keeps active lamps steady.
- Completion and failure lights clear only after interaction with that result's session and confirmation that its terminal result is visible. Background completion, returning to an old open pane, refresh and UI reload preserve unread results.
- English and Simplified Chinese interfaces, slash commands, dynamic skill selection and pinned sessions. Typography follows Tern settings.
- Native owners can connect loaded Codex conversations to the fixed Weixin Chief through the workbench's private relay, with directed messages, single-use approvals and question replies.

### Fixed

- Assistant progress and commentary stay outside collapsed command/tool blocks, preserving their chronological order.
- Reserved Weixin Chief sessions cannot be resumed or modified by desktop clients; selected-session archiving skips them when choosing a replacement. Native RPC shutdown confirms that its owned process group has exited.
- Ordinary Copy uses the native text selection; copying the complete Markdown or code/output is a separately named context-menu action.

## 2026-10-28

### Changed

- Running turns show OMP's animated working indicator, elapsed time, and shimmering label above the message box.

## 2026-10-27

### Added

- The session TOC follows the current reading position and keeps the active heading visible. Collapsed topics stay collapsed and highlight their parent.

### Changed

- Projects open the sessions sidebar while the selected conversation loads.
- The first session list loads from the index, then refreshes in the background to update stale details and find missing sessions.
- Account details load in the background, so conversations can become usable before those details arrive.
- The TOC matches the session explorer's compact rows, muted headings and neutral selection background. Long outlines fit the card as it resizes.

### Fixed

- The TOC follows scrolling promptly, keeps the first topic highlighted at fork banners and history controls, and advances when the previous reply's prose leaves the screen. Selected rows stay fully visible above the card's bottom area, including with enlarged fonts.
- The TOC indexes discussion topics across prompts. One prompt with a long reply stays one entry, related follow-ups stay grouped, and reply sections no longer fill the card. Older saved outlines rebuild with the new rules when opened.
- Clicking a TOC heading keeps it selected until the reading position changes, including short conversations and headings that share a prompt.
- Short prompts keep their reading highlight until they leave the top of the viewport.
- Topic return buttons advance correctly when the active prompt belongs to a child heading.
- Opening a session marks its row as pending while the active highlight stays aligned with the current transcript and TOC.
- Clicking **Load more** during the initial background refresh keeps the request and uses the updated page position.
- Account replies from an old connection no longer overwrite current account details.
- Session-list replies from a previous folder or connection are ignored.
