-- One host timer for every sessions block. Business snapshot delivery is separate.
local beat = {}
function beat.new(api)
  local entries, timer, generation, unloaded = {}, nil, 0, false
  local function emit(event, fields) if api.emit then api.emit(event, fields or {}) end end
  local function phase() return math.floor(api.now() / 500) % 2 == 0 end
  local function active()
    for _, e in pairs(entries) do if e.state.running then return true end end
    return false
  end
  local function cancel(reason)
    generation = generation + 1
    if timer then timer:cancel(); timer = nil; emit("cancel", {reason = reason}) end
  end
  local schedule
  schedule = function()
    if timer or unloaded or not active() then return end
    local now = api.now(); local due = (math.floor(now / 500) + 1) * 500
    local token = generation
    timer = api.timer(due - now, function()
      if unloaded or generation ~= token then return end
      timer = nil; local on = phase()
      emit("tick", {due = due, late = api.now() - due})
      for pane, e in pairs(entries) do
        if api.closed(pane) then
          entries[pane] = nil; api.detach(pane); emit("detach", {pane = pane})
        elseif e.state.running and e.state.lit ~= on then
          e.state.lit = on; api.render(e.cx)
          emit("render_return", {pane = pane, lit = on})
        end
      end
      schedule()
    end)
  end
  local controller = {}
  function controller.attach(state, cx)
    assert(not unloaded, "sessions heartbeat unloaded")
    entries[cx.pane] = {state = state, cx = cx}; state.lit = phase(); schedule()
  end
  function controller.changed(pane)
    local e = entries[pane]; if not e or unloaded then return end
    e.state.lit = phase()
    if not active() then cancel("no running rows") end
    schedule()
  end
  function controller.remove(pane)
    if not entries[pane] then return end
    entries[pane] = nil; api.detach(pane)
    if not active() then cancel("pane exited") end
  end
  function controller.dispose()
    unloaded = true; cancel("unload")
    for pane in pairs(entries) do api.detach(pane) end
    entries = {}; emit("disposed")
  end
  return controller
end
return beat
