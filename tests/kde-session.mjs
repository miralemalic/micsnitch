// Stands in for the parts of a Plasma session the KDE test can't run for real:
// a screen locker the test can unlock again, the system tray's watcher,
// and notifications the test can read and click.
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

// Shown and Press are ours, for the test
const NOTIFICATIONS = `<node>
  <interface name="org.freedesktop.Notifications">
    <method name="Notify">
      <arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/>
      <arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="as" direction="in"/>
      <arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="out"/>
    </method>
    <method name="CloseNotification"><arg type="u" direction="in"/></method>
    <method name="Shown"><arg type="as" direction="out"/></method>
    <method name="Press"><arg type="s" direction="in"/><arg type="b" direction="out"/></method>
    <signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
    <signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
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
const notifications = {
    sent: [],
    Notify(_app, replaces, _icon, title, _body, actions) {
        const id = replaces || this.sent.length + 1;
        this.sent[id - 1] = {title, actions};
        return id;
    },
    CloseNotification() {},
    Shown() {
        return this.sent.map(notification => notification.title);
    },
    // A click on the one button a notification has
    Press(title) {
        const id = this.sent.findIndex(notification => notification.title === title) + 1;
        if (id) {
            notificationsObject.emit_signal('ActionInvoked',
                new GLib.Variant('(us)', [id, this.sent[id - 1].actions[0]]));
        }
        return id > 0;
    },
};
const saverObject = Gio.DBusExportedObject.wrapJSObject(SAVER, saver);
const notificationsObject = Gio.DBusExportedObject.wrapJSObject(NOTIFICATIONS, notifications);
const watcherObject = Gio.DBusExportedObject.wrapJSObject(WATCHER, watcher);

const loop = new GLib.MainLoop(null, false);
Gio.bus_own_name(Gio.BusType.SESSION, 'org.freedesktop.ScreenSaver', Gio.BusNameOwnerFlags.NONE,
    bus => saverObject.export(bus, '/org/freedesktop/ScreenSaver'), null, () => loop.quit());
Gio.bus_own_name(Gio.BusType.SESSION, 'org.kde.StatusNotifierWatcher', Gio.BusNameOwnerFlags.NONE,
    bus => watcherObject.export(bus, '/StatusNotifierWatcher'), null, () => loop.quit());
Gio.bus_own_name(Gio.BusType.SESSION, 'org.freedesktop.Notifications', Gio.BusNameOwnerFlags.NONE,
    bus => notificationsObject.export(bus, '/org/freedesktop/Notifications'), null, () => loop.quit());
loop.run();
