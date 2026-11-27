# Using Codex × Tern

[Installation](../README.md#use-it) · [Writing proposals](proposals.md)

## Projects and sessions

It opens directly in Tern, or launches Tern from another terminal. A repository has one project instance per Tern profile and Codex home. Running the command again returns to that instance, including from another subfolder of the repository. Outside Git, the chosen folder is the project.

Each session keeps its own task, output, approvals, queue, model choices and draft. Start a task in one session, switch to another, and start another task. Both continue running. Stop affects the selected session.

Progress replies stay visible while a task runs. When it completes, its progress, thought summaries, plans and tool records collapse together, leaving the final reply expanded. Click the small duration label and arrow to review the full history; hover to see tool counts and error information. Completed tasks also start folded when you reopen the conversation or reload the interface.

Each session also remembers where you were reading, including when you only scroll through history. Switching back restores that message and reading line. A session left at the bottom keeps following new output. Reading positions survive interface reloads while the client stays open; they reset when the client exits. This uses the bundled Tern plugin.

Choose **More actions → New session model** to save a default for new sessions in every workspace. The setting survives a client restart. **Use Codex default** restores the model from Codex configuration. Changing this setting leaves existing sessions and running tasks alone; changing a session's model in the composer does not change the saved default. Resuming or forking a session keeps that session's model settings.

**Session details** shows the current model, reasoning effort, workspace and permissions. Session IDs, backend paths and diagnostics are under **Technical details**. Click the workspace name below the composer to choose a folder. The dialog shows its full path, supports **Browse**, and offers the saved new-session model. Invalid paths stay editable with an inline error.

Click **Fork from here** below a completed reply to continue that conversation in a new session. The fork includes history through that reply, including when later replies already exist. It inherits the source session's current model and reasoning effort. It keeps its initial title until your first new text prompt is accepted, then generates a new title from that prompt. A name you set manually takes precedence. It uses the same working directory and files; no Git worktree is created and no file changes are rolled back. The source keeps its later messages, task, queue and draft. The fork starts with an empty message box. **Open source** returns to the original session.

While a task runs, open the **Steer / Queue** selector to choose how to send your next message. **Steer** adds input to the current turn; **Queue** waits for that turn to finish. Opening or dismissing the choices keeps the current mode and draft. With no text or images to send, the composer shows only **Stop**; adding content also shows **Send**.

If a send times out or loses its reply, it appears as **Message delivery unconfirmed**. Check the conversation before marking it as received or moving it to the paused retry queue. The client does not resend it automatically. New text and attachments remain intact if an earlier send fails.

The native client saves each session's message draft, image paths, queue and unconfirmed messages locally. Reopening a project returns to its last selected session. Restored queues stay paused until you click **Run next**. An explicit initial prompt starts a new session; `resume THREAD_ID` opens the requested session. If the backend disconnects, click **Reconnect** above the composer to reload the conversation while keeping your draft. A session that cannot be opened leaves its draft intact and lets you select another session.

Task completion shows a small, dismissible reminder above the composer. A background session also gets a checkmark in the sidebar; **View** opens its result. Failed tasks have a warning mark. Stopping a task does not show a completion reminder, and a running queue reminds you after its final turn. Tern receives a quiet desktop notification with an unfocused-window preference; delivery follows Tern and system notification settings. Turn reminders on or off in **More actions**. No usage counters are added.

A prompt passed to a second invocation creates a new session in the existing project. Use `codex-tern resume THREAD_ID "your task"` to send it to a specific session. Explicit backend settings must match the open instance; exit it before changing those settings.

## Sessions sidebar

For a persistent sessions panel, register the bundled Tern plugin once:

```sh
codex-tern setup
```

Once the plugin is registered, the sessions sidebar opens automatically when the client starts. It reuses an existing sidebar and keeps focus in the composer. Closing it manually keeps it closed for that client run. To reopen it, use **Codex: Sessions** from Tern's command palette or run `codex-tern sessions` in the same Tern window. The sidebar shows sessions from the current folder, with activity times on hover. A spinner means a task is running; a bell means it needs input. A lock means another client owns that session. Locked rows cannot be selected and unlock automatically after the owner releases them.

Click **New session** above the sidebar list or **+** in the composer and choose **Codex** or **omp**. Both engines use the same conversation pane and sidebar for the current folder. Use the sidebar or **Ctrl+L** to switch sessions. The composer receives focus, and tasks and drafts in other sessions stay with their conversations.

Use `codex-tern --agent omp` to start a session or `codex-tern --agent omp --resume SESSION_ID` to open an existing one from its project. The CLI reuses an open project client. omp uses its configured model and its native confirmation flow. The chat supports text, streamed replies, tool activity, and stopping a turn. Codex's sandbox controls, model picker, forking, outline and message queue are available for Codex sessions.

Drag the sidebar divider to choose its width. The proportion is saved globally in your Tern profile and shared by all projects and windows. New windows and reopened sidebars use that proportion, including after a restart. Resizing the whole window preserves your choice. Before your first adjustment, new sidebars use a comfortable default width.

Right-click a session in the sidebar and choose **Delete session** to remove it from the list by moving it to Codex's archive. Running tasks, pending questions, queued messages and unsent drafts prevent deletion; choosing the action explains why it is unavailable. Deleting the selected session returns to an existing neighbour when available. Empty conversations stay out of history until their first message.

The same right-click menu has **Rename session**. Enter a name and press **Enter** or **Save name**; **Esc** cancels. You can rename a background or running session without switching to it. Saved names appear in both the sidebar and history picker and persist in Codex. A rejected name keeps the dialog open with the error and leaves the stored title unchanged.

Use the star on an omp row to pin or unpin it. Both engines sort pinned sessions first. Use **Archive session** on an omp row to hide it while keeping its saved conversation. **Archived omp sessions** expands a list with a **Restore session** button for each entry. Restoring returns the same session ID and its previous pin to the active list. Finish active work, answer any pending prompt and clear the draft before archiving.

Sessions sort by last conversation activity, newest first. Sending a message or completing a task moves that session up, including background tasks. Opening an old session alone does not move it to the top. Refresh and pagination preserve this activity order.

## Conversation tree

Click the branch icon at the right edge of a conversation to show its vertical tree. It starts collapsed. Only fork points have prompt labels; ordinary messages are omitted. Hover for more text. The tree uses the conversation's font and the native light or dark theme.

Click a fork point to jump straight to that prompt in the normal chat. Later replies remain available by scrolling. A shared ancestor stays in your selected branch when possible. Small dots at branch ends switch sessions at their last fork point; hover to see the session name. The same tree stays visible with the selected branch highlighted. Shared history appears once, and a new fork appears before its first new prompt. The map includes saved, non-archived forks. **Refresh** picks up branches created in another client. **Hide** folds the map back into its icon.

Opening and navigating the tree never calls a model. Your drafts, attachments, undo history and running tasks stay with their sessions. **Fork from here** below a completed reply uses the existing fork behavior, including for older prompts reached through the tree. Interface labels are English; prompt excerpts keep their original language.

## Session TOC

The **Session TOC** is a separate native card. It starts below **Sessions** and follows the selected conversation. Use its own drag handle and dividers to move or resize it anywhere in the layout. Closing either card leaves the other available. Reopen the outline with **Codex: Session TOC** in Tern's command palette.

As you scroll the conversation, the TOC highlights the first visible topic at the top of the reading area and keeps that entry visible in its card. At the live end, it follows the latest indexed prompt. A collapsed topic stays collapsed and highlights its parent instead. This uses the saved prompt links locally, with no model call or change to the conversation, draft, or keyboard focus.

New sessions build a topic index automatically after accepted prompts and finished replies. It helps find discussions across a long conversation. A single prompt stays one entry even when its reply has many sections. Related follow-ups share that entry. A later prompt that starts a separate problem gets a new topic; a distinct question developed later within a broad topic can get a subheading. The default is a short, flat list. The index can merge, split or rename entries as the discussion develops. Updated labels use a short, quiet wipe; reduced-motion settings disable it.

Click a heading to jump to its opening prompt, including older history that has not loaded yet. Every heading starts at a different prompt. The clicked heading stays selected until the reading position changes or new content arrives at the live end. **↩ N** cycles through later visits to the same topic, including when a child heading is active. The chevron folds a topic's subheadings. Your draft and running task stay intact. Previously generated outlines update once when opened in the updated client.

The TOC uses the same compact rows and neutral selection style as the session explorer. While another session opens, its row has a pending outline; the active row continues to match the transcript and TOC until loading finishes.

Older sessions and forks start with an empty card and **Get TOC**. This reads the saved conversation and enables future updates for that session. **⋯ → Rebuild TOC** reads the history again and creates a fresh structure. A failed update keeps the last usable outline and offers **Retry**.

A separate helper uses the session's model, with low reasoning effort when supported. It receives public prompts, finished replies, and the previous outline. Its instructions, summaries and results never enter the main conversation's context. It still uses model quota. Large histories require several bounded requests; rapid updates are combined. Images are represented as attachments, without sending their pixels to the helper.

Outlines are stored locally under the application state directory, in `codex-tern/outlines/`, separately from conversation history and drafts. They survive switches and restarts. Opening an unchanged indexed conversation does not make another model call.

This feature changes the controller as well as the interface. After updating and building, reload the Tern plugin and restart the client once after its tasks finish.

## Updating the client

After `bun run build`, choose **Developer: Reload Window** in **More actions**, or press **Ctrl+Shift+R**. This loads the latest interface and styles in the same pane. Running tasks, pending questions and selected answers, queues, session drafts, attachments and editor undo stay intact. A failed load keeps the previous interface available. If a paste, send or session action is in progress, finish that action before reloading; running model turns do not block reload.

With the bundled plugin installed, Tern's command palette also has **Codex: Reload Window**. `codex-tern reload` invokes that command in the current Tern window. The command works when either the client or its sidebar has focus. Run `tern plugin reload` after updating the plugin itself.

Clients started before window reload was added need one restart to gain the feature. Finish their tasks, press **Ctrl+Q**, then launch `codex-tern` once. Changes to the backend connection, controller, launcher or dependencies still need a client restart; window reload updates the interface. Keep the client open while tasks run, since local recovery cannot keep an exited backend working. Codex saves the conversation history.

On macOS, local recovery files live in `~/Library/Application Support/codex-tern/recovery/`. `XDG_STATE_HOME` overrides the state root. Files are private to your user and scoped by project, Tern profile and Codex home. They contain draft text and attachment paths; keep the original images or their pasted-image cache available. Plain text mode keeps its existing in-memory behavior.

## Language and appearance

Choose **More actions → Interface language** to switch between **English** and **简体中文**. The choice is saved under `codex-tern/preferences.json` in the application state directory and applies to new client launches in every workspace. Changing the language updates the current client and its sidebar immediately. Other open clients pick it up on restart. User messages, assistant replies, code, file paths and model names keep their original text.
The light theme uses an opaque white conversation background, frosted-glass sidebars, and pale gray user messages. The sessions and topic sidebars use a 50% light tint over Tern's window material. With **Liquid Glass** or **Glass**, the desktop's color shows through, as in Claude Code's sidebar. Hovered and selected rows darken by 5% and 9%, so they read on any wallpaper. The conversation and both sidebars keep their focused look when another pane has focus. Clicking a session moves focus back to the conversation, so Tern's gray unfocused veil would otherwise cover the sidebars most of the time. Other panes in the tab still dim when unfocused. Tern always focuses the card you click, so a sidebar click briefly focuses it; the plugin returns focus to the conversation before doing anything else, and the tab keeps the conversation's title meanwhile. Dark mode follows Tern's existing theme.

The conversation uses right-aligned user messages and a hover action to fork a reply. The sessions sidebar opens about 41 terminal cells wide, capped at 30% of the window; a manually chosen width is shared across windows. After rebuilding, use **Reload Window** to load the client styles. With the plugin installed, `tern plugin reload` also applies the shared styles to existing clients.

The client and sidebar use Tern's configured font family, font size and line metrics. Change them in Tern settings; no separate client font setting is required. The caret uses the same line metric as the input text.

Each session row has a small **×** button to archive it. Running tasks, pending questions, queues, unsent drafts and sessions locked by another client remain protected. Archiving the selected session opens an available ordinary neighbour, skipping the reserved Weixin Chief; when none remains, it creates a blank conversation.

## Files and writing

Assistant `codex-file-citation` directives render as clickable local file links, including in restored conversations and streaming replies. File names can contain Chinese, spaces and punctuation. Code examples keep the literal directive.

Click a local file link in a message to open it in Tern.

Paper revision proposals show two full passages, with red deletions in the original above and green additions in the suggestion below. Check the edits you want and click **Apply selected edits** to draft a request for Codex. The client computes the differences and Tern renders the text and formulas. See [the proposal format and a short AGENTS.md instruction](proposals.md).

Images can be pasted; the actions menu retains **Attach image** for entering a path. Copy a PDF or another document in Finder and paste it into the composer to insert a Markdown link, such as `[report.pdf](/path/to/report.pdf)`.

## Approvals

**Approve for me** is enabled by default. The official Codex backend reviews eligible approval requests automatically. Requests that still need your decision appear in Tern. Explicit `-c` settings take precedence; use `codex-tern -c 'approvals_reviewer="user"'` for manual approval. Session details show the active reviewer.

## Commands, skills and pinned sessions

Type `/` in the message composer to see commands. `/help` lists them. `/exit` and `/quit` close the client through its normal draft-saving flow; `/new`, `/resume [ID]`, `/model [ID]`, `/status`, `/stop` and `/language [en|zh-CN]` use the existing navigation and panels. Help and exit work while disconnected. Unknown commands remain in the composer with an error. Commands require a single line without attachments; paths, multiline messages and question answers keep their normal meaning. Plain mode shares the registry and retains its queue, recovery and reply commands.

Use `/skills [search]` or type `$` to find enabled skills for the current workspace. The picker shows backend paths to distinguish identical names. Selecting a skill inserts `$name` and binds its exact path; sending includes both the original text and the structured skill input. Drafts, queued messages and uncertain-send recovery preserve that binding along with attachments. A fresh lookup detects new skills; unavailable or ambiguous selected skills leave the message intact for correction. **Refresh skills** scans again. Scan errors appear in the picker. Queued/retried messages use their saved skill inputs.

Click **☆** beside a session to pin it; **★** marks a pinned session and removes the pin when clicked. Pinned sessions appear first, with the existing activity order preserved inside both groups. Pins persist as local preferences alongside language and default model. A session open in another client can be pinned without taking its writer lock. The adjacent **×** still archives the session; archived entries remain hidden even if previously pinned.

This update changes the retained controller and draft format. Existing clients need one restart after their current tasks finish; window reload alone cannot enable it. Run `tern plugin reload` to load updated sidebar controls. Building does not restart or interrupt an existing client.


## Context usage

The composer footer shows current context use, native capacity and percentage, for example `Context 48.2k / 200k · 24.1%`. Hover for exact token counts. Data comes from native usage updates, so it can fall after compaction and remains unknown until reported; it is not your cumulative task or subscription usage. The current visible conversation does not add a separate completion label or banner. Background notifications and unread session lights still work.
