-- Controlled-clock tests for the production sidebar scheduler, not wall-clock evidence.
local beat = dofile('tern-plugin/session-beat.luau')
local traffic = dofile('tern-plugin/traffic-light.luau')
local passed = 0
local function check(name, fn) fn(); passed = passed + 1; print('PASS ' .. name) end
local function fixture()
  local now, timers, closed, renders, detached = 0, {}, {}, {}, {}
  local controller = beat.new({now = function() return now end,
    timer = function(ms, fn)
      local t = {due = now + ms, fn = fn, cancel = function(self) self.cancelled = true end}
      table.insert(timers,t); return t
    end,
    closed = function(pane) return closed[pane] end,
    detach = function(pane) detached[pane] = true end,
    render = function(cx) table.insert(renders, {pane = cx.pane, lit = cx.state.lit}) end,
  })
  local function add(pane, running)
    local state = {running = running}; controller.attach(state, {pane = pane, state = state}); return state
  end
  local function tick(at) now = at; timers[#timers].fn() end
  return {c=controller, add=add, tick=tick, timers=timers, closed=closed, renders=renders, detached=detached}
end
check('production status priority preserves locks, waits, reading/running overlap and unread meanings', function()
  local s={current='mine'}
  assert(traffic.status(s,{running=true,completed=true})=='working')
  assert(traffic.status(s,{running=true,waiting=true})=='waiting')
  assert(traffic.status(s,{waiting=true,permission=true})=='permission')
  assert(traffic.status(s,{locked=true,id='other',running=true})=='off')
  assert(traffic.status(s,{locked=true,id='mine',running=true})=='working')
  assert(traffic.status(s,{failed=true,completed=true})=='failed')
  assert(traffic.status(s,{completed=true})=='completed' and traffic.status(s,{})=='off')
end)
check('all panels share one host timer and current phase, idle panels do not repaint', function()
  local f=fixture(); local a=f.add(1,true); local b=f.add(2,true); f.add(3,false)
  assert(#f.timers==1 and a.lit==b.lit); f.tick(500)
  assert(#f.renders==2 and not a.lit and not b.lit and #f.timers==2)
  local c=f.add(4,true); assert(c.lit==a.lit and #f.timers==2)
  f.tick(1000); assert(#f.renders==5 and a.lit and b.lit and c.lit)
end)
check('last running row stops timer and stale queued callback cannot restart it', function()
  local f=fixture(); local a=f.add(1,true); local old=f.timers[1]
  a.running=false; f.c.changed(1); assert(old.cancelled)
  old.fn(); assert(#f.timers==1 and #f.renders==0)
  a.running=true; f.c.changed(1); assert(#f.timers==2)
  old.fn(); assert(#f.timers==2 and #f.renders==0)
end)
check('stopping one panel keeps other work alive; last exit cancels', function()
  local f=fixture(); local a=f.add(1,true); f.add(2,true)
  a.running=false; f.c.changed(1); assert(not f.timers[1].cancelled)
  f.tick(500); assert(#f.renders==1 and f.renders[1].pane==2)
  f.c.remove(2); assert(f.timers[2].cancelled and f.detached[2])
end)
check('closed plugin pane is pruned on next tick even when host retains pane id', function()
  local f=fixture(); f.add(1,true); f.closed[1]=true; f.tick(500)
  assert(#f.timers==1 and #f.renders==0 and f.detached[1])
end)
check('unload cancels and releases every context without resurrection', function()
  local f=fixture(); f.add(1,true); f.add(2,false); f.c.dispose()
  assert(f.timers[1].cancelled and f.detached[1] and f.detached[2]); f.timers[1].fn()
  assert(#f.timers==1 and #f.renders==0)
end)
check('idle sidebar never schedules an animation heartbeat; late callback realigns without catchup', function()
  local f=fixture(); f.add(1,false); assert(#f.timers==0)
  f.add(2,true); f.tick(1875); assert(#f.timers==2 and f.timers[2].due==2000 and #f.renders==1)
end)
print('Passed '..passed..' production scheduler tests (controlled clock).')
