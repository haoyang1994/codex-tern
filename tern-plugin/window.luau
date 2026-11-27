local translate = require("./i18n")
local language = "en"
local function t(value) return translate(language, value) end
-- The client owns Codex RPC. This panel reads only its explicit list snapshot
-- and sends UI actions back through Tern; it never sends a prompt or starts Codex.
local PREFIX = "codex-tern.sessions/v1:"
local widths = require("./sidebar-width")
local reading = require("./reading-position")
local outline = require("./outline-panel")
local panels = {}
-- The conversation's tab label, by conversation pane, for the tab-title hook below.
local conversation_titles = {}
local timer = nil
local width_timer = nil
local fast_until = 0
local following_outline = false
local selection_seq = 0
local focused_tab = nil

local function bridge(cx, target)
  local ok, tree = pcall(function()
    return cx.session:surface(target, {root = "dock.sessions", nodes = 2, max_chars = 64000})
  end)
  if not ok or not tree or not tree.surface or tree.surface.role ~= "codex-tern" then return nil end
  local function find(node)
    if not node then return nil end
    if node.id == "dock.sessions" then return node end
    for _, child in node.c or {} do
      local found = find(child)
      if found then return found end
    end
    return nil
  end
  local node = find(tree.dock) or find(tree.main) or find(tree.layer)
  if not node or not node.p or not node.p.title then return nil end
  local decoded, snapshot = pcall(tern.json.decode, node.p.title)
  if not decoded or snapshot.version ~= 1 or type(snapshot.rows) ~= "table" then return nil end
  language = snapshot.language or "en"
  return {sf = tree.surface.id, snapshot = snapshot, raw = node.p.title}
end

local function send(cx, target, act, value)
  local state = bridge(cx, target)
  if not state then return false end
  cx.session:event(target, {sf = state.sf, ev = "action", id = "dock.sessions", act = act, value = value})
  return true
end


local function paint(cx, pane, entry, snapshot)
  local versions, reveals = {}, {}
  for _, item in snapshot.rows do
    if item.source == "omp" then continue end
    versions[item.id] = item.titleRevision or ""
    -- Opening or restoring a panel establishes a baseline without replaying effects.
    local previous = entry.title_versions and entry.title_versions[item.id]
    if previous ~= nil and item.titleRevision
      and (previous ~= item.titleRevision or (entry.title_reveals and entry.title_reveals[item.id] == item.titleRevision)) then
      reveals[item.id] = item.titleRevision
    end
  end
  entry.title_versions = versions
  entry.title_reveals = reveals
  local frame = tern.json.encode({snapshot = snapshot, selection = entry.selection, reveals = reveals, showArchived = entry.showArchived})
  if frame == entry.frame then return true end
  local surface = cx.session:surface(pane)
  if surface and surface.surface then
    cx.session:event(pane, {sf = surface.surface.id, ev = "action", act = "sync",
      value = frame})
    entry.frame = frame
    return true
  end
  return false
end

local function remember(cx)
  outline.remember(cx)
  for _, pane in cx.session:panes() do
    local record = tern.kv.get("sessions.block:" .. pane.pane)
    if record and not record.closed and type(record.target) == "number" and not panels[pane.pane] then
      panels[pane.pane] = {target = record.target, refreshed = 0}
    end
  end
  for _, canvas in cx.canvas:list() do
    if canvas.owner == tern.plugin.id and string.sub(canvas.about or "", 1, #PREFIX) == PREFIX then
      local target = tonumber(string.sub(canvas.about, #PREFIX + 1))
      if target then
        local pane = cx:new_block("codex-tern.sessions", {tostring(target)}, "over", {target = canvas.pane, focus = false})
        if pane then
          panels[canvas.pane] = nil
          panels[pane] = {target = target, refreshed = 0}
          cx.layout:close(canvas.pane)
        end
      end
    end
  end
end

local function update(cx, pane, entry)
  if not cx.session:pane(pane) then panels[pane] = nil; return end
  local state = bridge(cx, entry.target)
  if not state then
    if entry.raw ~= "closed" then
      local surface = cx.session:surface(pane)
      if surface and surface.surface then cx.session:event(pane, {sf = surface.surface.id,
        ev = "action", act = "sync", value = tern.json.encode({closed = true, language = language})}) end
      entry.raw = "closed"
      entry.snapshot = nil
      -- The closed placeholder replaced the list, even if recovery later loads
      -- an identical snapshot. The next live frame must rebuild that list.
      entry.view = nil
      entry.frame = nil
      entry.selection = nil
      entry.title_versions = nil
      entry.title_reveals = nil
    end
    return
  end
  entry.snapshot = state.snapshot
  local previous_selection = entry.selection
  if entry.selection then
    local selection = entry.selection
    local navigation = state.snapshot.navigation
    if not state.snapshot.connected
      or (navigation and navigation.request == selection.request and not navigation.pending) then
      entry.selection = nil
    elseif state.snapshot.navigationProtocol ~= 1 then
      -- Older running clients have no acknowledgement. Use their result instead.
      if state.snapshot.current == selection.id or (state.snapshot.error and state.snapshot.error ~= "")
        or tern.now() - selection.started > 90000 then entry.selection = nil end
      for _, item in state.snapshot.rows do
        if item.id == selection.id and item.locked then entry.selection = nil; break end
      end
    end
  end
  if state.raw ~= entry.raw or previous_selection ~= entry.selection then
    if paint(cx, pane, entry, state.snapshot) then entry.raw = state.raw end
  end
  if tern.now() - entry.refreshed > 15000 then
    send(cx, entry.target, "refresh")
    entry.refreshed = tern.now()
  end
  if tern.now() - (entry.locks_refreshed or 0) > 2000 then
    send(cx, entry.target, "locks")
    entry.locks_refreshed = tern.now()
  end
end

local function poll(fast)
  if fast then
    fast_until = tern.now() + 2000
    if timer then timer:cancel(); timer = nil end
  end
  if timer or (next(panels) == nil and not outline.any()) then return end
  local live = outline.live()
  for _, entry in panels do if entry.raw ~= "closed" then live = true; break end end
  if not live then return end
  -- Reading is continuous input too. Two 250ms polls (inspect, then paint)
  -- visibly trail the transcript, even when the geometry query itself is fast.
  timer = tern.timer(if tern.now() < fast_until or following_outline then 50 else 700, function(cx)
    timer = nil
    if cx then
      for pane, entry in panels do update(cx, pane, entry) end
      following_outline = outline.update(cx, bridge)
    end
    poll()
  end)
end

local function watch_widths()
  if width_timer or next(panels) == nil then return end
  -- Tern has no divider-change event. Keep this cheap layout check separate
  -- from content polling, including when the Codex client has been closed.
  width_timer = tern.timer(200, function(cx)
    width_timer = nil
    if cx then
      widths.sync(cx, panels)
      -- Tern caches tab titles, so know the conversation's label before a
      -- sidebar card is ever focused rather than learning it from the hook.
      for _, entry in panels do
        local target = entry.target
        local info = cx.session:pane(target)
        if info and info.title and info.title ~= "" then conversation_titles[target] = info.title end
      end
    end
    watch_widths()
  end)
end

local function open(cx, automatic_target)
  remember(cx)
  widths.sync(cx, panels)
  watch_widths()
  local focused = cx.session:focused()
  local target = automatic_target or (if focused and panels[focused] then panels[focused].target else focused)
  local tab = if focused then cx.session:tab_of(focused) else nil
  if not target or not bridge(cx, target) then
    target = nil
    for _, pane in cx.session:panes() do
      if pane.tab == tab and bridge(cx, pane.pane) then target = pane.pane; break end
    end
  end
  if not target then cx:toast("info", "Open Codex × Tern in this tab first."); return end
  local state = bridge(cx, target)
  for pane, entry in panels do
    if entry.target == target and cx.session:pane(pane) then
      send(cx, target, "refresh"); update(cx, pane, entry)
      if automatic_target then outline.open(cx, target, pane, state) end
      poll(true)
      return
    end
  end
  if not automatic_target then cx.layout:focus(target) end
  local pane = cx:new_block("codex-tern.sessions", {tostring(target)}, "beside", {focus = false})
  local err = "Host sessions block unavailable; reload the codex-tern plugin."
  if not pane then cx:toast("error", t("Could not open Codex sessions"), err); return end
  cx.layout:move(pane, target, "left", {focus = false})
  panels[pane] = {target = target, snapshot = state.snapshot, refreshed = tern.now(), locks_refreshed = tern.now()}
  paint(cx, pane, panels[pane], state.snapshot)
  widths.initialize(cx, pane, panels[pane], state.snapshot)
  if automatic_target then outline.open(cx, target, pane, state) end
  watch_widths()
  send(cx, target, "refresh")
  poll(true)
end

local function start_codex(cx, target, state)
  if not state or not state.snapshot.canSwitch then
    cx:toast("info", t("Wait for the Codex session to finish connecting."))
    return
  end
  if state.snapshot.newSessionProtocol == 1 then
    send(cx, target, "new")
  else
    cx.session:event(target, {sf = state.sf, ev = "action", id = "dock.nav.new", act = "click"})
  end
  cx.layout:focus(target)
  poll(true)
end

local function choose_engine(cx, entry, snapshot)
  if not snapshot.ompAvailable or cx.hosts:current().kind ~= "local" then
    start_codex(cx, entry.target, bridge(cx, entry.target))
    return
  end
  local cwd = snapshot.cwd
  cx:pick({placeholder = t("Choose a session engine"), icon = "plus", action = t("New session"), items = {
    {label = "Codex", icon = "app-codex", engine = "codex"},
    {label = "omp", icon = "app-omp", engine = "omp"},
  }}):next(function(choice, err, next_cx)
    if not next_cx or not choice or err then return end
    local state = bridge(next_cx, entry.target)
    if not state or state.snapshot.cwd ~= cwd or state.snapshot.selecting then return end
    if choice.engine == "codex" then
      start_codex(next_cx, entry.target, state)
    elseif choice.engine == "omp" then
      send(next_cx, entry.target, "omp-new")
      next_cx.layout:focus(entry.target)
      poll(true)
    end
  end)
end

tern.command({id = "new-session", title = "Codex: New session", icon = "plus", run = function(cx)
  for _, pane in cx.session:panes() do
    local target = pane.pane
    local state = bridge(cx, target)
    if state and state.snapshot.newSessionRequest then choose_engine(cx, {target = target}, state.snapshot); return end
  end
  local focused = cx.session:focused()
  local entry = focused and panels[focused]
  local state = focused and bridge(cx, focused)
  if entry and entry.snapshot then choose_engine(cx, entry, entry.snapshot)
  elseif state then choose_engine(cx, {target = focused}, state.snapshot) end
end})

tern.command({id = "sessions", title = "Codex: Sessions", icon = "history", run = function(cx)
  -- Startup requests identify their client explicitly, even if focus changed
  -- while Codex connected. The regular command can still reopen a closed rail.
  local requested = false
  for _, pane in cx.session:panes() do
    local state = bridge(cx, pane.pane)
    if state and state.snapshot.sidebarRequest then
      open(cx, pane.pane)
      requested = true
    end
  end
  if not requested then open(cx) end
end})

tern.command({id = "toc", title = "Codex: Session TOC", icon = "list", run = function(cx)
  remember(cx)
  local focused = cx.session:focused()
  local target = outline.target(focused) or (if focused and panels[focused] then panels[focused].target else focused)
  local tab = if focused then cx.session:tab_of(focused) else nil
  if not target or not bridge(cx, target) then
    target = nil
    for _, pane in cx.session:panes() do
      if pane.tab == tab and bridge(cx, pane.pane) then target = pane.pane; break end
    end
  end
  if not target then cx:toast("info", "Open Codex × Tern in this tab first."); return end
  local neighbour = nil
  for pane, entry in panels do if entry.target == target then neighbour = pane; break end end
  outline.open(cx, target, neighbour, bridge(cx, target)); poll(true)
end})

tern.command({id = "reading-position", title = "Codex: Reading position", available = function() return false end,
  run = function(cx)
    for _, pane in cx.session:panes() do
      local state = bridge(cx, pane.pane)
      local request = state and state.snapshot.readingRequest
      if request and type(request.token) == "string" then
        local function done(cx)
          send(cx, pane.pane, "reading-position", tern.json.encode({token = request.token}))
        end
        reading.restore(cx, pane.pane, request, function(cx)
          local latest = bridge(cx, pane.pane)
          return latest and latest.snapshot.readingRequest and latest.snapshot.readingRequest.token == request.token
            and (not request.threadId or (latest.snapshot.activeKey or latest.snapshot.current) == request.threadId)
        end, done)
      end
    end
  end})

tern.command({id = "reload", title = "Codex: Reload Window", icon = "app-codex", run = function(cx)
  remember(cx)
  local focused = cx.session:focused()
  local target = if focused and panels[focused] then panels[focused].target else focused
  local tab = if focused then cx.session:tab_of(focused) else nil
  if not target or not bridge(cx, target) then
    target = nil
    for _, pane in cx.session:panes() do
      if pane.tab == tab and bridge(cx, pane.pane) then target = pane.pane; break end
    end
  end
  if not target then cx:toast("info", "Open Codex × Tern in this tab first."); return end
  local state = bridge(cx, target)
  if state.snapshot.reloadProtocol ~= 1 then
    cx:toast("info", "This client needs one restart to enable window reload. Finish its tasks, then exit with Ctrl+Q and run codex-tern again.")
    return
  end
  send(cx, target, "reload")
end})

local function session_action(ev, cx)
  remember(cx)
  local entry = panels[ev.pane]
  if not entry then return true end
  local state = bridge(cx, entry.target)
  if ev.act == "omp-archives" and state then
    entry.showArchived = not entry.showArchived
    paint(cx, ev.pane, entry, state.snapshot)
  elseif ev.act == "omp-archive-disabled" then
    cx:toast("info", t("Finish this session’s task, pending input and draft before archiving."))
  elseif state and state.snapshot.ompAvailable and ev.value and
    (ev.act == "omp-resume" or ev.act == "omp-pin" or ev.act == "omp-archive" or ev.act == "omp-restore") then
    local restoring = ev.act == "omp-restore"
    local rows = if restoring then state.snapshot.ompArchived else state.snapshot.rows
    for _, row in rows or {} do
      if row.id == ev.value and (restoring or row.source == "omp") then
        if ev.act == "omp-archive" and not row.canArchive then
          cx:toast("info", t("Finish this session’s task, pending input and draft before archiving."))
        elseif not state.snapshot.selecting then
          send(cx, entry.target, ev.act, row.id)
          if ev.act == "omp-resume" or ev.act == "omp-archive" then cx.layout:focus(entry.target) end
          poll(true)
        end
        break
      end
    end
  elseif ev.act == "resume" and ev.value then
    if state then
      local found = false
      for _, row in state.snapshot.rows do
        if row.source ~= "omp" and row.id == ev.value and not row.locked then found = true; break end
      end
      if found then
        selection_seq += 1
        local request = tostring(tern.now()) .. ":" .. tostring(selection_seq)
        entry.selection = {id = ev.value, request = request, started = tern.now()}
        -- Show the pending destination immediately; the active row still matches
        -- the transcript and TOC until the client commits the session change.
        paint(cx, ev.pane, entry, state.snapshot)
        local value = if state.snapshot.navigationProtocol == 1
          then tern.json.encode({id = ev.value, request = request}) else ev.value
        send(cx, entry.target, "resume", value)
        cx.layout:focus(entry.target)
        poll(true)
      end
    end
  elseif ev.act == "pin" and ev.value then
    if state and state.snapshot.pinProtocol == 1 then
      for _, row in state.snapshot.rows do
        if row.source ~= "omp" and row.id == ev.value then send(cx, entry.target, "pin", row.id); poll(true); break end
      end
    end
  elseif ev.act == "new" and entry.snapshot then
    choose_engine(cx, entry, entry.snapshot)
  elseif ev.act == "refresh" then
    if state then send(cx, entry.target, "refresh") end
    poll(true)
  elseif (ev.act == "Rename session" or ev.act == t("Rename session")) then
    if state then
      for _, row in state.snapshot.rows do
        if ev.node == "main.sessions.codex:" .. row.id then
          if state.snapshot.renameProtocol ~= 1 then
            cx:toast("info", "Exit the Codex client with Ctrl+Q, then run codex-tern again to enable renaming sessions.")
          elseif not state.snapshot.canSwitch then
            cx:toast("info", t("Wait for the Codex session to finish connecting."))
          else
            send(cx, entry.target, "rename", row.id)
            cx.layout:focus(entry.target)
            poll(true)
          end
          break
        end
      end
    end
  elseif (ev.act == "Delete session" or ev.act == t("Delete session")) or (ev.act == "archive" and ev.value) then
    if state then
      for _, row in state.snapshot.rows do
        -- Menu labels stay readable; the keyed node identifies the clicked row.
        if row.source ~= "omp" and (((ev.act == "Delete session" or ev.act == t("Delete session")) and ev.node == "main.sessions.codex:" .. row.id)
          or (ev.act == "archive" and ev.value == row.id)) then
          if state.snapshot.archiveProtocol ~= 1 then
            cx:toast("info", "Exit the Codex client with Ctrl+Q, then run codex-tern again to enable deleting sessions.")
          elseif row.locked then
            cx:toast("info", t("This session is open in another client."))
          elseif not row.canArchive then
            cx:toast("info", t("Finish this session's task, answers, queue and draft before deleting."))
          else
            send(cx, entry.target, "archive", row.id)
            cx.layout:focus(entry.target)
            poll(true)
          end
          break
        end
      end
    end
  elseif ev.act == "archive-disabled" then
    cx:toast("info", if state and state.snapshot.archiveProtocol == 1
      then t("Finish this session's task, answers, queue and draft before deleting.")
      else "Exit the Codex client with Ctrl+Q, then run codex-tern again to enable deleting sessions.")
  elseif ev.act == "more" and state then send(cx, entry.target, "more"); poll(true) end
  -- Always consume owned clicks, including stale ones.
  return true
end

tern.on("canvas_action", function(ev, cx)
  remember(cx)
  if outline.action(ev, cx, bridge, send) then poll(true); return true end
  return session_action(ev, cx)
end)

-- Host BlockCx:open effects pass through this window route immediately; actions
-- do not wait for the business polling timer and never fall through to the OS.
tern.route.link(function(link, cx)
  local prefix = "codex-tern-internal://sessions/"
  if string.sub(link.url, 1, #prefix) ~= prefix then return nil end
  local ok, event = pcall(function()
    return tern.json.decode(tern.base64.decode(string.sub(link.url, #prefix + 1)))
  end)
  if ok and type(event) == "table" and event.pane == link.pane then
    session_action(event, cx)
  end
  return {handled = true}
end)

tern.on("pane_closed", function(ev, cx)
  conversation_titles[ev.pane] = nil
  outline.closed(ev.pane)
  local entry = panels[ev.pane]
  local key = "sessions.block:" .. ev.pane
  local record = tern.kv.get(key)
  if record then record.closed = true; tern.kv.set(key, record) end
  if entry then
    panels[ev.pane] = nil
    local retained = false
    for _, other in panels do if other.target == entry.target then retained = true; break end end
    if not retained then send(cx, entry.target, "hide") end
  end
  if next(panels) == nil then
    if width_timer then width_timer:cancel(); width_timer = nil end
    if timer and not outline.any() then timer:cancel(); timer = nil end
  end
end)

tern.on("focus", function(ev, cx)
  if focused_tab == ev.tab then return end
  focused_tab = ev.tab
  for pane, entry in panels do
    if cx.session:tab_of(pane) == ev.tab then
        send(cx, entry.target, "refresh")
      update(cx, pane, entry)
    end
  end
  poll(true)
end)

local function restore(cx)
  remember(cx)
  widths.sync(cx, panels)
  watch_widths()
  for pane, entry in panels do update(cx, pane, entry) end
  following_outline = outline.update(cx, bridge)
  poll()
end

local function sidebar_target(pane)
  return (panels[pane] and panels[pane].target) or outline.target(pane)
end

-- While a sidebar card has focus for that moment, label its tab with the
-- conversation's title instead of "Sessions" so the tab does not flicker.
-- Tabs without a Codex sidebar keep Tern's default label (nil).
if tern.chrome and tern.chrome.tab_title then
  tern.chrome.tab_title(function(tab)
    local target = sidebar_target(tab.pane)
    if target then return conversation_titles[target] end
    for _, entry in panels do
      if entry.target == tab.pane then conversation_titles[tab.pane] = tab.title; break end
    end
    return nil
  end)
end

tern.on("window_start", restore)
-- window_start runs once per plugin per window, not after every plugin reload.
-- A fresh VM must recover the existing canvases and restart their refresh timer.
tern.timer(0, function(cx) if cx then restore(cx) end end)

tern.on("unload", function()
  if timer then timer:cancel(); timer = nil end
  if width_timer then width_timer:cancel(); width_timer = nil end
end)
