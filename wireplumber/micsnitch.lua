-- MicSnitch: nothing records audio until you allow it.
--
-- SPDX-FileCopyrightText: 2026 miralemalic
-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Hold recording connections before WirePlumber makes them. The desktop
-- asks for consent and answers through the "micsnitch" metadata. Apps lose
-- the link-factory so they cannot wire around this policy; raced links are
-- cut too. The metadata carries live requests and recordings, never history.

lutils = require ("linking-utils")
log = Log.open_topic ("s-micsnitch")

VERSION = "2"
POPUP_TIMEOUT_MS = 15000

-- Node ids are reused. Serials, together with mic/system, identify consent.
approved = {}
pending = {}
recordings = {}
metadata = nil
ui = "off"
ui_claim = nil
ui_client = nil
blocked = false
ready = false
recordings_idle = nil
daemon_pid = Core.get_info ().properties["application.process.id"]

nodes_om = ObjectManager { Interest { type = "node" } }
clients_om = ObjectManager { Interest { type = "client" } }
links_om = ObjectManager { Interest { type = "link" } }

-- PipeWire owns the noticeboard. An app's lookalike does not count.
metadata_om = ObjectManager {
  Interest {
    type = "metadata",
    Constraint { "metadata.name", "=", "micsnitch" },
    Constraint { "client.id", "-" },
  }
}

function lookup (om, id)
  if id == nil then
    return nil
  end
  return om:lookup { Constraint { "bound-id", "=", tonumber (id), type = "gobject" } }
end

function serial (object)
  return object.properties["object.serial"]
end

function post (id, key, value)
  if metadata then
    metadata:set (id, key, value and "Spa:String" or nil, value)
  end
end

function post_json (id, key, value)
  if metadata then
    metadata:set (id, key, "Spa:String:JSON", Json.Object (value):to_string ())
  end
end

-- Names can be invented. PipeWire's kernel-supplied pid identifies the
-- audio daemon and WirePlumber's own connections.
function is_system (client)
  local pid = client.properties["pipewire.sec.pid"]
  local own_id = Core.get_own_bound_id ()
  if pid == daemon_pid or client["bound-id"] == own_id then
    return true
  end
  local own = lookup (clients_om, own_id)
  if own == nil then
    return nil
  end
  return pid == own.properties["pipewire.sec.pid"]
end

function needs_consent (to, from)
  local owner = to.properties["client.id"]
  if owner == nil or owner == from.properties["client.id"] then
    return false
  end
  local client = lookup (clients_om, owner)
  return client == nil or not is_system (client)
end

function kind_of (from)
  return (from.properties["media.class"] or ""):find ("^Audio/Source") and "mic" or "system"
end

function describe (to, from)
  local client = lookup (clients_om, to.properties["client.id"])
  local c = client and client.properties or {}
  local f = from.properties
  return {
    app = c["application.name"],
    binary = c["application.process.binary"],
    pid = c["application.process.id"],
    sec_pid = c["pipewire.sec.pid"],
    flatpak = c["pipewire.access.portal.app_id"],
    sandboxed = c["pipewire.sec.flatpak"] == "true",
    serial = serial (to),
    source = f["node.description"] or f["application.name"] or f["media.name"] or f["node.name"],
    kind = kind_of (from),
  }
end

function is_approved (to, from)
  local a = approved[serial (to)]
  return a and a[kind_of (from)] ~= nil
end

function tell (text)
  local notifications = Plugin.find ("notifications-api")
  if notifications then
    notifications:call ("send", "MicSnitch", text)
  end
  log:warning (text)
end

function clear_pending (id)
  local p = pending[id]
  if p and p.timeout then
    p.timeout:destroy ()
  end
  pending[id] = nil
  post (id, "micsnitch.request", nil)
  post (id, "micsnitch.answer", nil)
end

function refuse (id, node)
  node = node or lookup (nodes_om, id)
  clear_pending (id)
  recordings[id] = nil
  post (id, "micsnitch.recording", nil)
  post (id, "micsnitch.stop", nil)
  if node == nil then
    return
  end
  approved[serial (node)] = nil
  local client = lookup (clients_om, node.properties["client.id"])
  if client then
    client:send_error (id, -1, "MicSnitch: access denied")
  end
  node:request_destroy ()
end

-- A missing popup gets 15 seconds to reconnect. On lock, the extension
-- explicitly pauses consent before removing its UI; questions wait for unlock.
function expire_later (id)
  local p = pending[id]
  if p.timeout then
    return
  end
  p.timeout = Core.timeout_add (POPUP_TIMEOUT_MS, function ()
    p.timeout = nil
    if pending[id] == p and ui == "off" then
      tell (string.format ("%s was denied audio: the MicSnitch popup isn't running.",
          p.description.app or "An app"))
      refuse (id)
    end
    return false
  end)
end

function ask (to, from)
  local id = to["bound-id"]
  local description = describe (to, from)
  if blocked then
    refuse (id, to)
    return
  end
  local p = pending[id]
  if p and (p.serial ~= serial (to) or p.kind ~= description.kind) then
    clear_pending (id)
    p = nil
  end
  if p == nil then
    p = { serial = serial (to), kind = description.kind, description = description }
    pending[id] = p
    post_json (id, "micsnitch.request", description)
    if ui == "off" then
      expire_later (id)
    end
  elseif p.description.source ~= description.source then
    p.description = description
    post_json (id, "micsnitch.request", description)
  end
end

-- Including the kind prevents an old system-audio answer from authorising
-- a stream that has since moved to the microphone.
function answer (id, value)
  local p = pending[id]
  local verdict, for_serial, kind = value:match ("^(%a+) (%d+) (%a+)$")
  if p == nil or for_serial ~= p.serial or kind ~= p.kind or
      (verdict ~= "allow" and verdict ~= "deny") then
    return
  end
  if verdict == "allow" and ui == "locked" then
    return
  end
  if verdict == "allow" and not blocked then
    clear_pending (id)
    approved[p.serial] = approved[p.serial] or {}
    approved[p.serial][kind] = true
    Plugin.find ("standard-event-source"):call ("schedule-rescan", "linking")
  else
    refuse (id)
  end
end

function set_ui (value)
  ui_claim = value
  local state, pid = (value or ""):match ("^(%a+) (%d+)$")
  ui, ui_client = "off", nil
  if value == "locked" then
    ui = "locked"
  elseif state == "ready" then
    for client in clients_om:iterate () do
      if client.properties["pipewire.sec.pid"] == pid then
        ui, ui_client = state, serial (client)
        break
      end
    end
  end
  for id, p in pairs (pending) do
    if ui == "off" then
      expire_later (id)
    elseif p.timeout then
      p.timeout:destroy ()
      p.timeout = nil
    end
  end
end

function set_blocked (value)
  blocked = value
  if not blocked then
    return
  end
  for node in nodes_om:iterate () do
    local id = node["bound-id"]
    if pending[id] or approved[serial (node)] then
      refuse (id, node)
    end
  end
end

-- The marker belongs to WirePlumber's client, so PipeWire removes it if
-- WirePlumber dies. Requests still live in PipeWire through a policy restart.
function announce ()
  if ready then
    local id = Core.get_own_bound_id ()
    post (0, "micsnitch.active", nil)
    post (id, "micsnitch.active", VERSION)
  end
end

metadata_om:connect ("object-added", function (_, m)
  metadata = m
  -- Activity belongs to the desktop; remove any old shared history.
  post (0, "micsnitch.history", nil)
  -- A previous WirePlumber may have left rows behind. Rebuild from live links.
  for id, key in m:iterate (-1) do
    if key == "micsnitch.recording" then
      post (id, key, nil)
    end
  end
  recordings = {}
  m:connect ("changed", function (_, id, key, _, value)
    if key == "micsnitch.answer" and value then
      answer (id, value)
    elseif key == "micsnitch.stop" and value then
      local node = lookup (nodes_om, id)
      if node and value == serial (node) and approved[value] then
        refuse (id, node)
      end
    elseif id == 0 and key == "micsnitch.ui" then
      set_ui (value)
    elseif id == 0 and key == "micsnitch.block" then
      set_blocked (value == "1")
    end
  end)
  set_blocked (m:find (0, "micsnitch.block") == "1")
  set_ui (m:find (0, "micsnitch.ui"))
  for id, p in pairs (pending) do
    post_json (id, "micsnitch.request", p.description)
  end
  announce ()
  schedule_recordings ()
end)
metadata_om:connect ("object-removed", function (_, m)
  if metadata == m then
    metadata = nil
  end
end)

nodes_om:connect ("object-removed", function (_, node)
  local id = node["bound-id"]
  approved[serial (node)] = nil
  clear_pending (id)
  recordings[id] = nil
  post (id, "micsnitch.recording", nil)
end)

SimpleEventHook {
  name = "micsnitch/gate",
  after = { "linking/find-defined-target", "linking/find-filter-target",
            "linking/find-media-role-target", "linking/find-default-target",
            "linking/find-best-target", "linking/get-filter-from-target" },
  before = "linking/prepare-link",
  interests = { EventInterest { Constraint { "event.type", "=", "select-target" } } },
  execute = function (event)
    local _, _, si, props, _, target = lutils:unwrap_select_target_event (event)
    if target == nil or props["media.type"] ~= "Audio" then
      return
    end
    local stream = si:get_associated_proxy ("node")
    local peer = target:get_associated_proxy ("node")
    local to, from = stream, peer
    if props["item.node.direction"] == "output" then
      to, from = peer, stream
    end
    if not ready then
      event:stop_processing ()
    elseif needs_consent (to, from) then
      if blocked or not is_approved (to, from) then
        ask (to, from)
        event:stop_processing ()
      elseif pending[to["bound-id"]] then
        clear_pending (to["bound-id"])
      end
    end
  end
}:register ()

-- Only active links count as recording; an allowed but paused stream does
-- not. Publish one row per receiving node, rather than one per audio channel.
function update_recordings ()
  local current = {}
  for link in links_om:iterate () do
    local p = link.properties
    local to = lookup (nodes_om, p["link.input.node"])
    local from = lookup (nodes_om, p["link.output.node"])
    if link["state"] == "active" and to and from and not blocked and
        needs_consent (to, from) and is_approved (to, from) then
      current[to["bound-id"]] = describe (to, from)
    end
  end
  for id in pairs (recordings) do
    if current[id] == nil then
      post (id, "micsnitch.recording", nil)
    end
  end
  for id, description in pairs (current) do
    local value = Json.Object (description):to_string ()
    if recordings[id] == nil or Json.Object (recordings[id]):to_string () ~= value then
      post_json (id, "micsnitch.recording", description)
    end
  end
  recordings = current
end

function schedule_recordings ()
  if recordings_idle then
    return
  end
  recordings_idle = Core.idle_add (function ()
    recordings_idle = nil
    update_recordings ()
    return false
  end)
end

-- Cut a connection that skipped the policy, then ask about its receiver.
links_om:connect ("object-added", function (_, link)
  local p = link.properties
  local to = lookup (nodes_om, p["link.input.node"])
  local from = lookup (nodes_om, p["link.output.node"])
  if to and from and (to.properties["media.class"] or ""):find ("Audio") and
      needs_consent (to, from) and (blocked or not is_approved (to, from)) then
    link:request_destroy ()
    ask (to, from)
  end
  link:connect ("state-changed", schedule_recordings)
  schedule_recordings ()
end)
links_om:connect ("object-removed", schedule_recordings)

wiring = Interest {
  type = "factory",
  Constraint { "factory.name", "=", "link-factory" },
}

if PermissionManager then
  -- Newer WirePlumber shares its permission managers. Give apps their own
  -- copy so removing the link-factory does not also lock WirePlumber out.
  managers = {}

  function manager_for (client, access)
    if access == nil or access == "portal" or access == "snap" or is_system (client) ~= false then
      return nil
    end
    local perms = (access == "flatpak" or access == "restricted") and Perm.RX or Perm.ALL
    if managers[perms] == nil then
      local pm = PermissionManager ()
      pm:set_default_permissions (perms)
      pm:add_interest_match_simple (Perm.NONE, wiring)
      pm:activate (Features.ALL)
      managers[perms] = pm
    end
    return managers[perms]
  end

  function unwire (client)
    local pm = manager_for (client, client.properties["pipewire.access.effective"])
    if pm then
      client:attach_permission_manager (pm)
    end
  end

  SimpleEventHook {
    name = "micsnitch/no-wiring",
    after = { "client/find-config-access", "client/find-portal-access",
              "client/find-flatpak-access", "client/find-snap-access",
              "client/find-default-access" },
    before = "client/apply-access",
    interests = {
      EventInterest {
        Constraint { "event.type", "=", "select-access" },
      },
    },
    execute = function (event)
      local pm = manager_for (event:get_subject (), event:get_data ("effective-access"))
      if pm then
        event:set_data ("permission-manager", pm)
      end
    end
  }:register ()
else
  -- Older WirePlumber keeps a separate permission entry for each object.
  factories_om = ObjectManager { wiring }

  function unwire (client)
    local factory = factories_om:lookup ()
    if factory and is_system (client) == false then
      client:update_permissions { [factory["bound-id"]] = "-" }
    end
  end

  clients_om:connect ("object-added", function (_, client)
    unwire (client)
  end)
  factories_om:connect ("object-added", function ()
    for client in clients_om:iterate () do
      unwire (client)
    end
  end)
  factories_om:activate ()
end

clients_om:connect ("object-added", function (_, client)
  if ui == "off" and ui_claim then
    set_ui (ui_claim)
  end
end)
clients_om:connect ("object-removed", function (_, client)
  if serial (client) == ui_client then
    post (0, "micsnitch.ui", "off")
    set_ui ("off")
  end
end)

-- Learn nodes and clients first. Until then, the gate holds all app links.
nodes_om:connect ("installed", function ()
  clients_om:activate ()
end)
clients_om:connect ("installed", function (om)
  -- New clients use select-access above. Here, only already classified
  -- clients get a manager; unknown access must never become full access.
  for client in om:iterate () do
    unwire (client)
  end
  ready = true
  set_ui (ui_claim)
  announce ()
  Plugin.find ("standard-event-source"):call ("schedule-rescan", "linking")
  links_om:activate ()
end)

nodes_om:activate ()
metadata_om:activate ()
