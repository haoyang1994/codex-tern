-- Controlled clock for lifecycle/semantic tests only; not realtime evidence.
local beat = dofile('plugins/host-light-prototype/beat.luau')
local passed = 0
local function check(name, fn) fn(); passed = passed + 1; print('PASS ' .. name) end
local function fixture()
  local now, timers, renders, panes, events, closed = 0, {}, {}, {}, {}, {}
  local api = {
    now = function() return now end,
    timer = function(ms, fn)
      local t = {due = now + ms, fn = fn, cancel = function(self) self.cancelled = true end}
      table.insert(timers, t); return t
    end,
    panes = function()
      local result = {}; for pane in pairs(panes) do table.insert(result, {pane = pane}) end
      return result
    end,
    render = function(cx) table.insert(renders, {pane = cx.pane, lit = cx.state.lit}) end,
    closed = function(pane) return closed[pane] end,
    detached = function(pane) closed[pane] = nil end,
    emit = function(name, fields) table.insert(events, {name = name, fields = fields}) end,
  }
  local controller = beat.new(api)
  local function attach(pane, status)
    local state = {status = status}; panes[pane] = true
    controller.attach(state, {pane = pane, state = state}); return state
  end
  local function advance(at)
    now = at
    local t = timers[#timers]; assert(not t.cancelled and not t.fired)
    t.fired = true; t.fn()
  end
  return {controller = controller, timers = timers, renders = renders, events = events,
    panes = panes, closed = closed, attach = attach, advance = advance}
end

check('business priority: running/read overlap, waits, permissions, locks and unread result', function()
  local s = {current = 'current'}
  assert(beat.status(s, {running = true, completed = true}) == 'working')
  assert(beat.status(s, {running = true, waiting = true}) == 'waiting')
  assert(beat.status(s, {waiting = true, permission = true}) == 'permission')
  assert(beat.status(s, {locked = true, id = 'other', running = true}) == 'off')
  assert(beat.status(s, {locked = true, id = 'current', running = true}) == 'working')
  assert(beat.status(s, {failed = true, completed = true}) == 'failed')
  assert(beat.status(s, {completed = true}) == 'completed')
  assert(beat.status(s, {}) == 'off')
end)
check('one shared timer changes both lamps; late joins share the current phase', function()
  local f = fixture(); local a = f.attach(1, 'working')
  assert(a.lit and #f.timers == 1 and f.timers[1].due == 500)
  f.advance(500); assert(not a.lit and #f.renders == 1)
  local b = f.attach(2, 'working'); assert(not b.lit and #f.timers == 2)
  f.advance(1000); assert(a.lit and b.lit and #f.renders == 3 and #f.timers == 3)
end)
check('stop cancels final heartbeat, preserves completion and ignores a queued stale callback', function()
  local f = fixture(); local a = f.attach(1, 'working'); local pending = f.timers[1]
  f.controller.set(1, 'completed')
  assert(a.lit and a.status == 'completed' and pending.cancelled)
  pending.fn(); assert(#f.timers == 1 and #f.renders == 0)
  f.controller.set(1, 'off'); assert(not a.lit and #f.timers == 1)
  f.controller.set(1, 'working'); assert(#f.timers == 2)
  pending.fn(); assert(#f.timers == 2 and #f.renders == 0)
end)
check('stopping one block keeps the other running; last exit cancels', function()
  local f = fixture(); f.attach(1, 'working'); local b = f.attach(2, 'working')
  f.controller.set(1, 'completed'); assert(not f.timers[1].cancelled)
  f.advance(500); assert(not b.lit and #f.renders == 1 and f.renders[1].pane == 2)
  f.controller.remove(2); assert(f.timers[2].cancelled)
end)
check('host membership pruning closes final active block without another tick or render', function()
  local f = fixture(); f.attach(1, 'working'); f.panes[1] = nil
  f.advance(500); assert(#f.timers == 1 and #f.renders == 0)
end)
check('window close marker prunes a retained host pane id and releases the shared timer', function()
  local f = fixture(); f.attach(1, 'working'); f.closed[1] = true
  f.advance(500); assert(#f.timers == 1 and #f.renders == 0 and f.closed[1] == nil)
end)
check('non-running meanings are steady and stop the timer even on failure or input waits', function()
  for _, status in ipairs({'waiting', 'permission', 'failed', 'completed'}) do
    local f = fixture(); local a = f.attach(1, 'working')
    f.controller.set(1, status); assert(a.lit and f.timers[1].cancelled)
  end
end)
check('unload cancels, drops contexts and prevents stale callback resurrection', function()
  local f = fixture(); f.attach(1, 'working'); f.controller.dispose()
  assert(f.timers[1].cancelled); f.timers[1].fn()
  assert(#f.timers == 1 and #f.renders == 0 and not f.controller.set(1, 'working'))
  assert(not pcall(function() f.attach(2, 'working') end))
end)
check('late dispatch skips missed phases without a callback storm and realigns deadline', function()
  local f = fixture(); local a = f.attach(1, 'working')
  f.advance(1875); assert(not a.lit and #f.renders == 1 and f.timers[2].due == 2000)
end)
print('Passed ' .. passed .. ' controlled-clock tests (not wall-clock evidence).')
