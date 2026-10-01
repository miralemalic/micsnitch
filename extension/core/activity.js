// SPDX-FileCopyrightText: 2026 miralemalic
// SPDX-License-Identifier: GPL-3.0-or-later

// The last few decisions, kept in this login's runtime folder and nowhere else.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const LIMIT = 50;

export function activityFile() {
    return Gio.File.new_for_path(GLib.build_filenamev([
        GLib.get_user_runtime_dir(), 'micsnitch-activity.json',
    ]));
}

// "14:05 · Allowed · Microphone · remembered rule". Takes the caller's gettext,
// since the menu and the settings window each have their own.
export function describeEvent(event, _) {
    const action = {allow: _('Allowed'), deny: _('Denied'), stop: _('Stopped')}[event.action];
    const kind = event.kind === 'mic' ? _('Microphone') : _('System audio');
    const reason = {
        remembered: _('remembered rule'), system: _('system audio setting'),
    }[event.reason];
    return [GLib.DateTime.new_from_unix_local(event.time).format('%H:%M'),
        action, kind, reason, event.undone && _('undone')].filter(Boolean).join(' · ');
}

// Allows and denials that point at an app can be taken back
export function canUndo(event) {
    return Boolean(event.id && event.key && !event.undone) &&
        ['allow', 'deny'].includes(event.action);
}

export class Activity extends GObject.Object {
    static [GObject.signals] = {'changed': {}};
    static {
        GObject.registerClass(this);
    }

    #events = [];
    #session;
    #closed = false;
    #cancellable = new Gio.Cancellable();
    #file = activityFile();
    #writes;

    // Reads only once whatever an earlier instance is still saving has landed
    constructor(session, previous = Promise.resolve()) {
        super();
        this.#session = session;
        this.#writes = previous.then(() => this.#load());
    }

    get events() {
        return this.#events;
    }

    get loaded() {
        return this.#writes;
    }

    async #load() {
        try {
            const [bytes] = await this.#file.load_contents_async(this.#cancellable);
            const saved = JSON.parse(new TextDecoder().decode(bytes));
            if (saved?.session === this.#session && Array.isArray(saved.events))
                this.#events = saved.events.filter(event => event && Number.isFinite(event.time) &&
                    ['allow', 'deny', 'stop'].includes(event.action)).slice(-LIMIT);
            this.emit('changed');
        } catch {
            // A fresh login has no history yet
        }
    }

    add(event) {
        return this.#change(() => {
            this.#events.push({...event, id: GLib.uuid_string_random(),
                time: Math.floor(Date.now() / 1000)});
            this.#events = this.#events.slice(-LIMIT);
        });
    }

    undo(id) {
        return this.#change(() => {
            const event = this.#events.find(e => e.id === id);
            if (event)
                event.undone = true;
        });
    }

    // Changes wait for the first read and for each other. A save is never
    // cancelled: half a file would lose the whole list.
    #change(edit) {
        this.#writes = this.#writes.then(async () => {
            if (this.#closed)
                return;
            edit();
            this.emit('changed');
            const saved = {session: this.#session, events: this.#events};
            await this.#file.replace_contents_bytes_async(
                new GLib.Bytes(new TextEncoder().encode(JSON.stringify(saved))), null, false,
                Gio.FileCreateFlags.PRIVATE, null);
        }).catch(e => logError(e, 'Cannot save MicSnitch activity'));
        return this.#writes;
    }

    close() {
        this.#closed = true;
        this.#cancellable.cancel();
        return this.#writes;
    }
}
