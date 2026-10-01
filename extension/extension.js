// SPDX-FileCopyrightText: 2026 miralemalic
// SPDX-License-Identifier: GPL-3.0-or-later

// Show recording controls and ask before an app gets an audio connection.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension, gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {Activity, describeEvent} from './core/activity.js';
import {Channel} from './core/channel.js';
import {identify} from './core/identity.js';
import {RequestDialog} from './dialog.js';

// Chromium-based apps reopen the mic several times for one click, so an
// answer also covers the same app's requests for a little while after.
const FOLLOW_UP_US = 30 * GLib.USEC_PER_SEC;
// The menu shows this many recent decisions; settings shows them all
const MENU_EVENTS = 10;

function kindName(kind) {
    return kind === 'mic' ? _('Microphone') : _('System audio');
}

const MicToggle = GObject.registerClass(
class MicToggle extends QuickMenuToggle {
    _init(privacy, channel, activity, preferences) {
        super._init({title: _('Microphone'), toggleMode: true});
        this._channel = channel;
        this._activity = activity;
        privacy.bind('disable-microphone', this, 'checked',
            Gio.SettingsBindFlags.INVERT_BOOLEAN);
        this.menu.setHeader('audio-input-microphone-symbolic', _('MicSnitch'));

        this._recordings = new PopupMenu.PopupMenuSection();
        this._recent = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Recording now')));
        this.menu.addMenuItem(this._recordings);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Recent activity')));
        this.menu.addMenuItem(this._recent);
        this.menu.addAction(_('Settings…'), () => {
            Main.panel.statusArea.quickSettings.menu.close();
            preferences();
        });

        this.connect('notify::checked', () => this._sync());
        channel.connectObject('notify::active', () => this._sync(),
            'recordings-changed', () => this._sync(), this);
        activity.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        this.iconName = this.checked
            ? 'audio-input-microphone-symbolic' : 'microphone-disabled-symbolic';
        if (!this._channel.active)
            this.subtitle = _('Not protected');
        else if (!this.checked)
            this.subtitle = _('Off for all apps');
        else if (this._channel.recordings.size)
            this.subtitle = ngettext('%d recording', '%d recordings',
                this._channel.recordings.size).format(this._channel.recordings.size);
        else
            this.subtitle = _('Apps ask first');

        this._recordings.removeAll();
        for (const [id, recording] of this._channel.recordings) {
            const name = recording.app || recording.flatpak || recording.binary || _('Unnamed app');
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            const labels = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
            labels.add_child(new St.Label({text: name}));
            labels.add_child(new St.Label({
                text: [kindName(recording.kind), recording.source].filter(Boolean).join(' · '),
                style_class: 'micsnitch-detail',
            }));
            item.add_child(labels);
            const stop = new St.Button({
                label: _('Stop'), style_class: 'button', can_focus: true,
                accessible_name: _('Stop recording for %s').format(name),
            });
            stop.connect('clicked', () => {
                stop.reactive = false;
                this._channel.stopRecording(id, recording.serial);
            });
            item.add_child(stop);
            this._recordings.addMenuItem(item);
        }
        if (!this._channel.recordings.size) {
            this._recordings.addMenuItem(new PopupMenu.PopupMenuItem(
                this._channel.active ? _('No apps recording') : _('Protection unavailable'),
                {reactive: false}));
        }

        this._recent.removeAll();
        for (const event of this._activity.events.slice(-MENU_EVENTS).reverse()) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            const labels = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
            labels.add_child(new St.Label({text: event.app || _('Unnamed app')}));
            labels.add_child(new St.Label({text: describeEvent(event, _), style_class: 'micsnitch-detail'}));
            item.add_child(labels);
            this._recent.addMenuItem(item);
        }
        if (!this._activity.events.length)
            this._recent.addMenuItem(new PopupMenu.PopupMenuItem(_('No decisions this login'), {reactive: false}));
    }
});

const Indicator = GObject.registerClass(
class Indicator extends SystemIndicator {
    _init(privacy, channel, activity, preferences) {
        super._init();
        this.quickSettingsItems.push(new MicToggle(privacy, channel, activity, preferences));
    }
});

export default class MicSnitchExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._privacy = new Gio.Settings({schema_id: 'org.gnome.desktop.privacy'});
        this._queue = new Map();
        this._lastAnswers = new Map();
        this._cancellable = new Gio.Cancellable();
        this._activity = new Activity(GLib.getenv('XDG_SESSION_ID') ||
            String(Gio.Credentials.new().get_unix_pid()));
        // Finish the previous popup's writes before announcing readiness again.
        this._channel = new Channel(this._pendingWrites);
        this._pendingWrites = null;
        this._channel.connectObject(
            'request', (_c, id, request) => this._onRequest(id, request),
            'withdrawn', (_c, id) => this._onWithdrawn(id),
            'stopped', (_c, recording) => this._activity.add({
                app: recording.app, kind: recording.kind,
                source: recording.source, action: 'stop',
            }),
            'notify::active', () => this._sync(), this);
        this._privacy.connectObject('changed::disable-microphone', () => this._sync(), this);
        this._indicator = new Indicator(this._privacy, this._channel, this._activity,
            () => this.openPreferences());
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        this._channel.start();
    }

    disable() {
        // The popup is removed on lock; requests wait until it returns.
        this._pendingWrites = this._channel.tell('ui',
            Main.sessionMode.isLocked ? 'locked' : 'off');
        this._channel.disconnectObject(this);
        this._channel.stop();
        this._privacy.disconnectObject(this);
        this._cancellable.cancel();
        this._activity.close();
        this._queue.clear();
        if (this._retryId)
            GLib.source_remove(this._retryId);
        // Release the keyboard and pointer grab before removing a visible popup.
        this._dialog?.popModal();
        this._dialog?.destroy();
        this._indicator.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        this._retryId = 0;
        this._settings = this._privacy = this._channel = this._activity = null;
        this._cancellable = null;
        this._queue = this._lastAnswers = this._dialog = this._indicator = null;
    }

    _sync() {
        if (!this._channel.active) {
            this._queue.clear();
            this._dialog?.close();
            return;
        }
        this._channel.tell('block', this._privacy.get_boolean('disable-microphone') ? '1' : '0');
        this._channel.readiness();
        this._next();
    }

    async _onRequest(id, request) {
        const previous = this._queue.get(id);
        const sameRequest = previous?.request.serial === request.serial &&
            previous?.request.kind === request.kind;
        const entry = {request, app: sameRequest ? previous.app : null};
        this._queue.set(id, entry);
        if (this._dialog?.requestId === id && previous &&
            (previous.request.serial !== request.serial || previous.request.kind !== request.kind))
            this._dialog.close();
        entry.app = await identify(request, this._cancellable);
        // The stream may disappear or change while its identity is being read.
        if (this._queue?.get(id) !== entry)
            return;
        this._next();
    }

    _onWithdrawn(id) {
        this._queue.delete(id);
        if (this._dialog?.requestId === id)
            this._dialog.close();
        this._next();
    }

    _next() {
        if (!this._queue || Main.sessionMode.isLocked || !this._channel.active ||
            this._dialog || this._retryId)
            return;

        while (this._queue.size) {
            const [id, entry] = this._queue.entries().next().value;
            const {app, request} = entry;
            if (!app)
                return;
            const key = app.key && `${request.kind}:${app.key}`;
            const rule = key && this._settings.get_value('rules').deepUnpack()[key];
            const last = key && this._lastAnswers.get(key);
            if (request.kind === 'system' && !this._settings.get_boolean('system-audio')) {
                this._answer(id, entry, true, 'system');
            } else if (rule) {
                this._answer(id, entry, rule === 'allow', 'remembered');
            } else if (last?.until > GLib.get_monotonic_time()) {
                this._answer(id, entry, last.allowed, 'follow-up');
            } else {
                this._show(id, app, request);
                return;
            }
        }
    }

    _show(id, app, request) {
        const dialog = new RequestDialog(app, request.kind, request.source);
        dialog.requestId = id;
        dialog.connect('response', (_d, allowed, remember) => {
            const current = this._queue.get(id)?.request;
            if (Main.sessionMode.isLocked || !current ||
                current.serial !== request.serial || current.kind !== request.kind)
                return;
            // One choice can answer this app's other requests for the same kind.
            for (const [other, entry] of this._queue) {
                if (other === id || (app.key && entry.app?.key === app.key &&
                    entry.request.kind === request.kind)) {
                    this._answer(other, entry, allowed);
                }
            }
            if (remember && app.key)
                this._remember(`${request.kind}:${app.key}`, allowed);
        });
        dialog.connect('closed', () => {
            if (this._dialog === dialog)
                this._dialog = null;
            this._next();
        });
        this._dialog = dialog;
        if (dialog.open())
            return;

        // Another Shell dialog may hold the grab. Try again once it has closed.
        this._dialog = null;
        dialog.destroy();
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._retryId = 0;
            this._next();
            return GLib.SOURCE_REMOVE;
        });
    }

    _answer(id, {app, request}, allowed, reason = 'once') {
        this._channel.answer(id, request.serial, request.kind, allowed);
        this._queue.delete(id);
        if (app.key && (reason === 'once' || reason === 'follow-up')) {
            this._lastAnswers.set(`${request.kind}:${app.key}`,
                {allowed, until: GLib.get_monotonic_time() + FOLLOW_UP_US});
        }
        // Follow-ups are the same decision, so they don't fill the list
        if (reason !== 'follow-up') {
            this._activity.add({
                app: app.name, kind: request.kind, source: request.source,
                action: allowed ? 'allow' : 'deny', reason,
            });
        }
    }

    _remember(key, allowed) {
        const rules = this._settings.get_value('rules').deepUnpack();
        rules[key] = allowed ? 'allow' : 'deny';
        this._settings.set_value('rules', new GLib.Variant('a{ss}', rules));
    }
}
