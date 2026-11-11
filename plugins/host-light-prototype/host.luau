local beat = require("./beat")
-- Diagnostics are opt-in. They measure callbacks/view construction/render return,
-- not native screen presentation. They never create another timer or process.
local trace = tern.getenv("CT_HOST_LIGHT_TRACE") == "1"
local function emit(event, fields)
  if not trace then return end
  fields = fields or {}; fields.event = event; fields.clock = fields.clock or tern.now()
  tern.log.warn("HOST_LIGHT " .. tern.json.encode(fields))
end
local heartbeat = beat.new({now = tern.now, timer = tern.timer, panes = tern.pane.list,
  -- Closing a plugin pane can leave its id in host pane.list without pane_exited.
  -- The window's lifecycle hook marks that close; no window timer is involved.
  closed = function(pane) return tern.kv.get("light-pane:" .. pane) == "closed" end,
  detached = function(pane) tern.kv.set("light-pane:" .. pane, nil) end,
  render = function(cx) cx:render() end, emit = emit})
emit("entry", {context = tern.context, plugin = tern.plugin})

tern.block.define("light", {
  init = function(cx, args, saved)
    -- Saved business meaning survives; animation phase always joins the shared clock.
    local status = args[1] or (saved and saved.status) or "working"
    if not beat.labels[status] then status = "off" end
    local state = {status = status}
    tern.kv.set("light-pane:" .. cx.pane, "open")
    heartbeat.attach(state, cx)
    emit("init", {pane = cx.pane, status = status})
    return state
  end,
  title = function() return "后台单灯原型（合成状态）" end,
  view = function(state, cx)
    emit("view", {pane = cx.pane, status = state.status, lit = state.lit})
    local label = beat.labels[state.status]
    local controls = {}
    for _, status in ipairs({"working", "waiting", "permission", "failed", "completed", "off"}) do
      table.insert(controls, tern.ui.button(beat.labels[status], {actions = {click = "status=" .. status}}))
    end
    return {main = tern.ui.col({
      tern.ui.text("合成状态 · host 500ms 单灯原型"),
      {k = "row", p = {key = "status", gap = "sm"}, c = {
        {k = "el", p = {key = "lamp", tag = "span", role = "host-light.lamp",
          class = "ct-host-light ct-host-light-" .. state.status .. (state.lit and " ct-host-light-on" or ""),
          title = label, aria = label, attrs = {role = "img"}}},
        tern.ui.text(label),
      }},
      tern.ui.row(controls),
    })}
  end,
  event = function(state, ev, cx)
    if ev.ev == "action" and ev.act == "status" and beat.labels[ev.value] then
      heartbeat.set(cx.pane, ev.value)
      emit("status", {pane = cx.pane, status = state.status})
      -- Native block events render/save automatically; no additional manual render.
    end
  end,
  save = function(state) return {status = state.status} end,
})
tern.on("pane_exited", function(ev) heartbeat.remove(ev.pane) end)
tern.on("unload", function() heartbeat.dispose() end)
