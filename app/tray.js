// SPDX-FileCopyrightText: 2026 miralemalic
// SPDX-License-Identifier: MIT

// The tray icon. Plasma's system tray finds it through the
// StatusNotifierItem interface, and so do most other panels.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const WATCHER = 'org.kde.StatusNotifierWatcher';
const ITEM = `<node>
  <interface name="org.kde.StatusNotifierItem">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <method name="Activate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
    <method name="SecondaryActivate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
    <method name="ContextMenu"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
    <method name="Scroll"><arg type="i" direction="in"/><arg type="s" direction="in"/></method>
    <method name="ProvideXdgActivationToken"><arg type="s" direction="in"/></method>
    <signal name="NewIcon"/>
    <signal name="NewToolTip"/>
    <signal name="NewStatus"><arg type="s"/></signal>
  </interface>
</node>`;

export class Tray {
    Category = 'Hardware';
    Id = 'micsnitch';
    Title = 'MicSnitch';
    Status = 'Active';
    IconName = 'audio-input-microphone';
    ItemIsMenu = false;

    // onActivate gets the token Plasma hands over so the window may take focus
    constructor(bus, onActivate) {
        this._bus = bus;
        this._onActivate = onActivate;
        this._tooltip = '';
        this._token = null;
        this._object = Gio.DBusExportedObject.wrapJSObject(ITEM, this);
        this._object.export(bus, '/StatusNotifierItem');
        // The tray may come up after us, or restart
        this._watchId = Gio.bus_watch_name_on_connection(bus, WATCHER,
            Gio.BusNameWatcherFlags.NONE, () => this._register(), null);
    }

    get ToolTip() {
        return [this.IconName, [], this.Title, this._tooltip];
    }

    Activate() {
        this._onActivate(this._token);
        this._token = null;
    }

    // There's no menu, a right click opens the window too
    ContextMenu() {
        this.Activate();
    }

    SecondaryActivate() {}

    Scroll() {}

    ProvideXdgActivationToken(token) {
        this._token = token;
    }

    show(icon, tooltip, attention = false) {
        const status = attention ? 'NeedsAttention' : 'Active';
        if (icon !== this.IconName) {
            this.IconName = icon;
            this._object.emit_signal('NewIcon', null);
        }
        if (tooltip !== this._tooltip) {
            this._tooltip = tooltip;
            this._object.emit_signal('NewToolTip', null);
        }
        if (status !== this.Status) {
            this.Status = status;
            this._object.emit_signal('NewStatus', new GLib.Variant('(s)', [status]));
        }
    }

    _register() {
        this._bus.call(WATCHER, '/StatusNotifierWatcher', WATCHER, 'RegisterStatusNotifierItem',
            new GLib.Variant('(s)', [this._bus.get_unique_name()]), null,
            Gio.DBusCallFlags.NONE, -1, null, (bus, result) => {
                try {
                    bus.call_finish(result);
                } catch (e) {
                    logError(e, 'Cannot add the MicSnitch tray icon');
                }
            });
    }

    destroy() {
        Gio.bus_unwatch_name(this._watchId);
        this._object.unexport();
    }
}
