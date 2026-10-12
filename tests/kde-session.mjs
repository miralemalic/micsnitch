// Stands in for the parts of a Plasma session the KDE test can't run for real:
// a screen locker the test can unlock again, and the system tray's watcher.
// Lock and unlock through the real interface:
//   gdbus call --session --dest org.freedesktop.ScreenSaver \
//       --object-path /org/freedesktop/ScreenSaver \
//       --method org.freedesktop.ScreenSaver.SetActive true
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SAVER = `<node>
  <interface name="org.freedesktop.ScreenSaver">
    <method name="GetActive"><arg type="b" direction="out"/></method>
    <method name="SetActive"><arg type="b" direction="in"/><arg type="b" direction="out"/></method>
    <signal name="ActiveChanged"><arg type="b"/></signal>
  </interface>
</node>`;
const WATCHER = `<node>
  <interface name="org.kde.StatusNotifierWatcher">
    <method name="RegisterStatusNotifierItem"><arg type="s" direction="in"/></method>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
  </interface>
</node>`;

const saver = {
    active: false,
    GetActive() {
        return this.active;
    },
    SetActive(active) {
        this.active = active;
        saverObject.emit_signal('ActiveChanged', new GLib.Variant('(b)', [active]));
        return true;
    },
};
const watcher = {
    RegisteredStatusNotifierItems: [],
    RegisterStatusNotifierItem(service) {
        this.RegisteredStatusNotifierItems.push(service);
    },
};
const saverObject = Gio.DBusExportedObject.wrapJSObject(SAVER, saver);
const watcherObject = Gio.DBusExportedObject.wrapJSObject(WATCHER, watcher);

const loop = new GLib.MainLoop(null, false);
Gio.bus_own_name(Gio.BusType.SESSION, 'org.freedesktop.ScreenSaver', Gio.BusNameOwnerFlags.NONE,
    bus => saverObject.export(bus, '/org/freedesktop/ScreenSaver'), null, () => loop.quit());
Gio.bus_own_name(Gio.BusType.SESSION, 'org.kde.StatusNotifierWatcher', Gio.BusNameOwnerFlags.NONE,
    bus => watcherObject.export(bus, '/StatusNotifierWatcher'), null, () => loop.quit());
loop.run();
