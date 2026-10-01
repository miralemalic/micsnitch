// SPDX-FileCopyrightText: 2026 miralemalic
// SPDX-License-Identifier: MIT

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {Activity, canUndo, describeEvent} from './core/activity.js';
import {Channel} from './core/channel.js';
import {identify} from './core/identity.js';
import {RequestDialog} from './dialog.js';

// Chromium-based apps reopen the mic several times for one click, so an
// answer also covers the same app for a little while after
const FOLLOW_UP_US = 30 * GLib.USEC_PER_SEC;
const MENU_EVENTS = 10;

function kindName(kind) {
    return kind === 'mic' ? _('Microphone') : _('System audio');
}

function menuRow(title, detail, label = null, action = null) {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    const labels = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
    labels.add_child(new St.Label({text: title}));
    labels.add_child(new St.Label({text: detail, style_class: 'micsnitch-detail'}));
    item.add_child(labels);
    if (label) {
        const button = new St.Button({
            label, style_class: 'button', can_focus: true,
            accessible_name: `${label}: ${title}`,
        });
        button.connect('clicked', () => {
            button.reactive = false;
            action();
        });
        item.add_child(button);
    }
    return item;
}

const MicToggle = GObject.registerClass(
class MicToggle extends QuickMenuToggle {
    _init(extension) {
        super._init({title: _('MicSnitch'), toggleMode: true});
        this._extension = extension;
        extension._privacy.bind('disable-microphone', this, 'checked',
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
            extension.openPreferences();
        });

        this.connect('notify::checked', () => this._sync());
        extension._channel.connectObject('notify::active', () => this._sync(),
            'recordings-changed', () => this._sync(), this);
        extension._activity.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const {_channel: channel, _activity: activity} = this._extension;

        // Without the policy nothing is guarded, so warn
        if (!channel.active)
            this.iconName = 'dialog-warning-symbolic';
        else if (this.checked)
            this.iconName = 'audio-input-microphone-symbolic';
        else
            this.iconName = 'microphone-disabled-symbolic';

        this._recordings.removeAll();
        for (const [id, recording] of channel.recordings) {
            this._recordings.addMenuItem(menuRow(this._extension.nameOf(recording),
                [kindName(recording.kind), recording.source].filter(Boolean).join(' · '),
                _('Stop'), () => channel.stopRecording(id, recording.serial)));
        }
        if (!channel.recordings.size) {
            this._recordings.addMenuItem(new PopupMenu.PopupMenuItem(
                channel.active ? _('No apps recording') : _('Protection unavailable'),
                {reactive: false}));
        }

        this._recent.removeAll();
        for (const event of activity.events.slice(-MENU_EVENTS).reverse()) {
            this._recent.addMenuItem(menuRow(event.app || _('Unnamed app'),
                describeEvent(event, _),
                canUndo(event) ? _('Undo') : null, () => this._extension.undo(event.id)));
        }
        if (!activity.events.length) {
            this._recent.addMenuItem(new PopupMenu.PopupMenuItem(
                _('No decisions this login'), {reactive: false}));
        }
    }
});

const Indicator = GObject.registerClass(
class Indicator extends SystemIndicator {
    _init(extension) {
        super._init();
        this.quickSettingsItems.push(new MicToggle(extension));
    }
});

export default class MicSnitchExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._privacy = new Gio.Settings({schema_id: 'org.gnome.desktop.privacy'});
        this._queue = new Map();
        this._lastAnswers = new Map();
        this._names = new Map();
        this._cancellable = new Gio.Cancellable();
        this._activity = new Activity(GLib.getenv('XDG_SESSION_ID') ||
            String(Gio.Credentials.new().get_unix_pid()), this._pendingActivity);
        this._pendingActivity = null;
        // Whatever we sent before a lock has to land before we say "ready"
        this._channel = new Channel(this._pendingWrites);
        this._pendingWrites = null;
        this._channel.connectObject(
            'request', (_c, id, request) => this._onRequest(id, request),
            'withdrawn', (_c, id) => this._onWithdrawn(id),
            'stopped', (_c, recording) => this._activity.add({
                app: this.nameOf(recording), kind: recording.kind,
                source: recording.source, action: 'stop',
            }),
            'notify::active', () => this._sync(), this);
        this._privacy.connectObject('changed::disable-microphone', () => this._sync(), this);
        // The settings window asks for an undo here
        this._settings.connectObject('changed::undo', () => this._undoFromSettings(), this);
        this._indicator = new Indicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        this._channel.start();
    }

    disable() {
        // Locking switches us off; requests wait for the unlock
        this._pendingWrites = this._channel.tell('ui',
            Main.sessionMode.isLocked ? 'locked' : 'off');
        this._channel.disconnectObject(this);
        this._channel.stop();
        this._privacy.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._cancellable.cancel();
        this._pendingActivity = this._activity.close();
        if (this._retryId)
            GLib.source_remove(this._retryId);
        // Destroying alone would leave the grab in place
        this._dialog?.popModal();
        this._dialog?.destroy();
        this._indicator.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        this._retryId = 0;
        this._settings = this._privacy = this._channel = this._activity = null;
        this._queue = this._lastAnswers = this._names = this._cancellable = null;
        this._dialog = this._indicator = null;
    }

    // The name the popup showed, which beats what an app calls itself
    nameOf(recording) {
        return this._names.get(recording.serial) ??
            (recording.app || recording.flatpak || recording.binary || _('Unnamed app'));
    }

    // Takes an answer back: no more follow-ups, no remembered rule, and an
    // allowed recording that's still going stops
    undo(id) {
        const event = this._activity.events.find(e => e.id === id);
        if (!event || !canUndo(event))
            return;

        const allowed = event.action === 'allow';
        if (this._lastAnswers.get(event.key)?.allowed === allowed)
            this._lastAnswers.delete(event.key);
        const rules = this._settings.get_value('rules').deepUnpack();
        if (rules[event.key] === event.action) {
            delete rules[event.key];
            this._settings.set_value('rules', new GLib.Variant('a{ss}', rules));
        }
        for (const [node, recording] of this._channel.recordings) {
            if (allowed && recording.serial === event.serial)
                this._channel.stopRecording(node, recording.serial);
        }
        return this._activity.undo(event.id);
    }

    // Cleared only once the list is saved, so the settings window shows it
    async _undoFromSettings() {
        const id = this._settings.get_string('undo');
        if (!id)
            return;
        await this.undo(id);
        this._settings?.set_string('undo', '');
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
        const same = previous?.request.serial === request.serial &&
            previous?.request.kind === request.kind;
        const entry = {request, app: same ? previous.app : null};
        this._queue.set(id, entry);
        if (previous && !same && this._dialog?.requestId === id)
            this._dialog.close();
        entry.app = await identify(request, this._cancellable);
        // The stream may have changed or gone while we looked
        if (this._queue?.get(id) === entry)
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
            if (Main.sessionMode.isLocked || current?.serial !== request.serial ||
                current?.kind !== request.kind)
                return;
            // One answer covers everything the app asked for meanwhile
            for (const [other, entry] of this._queue) {
                if (other === id || (app.key && entry.app?.key === app.key &&
                    entry.request.kind === request.kind))
                    this._answer(other, entry, allowed);
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

        // Something else holds the screen, like the screenshot tool
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
        this._names.set(request.serial, app.name);
        if (this._names.size > 100)
            this._names.delete(this._names.keys().next().value);

        const key = app.key && `${request.kind}:${app.key}`;
        if (key && (reason === 'once' || reason === 'follow-up'))
            this._lastAnswers.set(key, {allowed, until: GLib.get_monotonic_time() + FOLLOW_UP_US});
        // A follow-up repeats a decision that's already listed
        if (reason !== 'follow-up') {
            this._activity.add({
                app: app.name, kind: request.kind, source: request.source,
                action: allowed ? 'allow' : 'deny', reason, key, serial: request.serial,
            });
        }
    }

    _remember(key, allowed) {
        const rules = this._settings.get_value('rules').deepUnpack();
        rules[key] = allowed ? 'allow' : 'deny';
        this._settings.set_value('rules', new GLib.Variant('a{ss}', rules));
    }
}
