local translate = require("./i18n")
local traffic = require("./traffic-light")
return function(snapshot, selection, reveals, lit)
  local function t(value) return translate(snapshot.language, value) end
  local rows = {}
  local current = snapshot.current
  local folder = string.match(snapshot.cwd or "", "([^/]+)/*$") or snapshot.cwd or t("Sessions")
  table.insert(rows, {k = "text", p = {key = "folder", role = "codex-tern.sessions.folder", text = folder, title = snapshot.cwd}})
  table.insert(rows, {k = "row", p = {key = "new", role = "codex-tern.sessions.new", align = "center", gap = "sm",
    title = t("New session · Ctrl+Shift+N"), mark = if snapshot.canSwitch then nil else "disabled",
    actions = if snapshot.canSwitch then {click = "new"} else nil}, c = {
      {k = "icon", p = {key = "icon", name = "plus"}},
      {k = "text", p = {key = "label", text = t("New session")}},
    }})
  for _, item in snapshot.rows do
    local locked = item.locked and item.id ~= snapshot.current
    local status = traffic.status(snapshot, item)
    local status_text = if status == "working" then t("Working") elseif status == "waiting" then t("Needs your input")
      elseif status == "permission" then t("Waiting for permission")
      elseif status == "failed" then t("Task failed · Open to review") elseif status == "completed" then t("Task complete · Unread") else t("Lights off")
    local reveal = reveals and item.titleRevision and reveals[item.id] == item.titleRevision
    local title = {k = "row", p = {key = "heading", align = "center", gap = "sm"}, c = {
      {k = "col", p = {key = "title", role = "codex-tern.sessions.title",
        title = item.title .. "\n" .. item.time, grow = 1}, c = {
        {k = "col", p = {key = if reveal then "reveal:" .. item.titleRevision else "label",
          role = "codex-tern.sessions.reveal", mark = if reveal then "reveal" else nil}, c = {
          {k = "text", p = {key = "text", role = "codex-tern.sessions.label", text = item.title, lines = 1}},
        }},
      }},
    }}
    if locked then
      table.insert(title.c, {k = "icon", p = {key = "status", name = "lock", role = "codex-tern.sessions.lock", title = t("Open in another client")}})
    end
    table.insert(title.c, 1, {k = "el", p = {key = "traffic", tag = "span", role = "codex-tern.sessions.traffic",
      class = "ct-session-traffic ct-session-" .. status .. (if status == "working" and lit == false then " ct-session-dim" else ""), title = status_text, aria = status_text,
      attrs = {["role"] = "img"}}})
    local can_archive = snapshot.archiveProtocol == 1 and item.canArchive and not locked
    if snapshot.pinProtocol == 1 then
      table.insert(title.c, {k = "el", p = {key = "pin", tag = "button", role = "codex-tern.sessions.pin",
        aria = if item.pinned then t("Unpin session") else t("Pin session"),
        title = if item.pinned then t("Unpin session") else t("Pin session"),
        mark = if item.pinned then "pinned" else nil, attrs = {["aria-pressed"] = if item.pinned then "true" else "false"},
        actions = {click = "pin=" .. item.id}}, c = {
          {k = "text", p = {key = "icon", text = if item.pinned then "★" else "☆"}},
        }})
    end
    table.insert(title.c, {k = "el", p = {key = "archive", tag = "button", role = "codex-tern.sessions.archive",
      aria = t("Archive session"), title = if can_archive then t("Archive session") else t("Session cannot be archived yet"),
      mark = if can_archive then nil else "disabled", attrs = {["aria-disabled"] = if can_archive then "false" else "true"},
      actions = {click = "archive=" .. item.id}}, c = {
        {k = "icon", p = {key = "icon", name = "x"}},
      }})
    local body = {title}
    table.insert(rows, {k = "col", p = {key = item.id, role = "codex-tern.sessions.item",
      aria = item.title .. (if status_text then " · " .. status_text else ""),
      mark = if item.id == current then "pick" elseif locked then "locked"
        elseif selection and item.id == selection.id then "pending" else nil,
      title = item.title, actions = {click = if locked then nil else "resume=" .. item.id,
        menu = {t("Rename session"), t("Delete session")}}}, c = body})
  end
  local note = snapshot.error
  if note == nil or note == "" then
    if snapshot.connecting then note = t("Connecting…")
    elseif not snapshot.connected then note = t("Codex disconnected.")
    elseif selection and selection.id ~= current then note = t("Opening session…")
    elseif snapshot.loading and #snapshot.rows == 0 then note = t("Loading…")
    elseif #snapshot.rows == 0 then note = t("No sessions in this folder.")
    elseif not snapshot.canSwitch then note = snapshot.blockedReason end
  end
  -- Keep the keyed structure stable while a switch is in flight.
  table.insert(rows, {k = "text", p = {key = "note", role = "codex-tern.sessions.note",
    hidden = not note or note == "", tone = "muted", text = note or ""}})
  if snapshot.more then
    table.insert(rows, {k = "text", p = {key = "more", role = "codex-tern.sessions.note", text = t("Load more"), actions = {click = "more"}}})
  end
  return {k = "col", p = {key = "sessions", role = "codex-tern.sessions"}, c = rows}
end
