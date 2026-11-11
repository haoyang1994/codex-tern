-- Placement only. This VM owns no animation timer and never repaints the lamp.
tern.command({id = "open", title = "后台单灯原型：打开合成状态", run = function(cx)
  cx:new_block("host-light-prototype.light", {"working"}, "beside", {focus = false})
end})
-- Lifecycle only, not an animation driver. Host list can retain a closed plugin
-- pane, and host pane_exited is not guaranteed for it on Tern 0.9.16.
tern.on("pane_closed", function(ev)
  local key = "light-pane:" .. ev.pane
  if tern.kv.get(key) == "open" then tern.kv.set(key, "closed") end
end)
