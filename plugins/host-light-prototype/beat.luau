-- One host-owned heartbeat shared by every prototype block. No window context.
local beat = {}
-- Minimal scope: only running work flashes. Other meanings keep a steady color.
local flashing = {working = true}
beat.labels = {working = "运行中", waiting = "等待输入", permission = "等待权限",
  failed = "失败待查看", completed = "完成未读", off = "已读或未运行"}

function beat.status(snapshot, item)
  if item.locked and item.id ~= snapshot.current then return "off" end
  if item.waiting then
    if item.permission then return "permission" end
    return "waiting"
  end
  if item.running then return "working" end
  if item.failed then return "failed" end
  if item.completed then return "completed" end
  return "off"
end

function beat.new(api)
  local entries, timer, generation, disposed = {}, nil, 0, false
  local period = 500
  local controller = {}
  local function emit(event, fields)
    if api.emit then api.emit(event, fields or {}) end
  end
  local function phase() return math.floor(api.now() / period) % 2 == 0 end
  local function lit(status) return status ~= "off" and (not flashing[status] or phase()) end
  local function active()
    for _, entry in pairs(entries) do
      if flashing[entry.state.status] then return true end
    end
    return false
  end
  local function cancel(reason)
    generation = generation + 1
    if timer then timer:cancel(); timer = nil; emit("cancel", {reason = reason}) end
  end
  local schedule
  schedule = function()
    if disposed or timer or not active() then return end
    local now = api.now()
    local due = (math.floor(now / period) + 1) * period
    local token = generation
    timer = api.timer(due - now, function()
      if disposed or token ~= generation then return end
      timer = nil
      local at = api.now()
      emit("tick", {clock = at, due = due, late = at - due})
      -- pane_closed is window-only. Check host membership once per shared tick,
      -- so closing the final pane releases its captured cx even without an exit hook.
      local live = {}
      for _, pane in ipairs(api.panes()) do live[pane.pane] = true end
      for pane, entry in pairs(entries) do
        if not live[pane] or (api.closed and api.closed(pane)) then
          entries[pane] = nil; emit("detach", {pane = pane, reason = "closed"})
          if api.detached then api.detached(pane) end
        elseif flashing[entry.state.status] then
          local on = lit(entry.state.status)
          if entry.state.lit ~= on then
            entry.state.lit = on
            api.render(entry.cx) -- BlockCx:render(), never a window canvas update.
            emit("render_return", {pane = pane, status = entry.state.status, lit = on})
          end
        end
      end
      schedule()
    end)
    emit("arm", {due = due})
  end
  function controller.attach(state, cx)
    assert(not disposed, "heartbeat is unloaded")
    entries[cx.pane] = {state = state, cx = cx}
    state.lit = lit(state.status)
    schedule()
  end
  function controller.set(pane, status)
    assert(beat.labels[status], "unknown light status")
    local entry = entries[pane]
    if not entry or disposed then return false end
    entry.state.status, entry.state.lit = status, lit(status)
    if not active() then cancel("no flashing states") end
    schedule()
    return true
  end
  function controller.remove(pane)
    entries[pane] = nil
    if api.detached then api.detached(pane) end
    if not active() then cancel("pane exited") end
    emit("detach", {pane = pane, reason = "exited"})
  end
  function controller.dispose()
    disposed = true; cancel("unload")
    if api.detached then for pane in pairs(entries) do api.detached(pane) end end
    entries = {}
    emit("disposed")
  end
  return controller
end
return beat
