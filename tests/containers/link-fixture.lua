-- This test-only helper creates links as WirePlumber, bypassing the client
-- permission check so the policy's second line of defence gets exercised.
links = {}
om = ObjectManager {
  Interest { type = "metadata", Constraint { "metadata.name", "=", "default" } }
}
om:connect ("object-added", function (_, metadata)
  metadata:connect ("changed", function (_, id, key, _, value)
    if id ~= 0 or key ~= "micsnitch.test.link" or not value then return end
    local on, op, inn, ip = value:match ("^(%d+) (%d+) (%d+) (%d+)$")
    if not on then return end
    local link = Link ("link-factory", {
      ["link.output.node"] = on, ["link.output.port"] = op,
      ["link.input.node"] = inn, ["link.input.port"] = ip,
    })
    table.insert (links, link)
    link:connect ("notify::bound-id", function (l)
      local bound = l["bound-id"]
      if bound > 0 and bound < 4294967295 then
        metadata:set (0, "micsnitch.test.created", "Spa:String", tostring (bound))
      end
    end)
    link:activate (Features.ALL)
  end)
end)
om:activate ()
