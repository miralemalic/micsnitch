// SPDX-FileCopyrightText: 2026 miralemalic
// SPDX-License-Identifier: MIT

// MicSnitch for KDE Plasma. The same handler as the GNOME extension,
// in a small app that sits in the tray from login on.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gettext from 'gettext';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import LayerShell from 'gi://Gtk4LayerShell?version=1.0';
import System from 'system';

import {Handler} from './core/handler.js';
import {RequestDialog} from './dialog.js';
import {Tray} from './tray.js';
import {MainWindow} from './window.js';

const {gettext: _} = Gettext.domain('micsnitch');
const DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const SCHEMA = 'org.gnome.shell.extensions.micsnitch';
const SCREENSAVER = 'org.freedesktop.ScreenSaver';

// One history per login. If Plasma doesn't say which login this is,
// the compositor's socket will do: it's new every time.
function session() {
    const display = GLib.getenv('WAYLAND_DISPLAY') ?? 'wayland-0';
    const socket = GLib.path_is_absolute(display) ? display
        : GLib.build_filenamev([GLib.get_user_runtime_dir(), display]);
    try {
        return GLib.getenv('XDG_SESSION_ID') || `wayland-${Gio.File.new_for_path(socket)
            .query_info('unix::inode', Gio.FileQueryInfoFlags.NONE, null)
            .get_attribute_uint64('unix::inode')}`;
    } catch {
        return null;
    }
}

// A file of our own, so the settings don't depend on dconf being there
function loadSettings() {
    const source = Gio.SettingsSchemaSource.new_from_directory(`${DIR}/schemas`,
        Gio.SettingsSchemaSource.get_default(), false);
    const file = GLib.build_filenamev([GLib.get_user_config_dir(), 'micsnitch', 'settings.ini']);
    return new Gio.Settings({
        settings_schema: source.lookup(SCHEMA, false),
        backend: Gio.keyfile_settings_backend_new(file, '/org/gnome/shell/extensions/micsnitch/',
            'micsnitch'),
    });
}

const MicSnitch = GObject.registerClass(
class MicSnitch extends Adw.Application {
    _init() {
        super._init({application_id: 'io.github.miralemalic.MicSnitch'});
        this._locked = false;
    }

    vfunc_startup() {
        super.vfunc_startup();
        // Runs from login to logout, the window comes and goes
        this.hold();

        const css = new Gtk.CssProvider();
        css.load_from_path(`${DIR}/style.css`);
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        this._settings = loadSettings();
        this._handler = new Handler(this._settings, {
            session: session(),
            isLocked: () => this._locked,
            ask: (app, kind, source) => new RequestDialog(this, app, kind, source),
        });
        this._tray = new Tray(this.get_dbus_connection(), token => {
            this._token = token;
            this.activate();
        });
        const sync = () => {
            this._handler.blocked = this._settings.get_boolean('disable-microphone');
            this._syncTray();
        };
        this._settings.connect('changed::disable-microphone', sync);
        this._handler.channel.connect('notify::active', () => this._syncTray());
        this._handler.channel.connect('recordings-changed', () => this._syncTray());
        sync();
        this._watchLock();
        this._handler.start();

        // Called signal_add_full before GLib 2.88
        const signalAdd = GLibUnix.signal_add ?? GLibUnix.signal_add_full;
        for (const signal of [2, 15]) { // SIGINT, SIGTERM
            signalAdd(GLib.PRIORITY_DEFAULT, signal, () => {
                this._quit();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    vfunc_activate() {
        if (!this._window) {
            this._window = new MainWindow(this, this._handler, this._settings);
            this._window.connect('destroy', () => (this._window = null));
        }
        if (this._token)
            this._window.set_startup_id(this._token);
        this._token = null;
        this._window.present();
    }

    // Tell the gate we're gone and let the history save, then go
    async _quit() {
        if (this._handler) {
            const {writes, activity} = this._handler.stop();
            this._handler = null;
            await Promise.all([writes, activity]);
        }
        this.quit();
    }

    vfunc_shutdown() {
        this._handler?.stop();
        this._tray.destroy();
        super.vfunc_shutdown();
    }

    // Requests wait while the screen is locked, like they do on GNOME
    _watchLock() {
        const bus = this.get_dbus_connection();
        bus.signal_subscribe(SCREENSAVER, SCREENSAVER, 'ActiveChanged', '/org/freedesktop/ScreenSaver',
            null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, parameters) => {
                this._setLocked(parameters.deepUnpack()[0]);
            });
        bus.call(SCREENSAVER, '/org/freedesktop/ScreenSaver', SCREENSAVER, 'GetActive', null,
            new GLib.VariantType('(b)'), Gio.DBusCallFlags.NONE, -1, null, (_bus, result) => {
                try {
                    this._setLocked(bus.call_finish(result).deepUnpack()[0]);
                } catch {
                    // Nothing locks this desktop
                }
            });
    }

    _setLocked(locked) {
        if (this._locked === locked || !this._handler)
            return;
        this._locked = locked;
        this._handler.sync();
    }

    _syncTray() {
        if (!this._handler)
            return;
        const {channel} = this._handler;
        const names = [...channel.recordings.values()]
            .map(recording => this._handler.nameOf(recording) ?? _('Unnamed app'));
        if (!channel.active)
            this._tray.show('dialog-warning', _('Protection unavailable'), true);
        else if (this._settings.get_boolean('disable-microphone'))
            this._tray.show('microphone-sensitivity-muted', _('Microphone off'));
        else if (names.length)
            this._tray.show('audio-input-microphone', _('Recording: %s').replace('%s', names.join(', ')));
        else
            this._tray.show('audio-input-microphone', _('No apps recording'));
    }
});

GLib.set_prgname('micsnitch');
GLib.set_application_name('MicSnitch');
Gtk.init();
// Wayland only. On X11 any app could click Allow for itself.
if (!LayerShell.is_supported()) {
    printerr('MicSnitch needs KDE Plasma, or another desktop with layer-shell, on Wayland.');
    System.exit(0);
}
System.exit(await new MicSnitch().runAsync([System.programInvocationName, ...System.programArgs]));
