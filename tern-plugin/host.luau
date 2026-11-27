local view = require("./sessions-view")
local traffic = require("./traffic-light")
local translate = require("./i18n")
local trace = tern.getenv("CT_SESSION_LIGHT_TRACE") == "1"
local function emit(event, fields)
  if not trace then return end
  fields = fields or {}; fields.event = event; fields.clock = tern.now()
  tern.log.warn("SESSION_LIGHT " .. tern.json.encode(fields))
end
local function key(pane) return "sessions.block:" .. pane end
local heartbeat = require("./session-beat").new({
  now = tern.now, timer = tern.timer,
  closed = function(pane)
    local record = tern.kv.get(key(pane)); return not record or record.closed == true
  end,
  detach = function(pane) tern.kv.set(key(pane), nil) end,
  render = function(cx) cx:render() end, emit = emit,
})
local function running(snapshot)
  for _, row in ipairs(snapshot and snapshot.rows or {}) do
    if traffic.status(snapshot, row) == "working" then return true end
  end
  return false
end
tern.block.define("sessions", {
  init = function(cx, args, saved)
    local target = tonumber(args[1]) or (saved and saved.target)
    assert(target, "sessions block needs a client pane")
    local snapshot = saved and saved.snapshot
    local state = {target = target, snapshot = snapshot, running = running(snapshot)}
    tern.kv.set(key(cx.pane), {target = target})
    heartbeat.attach(state, cx); emit("init", {pane = cx.pane, target = target})
    return state
  end,
  title = function(state) return translate(state.snapshot and state.snapshot.language, "Sessions") end,
  view = function(state, cx)
    emit("view", {pane = cx.pane, lit = state.lit, running = state.running})
    local content = if state.snapshot then view(state.snapshot, state.selection, state.reveals, state.lit, state.showArchived)
      else tern.ui.text(translate(state.language, if state.closed then "The Codex client is closed." else "Loading…"))
    -- Keep the original main.sessions.<row> action IDs, native diff and scroll keys.
    return {main = tern.ui.col({content})}
  end,
  event = function(state, ev, cx)
    if ev.ev ~= "action" then return end
    if ev.act == "sync" then
      local ok, data = pcall(tern.json.decode, ev.value or "")
      if not ok or type(data) ~= "table" then return end
      if data.snapshot and (data.snapshot.version ~= 1 or type(data.snapshot.rows) ~= "table") then return end
      state.snapshot, state.selection, state.reveals = data.snapshot, data.selection, data.reveals
      state.closed, state.language, state.showArchived = data.closed, data.language, data.showArchived
      state.running = running(state.snapshot); heartbeat.changed(cx.pane)
      emit("sync", {pane = cx.pane, running = state.running})
    else
      -- Route the actual click back to the window half, which rechecks the live
      -- client snapshot and retains the established navigation/permission guards.
      local payload = {pane = cx.pane, act = ev.act, value = ev.value, node = ev.id}
      cx:open("codex-tern-internal://sessions/" .. tern.base64.encode(tern.json.encode(payload), {url = true}))
      emit("action", {pane = cx.pane, act = ev.act})
    end
  end,
  save = function(state) return {target = state.target, snapshot = state.snapshot} end,
})
tern.on("pane_exited", function(ev) heartbeat.remove(ev.pane) end)
tern.on("unload", function() heartbeat.dispose() end)
