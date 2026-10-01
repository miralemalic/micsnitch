// SPDX-FileCopyrightText: 2026 miralemalic
// SPDX-License-Identifier: GPL-3.0-or-later

// Keep the last few choices made by the popup in this login's runtime folder.
// The popup keeps this local instead of publishing it on PipeWire metadata.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const LIMIT = 10;

export class Activity extends GObject.Object {
    static [GObject.signals] = {'changed': {}};
    static {
        GObject.registerClass(this);
    }

    #events = [];
    #session;
    #cancellable = new Gio.Cancellable();
    #file = Gio.File.new_for_path(GLib.build_filenamev([
        GLib.get_user_runtime_dir(), 'micsnitch-activity.json',
    ]));
    #writes;

    constructor(session) {
        super();
        this.#session = session;
        this.#writes = this.#load();
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
            // A fresh login has no history yet.
        }
    }

    add(event) {
        // Queue saves behind the initial read and behind each other.
        this.#writes = this.#writes.then(async () => {
            if (this.#cancellable.is_cancelled())
                return;
            this.#events.push({...event, time: Math.floor(Date.now() / 1000)});
            this.#events = this.#events.slice(-LIMIT);
            this.emit('changed');
            const saved = {session: this.#session, events: this.#events};
            await this.#file.replace_contents_bytes_async(
                new GLib.Bytes(new TextEncoder().encode(JSON.stringify(saved))), null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
                this.#cancellable);
        }).catch(e => {
            if (!this.#cancellable.is_cancelled())
                logError(e, 'Cannot save MicSnitch activity');
        });
        return this.#writes;
    }

    close() {
        this.#cancellable.cancel();
        return this.#writes;
    }
}
