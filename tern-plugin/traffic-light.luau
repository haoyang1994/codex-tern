-- Snapshot-only status priority; reading a result must not hide a running turn.
local traffic = {}

function traffic.status(snapshot, item)
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

return traffic
