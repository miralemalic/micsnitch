// SPDX-FileCopyrightText: 2026 miralemalic
// SPDX-License-Identifier: MIT

// WirePlumber and the popup talk through the "micsnitch" metadata,
// and pw-metadata does the talking for us.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');

const NAME = 'micsnitch';
const UPDATE = /^update: id:(\d+) key:'(.*?)' value:'(.*)' type:'.*'$/;
const REMOVE = /^remove: id:(\d+) (?:key:'(.*)'|all keys)$/;

export class Channel extends GObject.Object {
    static [GObject.properties] = {
        'active': GObject.ParamSpec.boolean('active', null, null,
            GObject.ParamFlags.READABLE, false),
    };

    static [GObject.signals] = {
        'request': {param_types: [GObject.TYPE_UINT, GObject.TYPE_JSOBJECT]},
        'withdrawn': {param_types: [GObject.TYPE_UINT]},
        'recordings-changed': {},
        'stopped': {param_types: [GObject.TYPE_JSOBJECT]},
    };

    static {
        GObject.registerClass(this);
    }

    #activeId = null;
    #monitor = null;
    #cancellable = null;
    #retryId = 0;
    #running = false;
    #writes;
    #recordings = new Map();
    #stopping = new Map();

    constructor(pendingWrites = Promise.resolve()) {
        super();
        this.#writes = pendingWrites;
    }

    get active() {
        return this.#activeId !== null;
    }

    get recordings() {
        return this.#recordings;
    }

    start() {
        this.#running = true;
        this.#cancellable = new Gio.Cancellable();
        try {
            this.#monitor = Gio.Subprocess.new(
                ['stdbuf', '-oL', 'pw-metadata', '-m', '-n', NAME],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            this.#read(new Gio.DataInputStream({
                base_stream: this.#monitor.get_stdout_pipe(),
            }), this.#cancellable, this.#monitor);
        } catch (e) {
            logError(e, 'Cannot start the MicSnitch connection');
            this.#retry();
        }
    }

    stop() {
        this.#running = false;
        if (this.#retryId)
            GLib.source_remove(this.#retryId);
        this.#retryId = 0;
        this.#cancellable?.cancel();
        this.#monitor?.force_exit();
        this.#monitor = null;
        this.#setActive(null);
    }

    // Node ids get reused and a stream can move from the speakers to the mic,
    // so an answer names the exact stream and kind it was for
    answer(id, serial, kind, allow) {
        return this.#set(id, 'micsnitch.answer',
            `${allow ? 'allow' : 'deny'} ${serial} ${kind}`);
    }

    stopRecording(id, serial) {
        this.#stopping.set(id, serial);
        return this.#set(id, 'micsnitch.stop', `${serial}`);
    }

    readiness() {
        const pid = this.#monitor?.get_identifier();
        if (pid)
            return this.tell('ui', `ready ${pid}`);
    }

    tell(key, value) {
        return this.#set(0, `micsnitch.${key}`, value);
    }

    #set(id, key, value) {
        // One at a time, so nothing overtakes what was sent before it
        this.#writes = this.#writes.then(async () => {
            const process = Gio.Subprocess.new(['pw-metadata', '-n', NAME, `${id}`, key, value],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            await process.wait_check_async(null);
        }).catch(e => logError(e, 'Cannot send a MicSnitch decision'));
        return this.#writes;
    }

    async #read(stream, cancellable, monitor) {
        const decoder = new TextDecoder();
        try {
            for (;;) {
                const [line] = await stream.read_line_async(
                    GLib.PRIORITY_DEFAULT, cancellable);
                if (line === null)
                    break;
                this.#parse(decoder.decode(line));
            }
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            logError(e);
        }
        if (this.#monitor === monitor)
            this.#retry();
    }

    #retry() {
        this.#setActive(null);
        if (!this.#running || this.#retryId)
            return;
        // pw-metadata goes away along with PipeWire, so wait for it to return
        this.#retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this.#retryId = 0;
            this.start();
            return GLib.SOURCE_REMOVE;
        });
    }

    #parse(line) {
        let match = line.match(UPDATE);
        if (match) {
            const id = Number(match[1]);
            const [, , key, value] = match;
            if (key === 'micsnitch.active' && value === '2' && id > 0) {
                this.#setActive(id);
                return;
            }
            if (!['micsnitch.request', 'micsnitch.recording'].includes(key))
                return;
            try {
                const data = JSON.parse(value);
                if (key === 'micsnitch.request')
                    this.emit('request', id, data);
                else if (key === 'micsnitch.recording') {
                    this.#recordings.set(id, data);
                    this.emit('recordings-changed');
                }
            } catch (e) {
                logError(e, 'Unreadable MicSnitch update');
            }
            return;
        }

        match = line.match(REMOVE);
        if (!match)
            return;
        const id = Number(match[1]);
        const key = match[2] ?? null;
        if (id === this.#activeId && (key === null || key === 'micsnitch.active'))
            this.#setActive(null);
        if (key === null || key === 'micsnitch.request')
            this.emit('withdrawn', id);
        if ((key === null || key === 'micsnitch.recording') && this.#recordings.has(id)) {
            const recording = this.#recordings.get(id);
            if (this.#stopping.get(id) === recording.serial)
                this.emit('stopped', recording);
            this.#stopping.delete(id);
            this.#recordings.delete(id);
            this.emit('recordings-changed');
        }
    }

    #setActive(id) {
        if (this.#activeId === id)
            return;
        this.#activeId = id;
        if (id === null && this.#recordings.size) {
            this.#stopping.clear();
            this.#recordings.clear();
            this.emit('recordings-changed');
        }
        this.notify('active');
    }
}
