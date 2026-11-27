local translate = require("./i18n")
local traffic = require("./traffic-light")
return function(snapshot, selection, reveals, lit, showArchived)
  local function t(value) return translate(snapshot.language, value) end
  local rows = {}
  local folder = string.match(snapshot.cwd or "", "([^/]+)/*$") or snapshot.cwd or t("Sessions")
  table.insert(rows, {k = "row", p = {key = "project", role = "codex-tern.sessions.project", align = "center"}, c = {
    {k = "text", p = {key = "folder", role = "codex-tern.sessions.folder", text = folder, title = snapshot.cwd, lines = 1, grow = 1}},
    {k = "el", p = {key = "refresh", role = "codex-tern.sessions.refresh", tag = "button",
      title = t("Refresh sessions"), aria = t("Refresh sessions"), actions = {click = "refresh"}}, c = {
        {k = "icon", p = {key = "icon", name = "refresh"}},
      }},
  }})
  local canNew = not snapshot.selecting and (snapshot.canSwitch or snapshot.ompAvailable)
  table.insert(rows, {k = "el", p = {key = "new", role = "codex-tern.sessions.new", tag = "button",
    aria = t("New session"), mark = if canNew then nil else "disabled",
    attrs = {["aria-disabled"] = if canNew then "false" else "true"},
    actions = if canNew then {click = "new"} else nil}, c = {
      {k = "icon", p = {key = "icon", name = "plus"}},
      {k = "text", p = {key = "label", text = t("New session")}},
    }})
  for _, item in snapshot.rows do
    local isOmp = item.source == "omp"
    local selected = if isOmp then snapshot.ompCurrent == item.id
      else not snapshot.showingOmp and snapshot.current == item.id
    local engine = if isOmp then "omp" else "Codex"
    local key = if isOmp then "omp:" .. item.id else "codex:" .. item.id
    local name = if isOmp and (not item.title or item.title == "" or item.title == "New omp session") then t("New omp session") else item.title
    local detail = if isOmp then item.id else item.time
    local locked = item.locked and (isOmp or item.id ~= snapshot.current)
    local status = traffic.status(snapshot, item)
    local status_text = if status == "working" then t("Working") elseif status == "waiting" then t("Needs your input")
      elseif status == "permission" then t("Waiting for permission")
      elseif status == "failed" then t("Task failed · Open to review") elseif status == "completed" then t("Task complete · Unread") else t("Lights off")
    local reveal = not isOmp and reveals and item.titleRevision and reveals[item.id] == item.titleRevision
    local title = {k = "row", p = {key = "heading", role = "codex-tern.sessions.line", align = "center"}, c = {
      {k = "icon", p = {key = "source", name = if isOmp then "app-omp" else "provider-openai",
        role = "codex-tern.sessions.source", mark = if isOmp then "omp" else "codex", title = engine}},
      {k = "el", p = {key = "traffic", tag = "span", role = "codex-tern.sessions.traffic",
        class = "ct-session-traffic ct-session-" .. status .. (if status == "working" and lit == false then " ct-session-dim" else ""), title = status_text, aria = status_text,
        attrs = {["role"] = "img"}}},
      {k = "col", p = {key = "title", role = "codex-tern.sessions.title",
        title = name .. "\n" .. engine .. (if detail and detail ~= "" then " · " .. detail else ""), grow = 1}, c = {
        {k = "col", p = {key = if reveal then "reveal:" .. item.titleRevision else "label",
          role = "codex-tern.sessions.reveal", mark = if reveal then "reveal" else nil}, c = {
          {k = "text", p = {key = "text", role = "codex-tern.sessions.label", text = name, lines = 1}},
        }},
      }},
    }}
    if locked then
      table.insert(title.c, {k = "icon", p = {key = "status", name = "lock", role = "codex-tern.sessions.lock", title = t("Open in another client")}})
    end
    local can_archive = snapshot.archiveProtocol == 1 and item.canArchive and not locked
    if snapshot.pinProtocol == 1 then
      table.insert(title.c, {k = "el", p = {key = "pin", tag = "button", role = "codex-tern.sessions.pin",
        aria = if item.pinned then t("Unpin session") else t("Pin session"),
        title = if item.pinned then t("Unpin session") else t("Pin session"),
        mark = if item.pinned then "pinned" else nil, attrs = {["aria-pressed"] = if item.pinned then "true" else "false"},
        actions = {click = (if isOmp then "omp-pin=" else "pin=") .. item.id}}, c = {
          {k = "text", p = {key = "icon", text = if item.pinned then "★" else "☆"}},
        }})
    end
    table.insert(title.c, {k = "el", p = {key = "archive", tag = "button", role = "codex-tern.sessions.archive",
      aria = t("Archive session"), title = if can_archive then t("Archive session") else t("Session cannot be archived yet"),
      mark = if can_archive then nil else "disabled", attrs = {["aria-disabled"] = if can_archive then "false" else "true"},
      actions = {click = (if isOmp then "omp-archive=" else "archive=") .. item.id}}, c = {
        {k = "icon", p = {key = "icon", name = "x"}},
      }})
    table.insert(rows, {k = "col", p = {key = key, role = "codex-tern.sessions.item",
      aria = name .. " · " .. engine .. " · " .. status_text,
      attrs = {["aria-current"] = if selected then "true" else "false"},
      mark = if selected then "pick" elseif locked then "locked"
        elseif not isOmp and selection and item.id == selection.id then "pending" else nil,
      title = name, actions = {click = if locked then nil elseif isOmp then "omp-resume=" .. item.id else "resume=" .. item.id,
        menu = if isOmp then nil else {t("Rename session"), t("Delete session")}}}, c = {title}})
  end
  local note = snapshot.error
  if note == nil or note == "" then
    if snapshot.selecting then note = snapshot.blockedReason
    elseif snapshot.connecting and not snapshot.showingOmp then note = t("Connecting…")
    elseif not snapshot.connected and not snapshot.showingOmp then note = t("Codex disconnected.")
    elseif selection and selection.id ~= snapshot.current then note = t("Opening session…")
    elseif snapshot.loading and #snapshot.rows == 0 then note = t("Loading…")
    elseif #snapshot.rows == 0 then note = t("No sessions in this folder.")
    elseif not snapshot.canSwitch and not snapshot.showingOmp then note = snapshot.blockedReason end
  end
  -- Keep the keyed structure stable while a switch is in flight.
  table.insert(rows, {k = "text", p = {key = "note", role = "codex-tern.sessions.note",
    hidden = not note or note == "", tone = "muted", text = note or ""}})
  if snapshot.more then
    table.insert(rows, {k = "text", p = {key = "more", role = "codex-tern.sessions.note", text = t("Load more"), actions = {click = "more"}}})
  end
  if snapshot.ompArchived and (#snapshot.ompArchived > 0 or showArchived) then
    table.insert(rows, {k = "el", p = {key = "archives", tag = "button", role = "codex-tern.sessions.archives",
      aria = t("Archived omp sessions"), attrs = {["aria-expanded"] = if showArchived then "true" else "false"},
      actions = {click = "omp-archives"}}, c = {
        {k = "icon", p = {key = "icon", name = "history"}},
        {k = "text", p = {key = "label", text = t("Archived omp sessions")}},
      }})
    if showArchived then
      for _, item in snapshot.ompArchived do
        local name = if item.title == "New omp session" then t(item.title) else item.title
        table.insert(rows, {k = "col", p = {key = "archived:" .. item.id, role = "codex-tern.sessions.archived"}, c = {
          {k = "row", p = {key = "heading", align = "center", role = "codex-tern.sessions.line"}, c = {
            {k = "icon", p = {key = "source", name = "app-omp"}},
            {k = "text", p = {key = "label", text = name, title = item.id, grow = 1, lines = 1}},
            {k = "el", p = {key = "restore", tag = "button", role = "codex-tern.sessions.restore",
              aria = t("Restore session") .. " · " .. name, title = t("Restore session"),
              actions = {click = "omp-restore=" .. item.id}}, c = {
                {k = "text", p = {key = "label", text = t("Restore session")}},
              }},
          }},
        }})
      end
    end
  end
  return {k = "col", p = {key = "sessions", role = "codex-tern.sessions"}, c = rows}
end
