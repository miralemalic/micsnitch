// SPDX-FileCopyrightText: 2026 miralemalic
// SPDX-License-Identifier: MIT

// The handler's job on any desktop: queue the requests, answer the ones
// we already know and put the rest in front of you, one at a time.
// The desktop only has to say if the screen is locked and draw the popup.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Activity, canUndo} from './activity.js';
import {Channel} from './channel.js';
import {identify} from './identity.js';

// Chromium-based apps reopen the mic several times for one click,
// so an answer also covers the same app for a little while after
const FOLLOW_UP_US = 30 * GLib.USEC_PER_SEC;

export class Handler {
    // desktop has isLocked(), ask() for a popup like the ones in dialog.js and
    // maybe a session name. previous is what stop() handed back last time.
    constructor(settings, desktop, previous = {}) {
        this._settings = settings;
        this._desktop = desktop;
        this._blocked = false;
        this._queue = new Map();
        this._lastAnswers = new Map();
        this._names = new Map();
        this._cancellable = new Gio.Cancellable();
        this._activity = new Activity(desktop.session ?? (GLib.getenv('XDG_SESSION_ID') ||
            String(Gio.Credentials.new().get_unix_pid())), previous.activity);
        // Whatever we sent before a lock has to land before we say "ready"
        this._channel = new Channel(previous.writes);
        this._signals = [
            [this._channel, this._channel.connect('request',
                (_c, id, request) => this._onRequest(id, request))],
            [this._channel, this._channel.connect('withdrawn', (_c, id) => this._onWithdrawn(id))],
            [this._channel, this._channel.connect('stopped', (_c, recording) => this._activity.add({
                app: this.nameOf(recording), kind: recording.kind,
                source: recording.source, action: 'stop',
            }))],
            [this._channel, this._channel.connect('notify::active', () => this.sync())],
            // The settings window asks for an undo here
            [settings, settings.connect('changed::undo', () => this._undoFromSettings())],
        ];
    }

    get channel() {
        return this._channel;
    }

    get activity() {
        return this._activity;
    }

    // The kill switch, GNOME's privacy setting or the KDE window's
    set blocked(blocked) {
        if (this._blocked === blocked)
            return;
        this._blocked = blocked;
        this.sync();
    }

    start() {
        this._channel.start();
    }

    // Says goodbye to the gate. A locked screen keeps the requests waiting.
    stop() {
        const writes = this._channel.tell('ui', this._desktop.isLocked() ? 'locked' : 'off');
        this._signals.forEach(([object, id]) => object.disconnect(id));
        this._channel.stop();
        this._cancellable.cancel();
        const activity = this._activity.close();
        if (this._retryId)
            GLib.source_remove(this._retryId);
        this._retryId = 0;
        const dialog = this._dialog;
        this._dialog = this._queue = this._lastAnswers = this._names = null;
        dialog?.dismiss();
        return {writes, activity};
    }

    // When the gate comes or goes, the kill switch flips or the screen locks
    sync() {
        if (!this._queue)
            return;
        if (!this._channel.active) {
            this._queue.clear();
            this._dialog?.close();
            return;
        }
        this._channel.tell('block', this._blocked ? '1' : '0');
        if (this._desktop.isLocked()) {
            this._dialog?.close();
            this._channel.tell('ui', 'locked');
            return;
        }
        this._channel.readiness();
        this._next();
    }

    // The name the popup showed, which beats what an app calls itself
    nameOf(recording) {
        return this._names?.get(recording.serial) ??
            (recording.app || recording.flatpak || recording.binary || null);
    }

    // Takes an answer back. No more follow-ups, no remembered rule,
    // and an allowed recording that's still going stops.
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
        if (this._queue)
            this._settings.set_string('undo', '');
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
        if (!this._queue || this._desktop.isLocked() || !this._channel.active ||
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
        const dialog = this._desktop.ask(app, request.kind, request.source);
        dialog.requestId = id;
        dialog.connect('response', (_d, allowed, remember) => {
            const current = this._queue?.get(id)?.request;
            if (this._desktop.isLocked() || current?.serial !== request.serial ||
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
        dialog.dismiss();
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
