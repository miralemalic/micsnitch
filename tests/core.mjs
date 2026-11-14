// Tests for the shared parts, which need neither GNOME Shell nor KDE
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import System from 'system';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

// GLib picks the runtime folder at startup, so run in a fresh process.
// This test must never touch the desktop's real activity file.
if (!GLib.getenv('MICSNITCH_EXTENSION_TEST_RUNTIME')) {
    const temporary = GLib.dir_make_tmp('micsnitch-extension-XXXXXX');
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    launcher.setenv('XDG_RUNTIME_DIR', temporary, true);
    launcher.setenv('MICSNITCH_EXTENSION_TEST_RUNTIME', temporary, true);
    const child = launcher.spawnv(['gjs', '-m', GLib.filename_from_uri(import.meta.url)[0]]);
    const [, stdout, stderr] = child.communicate_utf8(null, null);
    if (stdout) print(stdout.trim());
    if (stderr) printerr(stderr.trim());
    System.exit(child.get_exit_status());
}
const directory = GLib.getenv('MICSNITCH_EXTENSION_TEST_RUNTIME');
assert(directory === GLib.get_user_runtime_dir() &&
    GLib.path_get_basename(directory).startsWith('micsnitch-extension-'),
    'The test needs its own runtime directory');
const bin = `${directory}/bin`;
GLib.mkdir_with_parents(bin, 0o700);
GLib.setenv('PATH', `${bin}:${GLib.getenv('PATH')}`, true);
GLib.setenv('TEST_WRITES', `${directory}/writes`, true);

const {Activity} = await import('../core/activity.js');
const {Channel} = await import('../core/channel.js');
const {Handler} = await import('../core/handler.js');
const {appIdOf, identify, starts} = await import('../core/identity.js');

function pause(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function until(done, what) {
    for (let i = 0; i < 250 && !done(); i++)
        await pause(20);
    assert(done(), `Timed out waiting for ${what}`);
}

const chat = await identify({app: 'Discord', binary: 'electron'});
const slack = await identify({app: 'Slack', binary: 'electron'});
assert(chat.key !== slack.key, 'Apps sharing an executable must not share an unverified rule');
for (const app of [chat, slack])
    assert(app.claim === app.name, 'The checkbox must name what the popup shows');
assert(chat.name === 'Discord', 'An app is shown by the name it gives');

// Real Electron and Qt WebEngine apps all call themselves "Chromium input"
const chromium = await identify({app: 'Chromium input', binary: 'Discord'});
const signal = await identify({app: 'Chromium input', binary: 'Signal'});
assert(chromium.name === 'Discord' && signal.name === 'Signal',
    'A Chromium-based app is shown by its program name');
assert(chromium.key !== signal.key, 'Chromium-based apps must not share a rule');
const zapzap = await identify({app: 'Chromium input', binary: 'QtWebEngineProcess',
    flatpak: 'com.rtosta.zapzap'});
assert(zapzap.key === 'app:com.rtosta.zapzap', 'A Flatpak app is remembered by its app ID');
print('PASS: unverified names have separate rules and matching labels');

const apps = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/';
const random = '0b5c4f3b9a7e4d6f8c1a2b3c4d5e6f70';
for (const [cgroup, id] of [
    [`${apps}app-gnome-org.gnome.Maps-1234.scope`, 'org.gnome.Maps'],
    [`${apps}app-codium-4242.scope`, 'codium'],
    [`${apps}app-org.kde.konsole@${random}.service`, 'org.kde.konsole'],
    [`${apps}app-org.kde.dolphin-${random}.scope`, 'org.kde.dolphin'],
    [`${apps}app-org.kde.kdeconnect\\x2dapp@${random}.service`, 'org.kde.kdeconnect-app'],
    [`${apps}dbus-:1.2-org.gnome.Snapshot@0.service`, 'org.gnome.Snapshot'],
    [`${apps}snap.firefox.firefox-0b5c4f3b-9a7e-4d6f-8c1a-2b3c4d5e6f70.scope`, 'firefox_firefox'],
    ['0::/user.slice/user-1000.slice/session-2.scope', undefined],
])
    assert(appIdOf(cgroup) === id, `${cgroup} should belong to ${id}, not ${appIdOf(cgroup)}`);
print('PASS: GNOME and KDE launchers both lead to the app');

assert(starts('/usr/share/codium/codium --unity-launch %F', ['/usr/share/codium/codium']) &&
    starts('gnome-music', ['/usr/bin/python3.14', '/usr/bin/gnome-music']),
    'A launcher speaks for the program it starts, also when an interpreter runs it');
assert(!starts('/usr/share/codium/codium --unity-launch %F', ['/usr/bin/arecord', '-f', 'cd']) &&
    !starts('konsole', ['/usr/bin/python3.14', 'listen.py']),
    'A launcher must not lend its name to what runs in its terminal');

// A program of our own to point at. Two copies, so one can pass for the other.
const sleep = Gio.File.new_for_path(GLib.find_program_in_path('sleep'));
for (const copy of ['real', 'mask']) {
    GLib.mkdir_with_parents(`${directory}/${copy}`, 0o700);
    sleep.copy(Gio.File.new_for_path(`${directory}/${copy}/sleep`), Gio.FileCopyFlags.NONE, null, null);
}
const running = Gio.Subprocess.new([`${directory}/real/sleep`, '60'], Gio.SubprocessFlags.NONE);
const direct = await identify({sec_pid: running.get_identifier(), app: 'Recorder'});
assert(direct.verified && direct.key === `exe:${directory}/real/sleep` && direct.program === 'sleep',
    'An app that connects by itself is known by its program');
// What a package update does to a program that's running
Gio.File.new_for_path(`${directory}/real/sleep`).delete(null);
const updated = await identify({sec_pid: running.get_identifier(), app: 'Recorder'});
assert(updated.verified && updated.key === direct.key && updated.detail === `${directory}/real/sleep`,
    `A program replaced on disk keeps its rule, not ${updated.key}`);
running.force_exit();

// A script is its interpreter as far as the kernel knows. Without a launcher
// of its own there's nothing narrow enough to remember it by.
const script = Gio.Subprocess.new(['sh', '-c', 'sleep 60; :'], Gio.SubprocessFlags.NONE);
const scripted = await identify({sec_pid: script.get_identifier(), app: 'Script'});
assert(scripted.verified && !scripted.key && scripted.detail.endsWith('-c sleep 60; :'),
    `A script run by hand must not be remembered, as ${scripted.key} would be`);
script.force_exit();

sleep.copy(Gio.File.new_for_path(`${directory}/real/sleep`), Gio.FileCopyFlags.NONE, null, null);
const disguised = Gio.Subprocess.new(['unshare', '-Urm', 'sh', '-c',
    `mount --bind ${directory}/real/sleep ${directory}/mask/sleep && exec ${directory}/mask/sleep 60`],
Gio.SubprocessFlags.STDERR_SILENCE);
const mask = Gio.File.new_for_path(`/proc/${disguised.get_identifier()}/exe`);
const claims = () => mask.query_info('standard::symlink-target',
    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null).get_symlink_target();
let masked = false;
for (let i = 0; i < 100 && !masked; i++) {
    await pause(20);
    try {
        masked = claims() === `${directory}/mask/sleep`;
    } catch {
        // Not started yet, or it never will
    }
}
if (masked) {
    const liar = await identify({sec_pid: disguised.get_identifier(), app: 'Recorder', binary: 'sleep'});
    assert(!liar.verified && !liar.key.startsWith('exe:'),
        `A program sitting at a borrowed path must not be vouched for, as ${liar.key} was`);
    print('PASS: a program is known by the file it really runs, and a script not by its interpreter');
} else {
    print('SKIP: no mount namespaces here, so the borrowed path went untested');
}
disguised.force_exit();

const activity = new Activity('first-login');
await activity.loaded;
for (let i = 0; i < 60; i++) {
    await activity.add({time: Math.floor(GLib.get_real_time() / 1e6), app: `Test app ${i}`,
        kind: 'mic', action: 'allow', reason: 'once'});
}
await activity.close();
const restored = new Activity('first-login');
await restored.loaded;
assert(restored.events.length === 50 && restored.events[0].app === 'Test app 10' &&
    restored.events.at(-1).app === 'Test app 59',
    'Activity must retain the latest 50 decisions in the order they happened');
assert(restored.events.every(e => e.id) && new Set(restored.events.map(e => e.id)).size === 50,
    'Every decision needs its own id to be undone by');
await restored.undo(restored.events.at(-1).id);
await restored.close();
const cache = Gio.File.new_for_path(`${directory}/micsnitch-activity.json`);
const [, info] = GLib.file_get_contents(cache.get_path());
const stored = JSON.parse(new TextDecoder().decode(info));
assert(stored.session === 'first-login' && stored.events.length === 50,
    'Activity must be stored locally as a small list for this login');
assert(stored.events.at(-1).undone === true && !stored.events.at(-2).undone,
    'An undo must be saved, and only for that decision');
assert((cache.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null)
    .get_attribute_uint32('unix::mode') & 0o777) === 0o600,
    'Only the owner may read the activity file');
const nextLogin = new Activity('next-login');
await nextLogin.loaded;
assert(nextLogin.events.length === 0, 'A different login must not show an old activity file');
await nextLogin.close();
print('PASS: private activity keeps 50 decisions, remembers undos and survives reloads');

GLib.file_set_contents(`${bin}/pw-metadata`, `#!/bin/sh
if [ "$1" != -m ]; then
    [ "$4" != micsnitch.ui ] || sleep 0.05
    [ "$4:$5" != micsnitch.block:1 ] || sleep 0.15
    printf '%s\\n' "$*" >> "$TEST_WRITES"
    exit
fi
cat <<'UPDATES'
update: id:0 key:'micsnitch.active' value:'2' type:'Spa:String'
update: id:77 key:'micsnitch.active' value:'2' type:'Spa:String'
update: id:12 key:'micsnitch.request' value:'{"serial":123,"kind":"mic","app":"Test app"}' type:'Spa:String:JSON'
update: id:12 key:'micsnitch.recording' value:'{"serial":123,"kind":"mic","source":"Test microphone"}' type:'Spa:String:JSON'
UPDATES
sleep 0.1
cat <<'UPDATES'
remove: id:12 all keys
remove: id:77 all keys
UPDATES
`);
GLib.chmod(`${bin}/pw-metadata`, 0o700);
const channel = new Channel();
let finish;
const complete = new Promise(resolve => { finish = resolve; });
let transitions = 0;
let request = false;
let withdrawn = false;
let recording = false;
channel.connect('notify::active', () => {
    transitions++;
    if (channel.active) {
        channel.readiness();
        channel.answer(12, 123, 'mic', true);
        channel.stopRecording(12, 123);
    } else {
        channel.stop();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            finish();
            return GLib.SOURCE_REMOVE;
        });
    }
});
channel.connect('request', (_c, id, data) => {
    request = id === 12 && data.serial === 123 && data.kind === 'mic';
});
channel.connect('withdrawn', (_c, id) => { withdrawn ||= id === 12; });
channel.connect('recordings-changed', () => {
    recording ||= channel.recordings.get(12)?.source === 'Test microphone';
});
channel.start();
await complete;
assert(transitions === 2 && request && withdrawn && recording && !channel.recordings.size,
    'Requests, actual recordings and subject removal must reach the UI');
const writes = new TextDecoder().decode(GLib.file_get_contents(`${directory}/writes`)[1]);
assert(writes.includes('allow 123 mic\n') && writes.includes('micsnitch.stop 123') &&
    /micsnitch.ui ready \d+/.test(writes),
    'Answers must include recording kind and readiness must include its monitor PID');
assert(writes.indexOf('micsnitch.ui ready') < writes.indexOf('allow 123 mic') &&
    writes.indexOf('allow 123 mic') < writes.indexOf('micsnitch.stop 123'),
    'Readiness writes must finish before decisions and Stop');
print('PASS: protocol tracks liveness, recording removal and scoped answers');

// A rapid lock/unlock creates a new Channel while old writes are still queued.
const previous = new Channel();
previous.tell('block', '1');
const previousWrites = previous.tell('ui', 'locked');
const next = new Channel(previousWrites);
next.tell('ui', 'ready 4242');
next.answer(99, 999, 'mic', true);
await next.tell('block', '0');
const handoff = new TextDecoder().decode(GLib.file_get_contents(`${directory}/writes`)[1]);
const ordered = ['micsnitch.block 1', 'micsnitch.ui locked',
    'micsnitch.ui ready 4242', 'allow 999 mic', 'micsnitch.block 0'];
assert(ordered.every((value, i) => handoff.indexOf(value) >= 0 &&
    (i === 0 || handoff.indexOf(ordered[i - 1]) < handoff.indexOf(value))),
    'Old lock writes must finish before the new connection publishes readiness and answers');
print('PASS: rapid lock/unlock preserves write order across connections');

// The handler, with a gate we play ourselves and a desktop that clicks for us
GLib.file_set_contents(`${bin}/pw-metadata`, `#!/bin/sh
if [ "$1" = -m ]; then exec tail -n +1 -f "$TEST_FEED"; fi
printf '%s\\n' "$*" >> "$TEST_WRITES"
`);
GLib.setenv('TEST_FEED', `${directory}/feed`, true);
const sent = () => new TextDecoder().decode(GLib.file_get_contents(`${directory}/writes`)[1]);
function board(...lines) {
    GLib.file_set_contents(`${directory}/feed`, lines.map(line => `${line}\n`).join(''));
    GLib.file_set_contents(`${directory}/writes`, '');
}
function post(id, key, value = null) {
    const line = value ? `update: id:${id} key:'micsnitch.${key}' value:'${
        typeof value === 'string' ? value : JSON.stringify(value)}' type:'Spa:String'`
        : `remove: id:${id} key:'micsnitch.${key}'`;
    const out = Gio.File.new_for_path(`${directory}/feed`).append_to(Gio.FileCreateFlags.NONE, null);
    out.write_all(new TextEncoder().encode(`${line}\n`), null);
    out.close(null);
}

// Only the 30 seconds after an answer go by this clock
let now = 1e9;
GLib.get_monotonic_time = () => now;

const tree = GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]));
GLib.spawn_command_line_sync(
    `glib-compile-schemas --targetdir=${directory} ${tree}/schemas`);
const settings = new Gio.Settings({
    settings_schema: Gio.SettingsSchemaSource.new_from_directory(directory, null, false)
        .lookup('org.gnome.shell.extensions.micsnitch', false),
    backend: Gio.memory_settings_backend_new(),
});
const rules = () => settings.get_value('rules').deepUnpack();
const remember = saved => settings.set_value('rules', new GLib.Variant('a{ss}', saved));

let click = [true, ''];
const asked = [];
const notices = [];
const Popup = GObject.registerClass({
    Signals: {
        'response': {param_types: [GObject.TYPE_BOOLEAN, GObject.TYPE_STRING]},
        'closed': {},
    },
}, class Popup extends GObject.Object {
    open() {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this.emit('response', ...click);
            this.close();
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    close() {
        if (!this._done)
            this.emit('closed');
        this._done = true;
    }

    dismiss() {
        this._done = true;
    }
});
const desktop = {
    session: 'handler-test',
    isLocked: () => false,
    ask: app => {
        asked.push(app.name);
        return new Popup();
    },
    notify: notice => notices.push(notice),
};

let serial = 100;
// An app asks, the way the gate tells it, and we see what comes back
async function knock(app, kind = 'mic') {
    const request = {serial: `${++serial}`, kind, app, binary: app.toLowerCase(), source: 'Test mic'};
    const popups = asked.length;
    post(serial, 'request', request);
    const answer = new RegExp(`${serial} micsnitch.answer (allow|deny) ${serial} ${kind}`);
    await until(() => answer.test(sent()), `an answer for ${app}`);
    post(serial, 'request');
    return {...request, id: serial, popup: asked.length > popups, answer: sent().match(answer)[1]};
}
const ACTIVE = "update: id:77 key:'micsnitch.active' value:'2' type:'Spa:String'";

board(ACTIVE);
let handler = new Handler(settings, desktop);
handler.start();
await until(() => /micsnitch.ui ready \d+/.test(sent()), 'the handler to say it is ready');

const first = await knock('Chatty');
now += 25e6;
const again = await knock('Chatty');
now += 25e6;
const later = await knock('Chatty');
assert(first.popup && !again.popup && again.answer === 'allow' && later.popup,
    'An Allow covers 30 seconds from the click, and knocking in between must not stretch that');

now += 40e6;
const recorder = await knock('Recorder');
post(recorder.id, 'recording', recorder);
await until(() => handler.channel.recordings.size === 1, 'the recording to show');
handler.channel.stopRecording(recorder.id, recorder.serial);
post(recorder.id, 'recording');
await until(() => handler.activity.events.some(e => e.action === 'stop'), 'the Stop to be listed');
now += 2e6;
assert((await knock('Recorder')).popup, 'After Stop the app must be asked again, 30 seconds or not');
print('PASS: one answer lasts 30 seconds from the click, and Stop ends it');

remember({'system:app:spy / Spy': 'deny'});
settings.set_boolean('system-audio', false);
const spy = await knock('Spy', 'system');
const player = await knock('Player', 'system');
assert(!spy.popup && spy.answer === 'deny' && !player.popup && player.answer === 'allow',
    'With system audio not asked about, a remembered no must still be a no');
settings.set_boolean('system-audio', true);
assert(notices.length === 1 && notices[0].what === 'denied' && notices[0].app === 'Spy',
    'An app refused by a remembered answer must be reported');
await knock('Spy', 'system');
assert(notices.length === 1, 'One notice per try, however often the app knocks');
now += 31e6;
await knock('Spy', 'system');
assert(notices.length === 2, 'The next try is reported again');
handler.act(notices[1]);
await until(() => !rules()['system:app:spy / Spy'], 'Undo on the notice to forget the answer');
assert((await knock('Spy', 'system')).popup, 'After Undo on the notice the app is asked again');
print('PASS: a remembered no holds, is reported once per try and can be undone from there');

click = [true, 'login'];
const daily = await knock('Daily');
click = [true, ''];
now += 60e6;
const sameDay = await knock('Daily');
assert(daily.popup && !sameDay.popup && sameDay.answer === 'allow' &&
    /^allow \S+$/.test(rules()['mic:app:daily / Daily']),
    'An answer remembered until logout must hold for this login');
remember({...rules(), 'mic:app:stale / Stale': 'allow some-other-login'});
assert((await knock('Stale')).popup, 'An answer from another login must not count');

post(sameDay.id, 'recording', sameDay);
await until(() => handler.channel.recordings.size === 1, 'the allowed recording to show');
await pause(200);
assert(!notices.some(n => n.what === 'forged'), 'A recording we allowed is no cause for alarm');
post(900, 'recording', {serial: '900', kind: 'mic', app: 'Sneak', binary: 'sneak', source: 'Test mic'});
await until(() => notices.some(n => n.what === 'forged'), 'the alarm');
const alarm = notices.find(n => n.what === 'forged');
await until(() => handler.activity.events.at(-1).reason === 'forged', 'the stray recording to be listed');
assert(alarm.app === 'Sneak', 'A recording nobody here allowed must be reported by name');
handler.act(alarm);
await until(() => sent().includes('900 micsnitch.stop 900'), 'Stop on the alarm to reach the gate');
print('PASS: an answer until logout holds, and a recording nobody allowed raises the alarm');

for (const tried of [950, 951])
    post(tried, 'refused', {serial: `${tried}`, kind: 'mic', app: 'Nosy', binary: 'nosy'});
await until(() => handler.activity.events.some(e => e.reason === 'off'), 'the refusal to be listed');
await pause(200);
assert(handler.activity.events.filter(e => e.app === 'Nosy' && e.reason === 'off').length === 1,
    'An app turned away while the microphone is off is listed once');

// A lock on GNOME: the handler goes and a new one takes over what it knew.
// Sneak was reported already, the other one got in while nobody watched.
post(960, 'request', {serial: '960', kind: 'mic', app: 'Chromium input', binary: 'Signal'});
await until(() => sent().includes('960 micsnitch.answer allow 960 mic'), 'an answer for Signal');
post(960, 'request');
let handed = handler.stop();
await Promise.all([handed.writes, handed.activity]);
board(ACTIVE,
    "update: id:900 key:'micsnitch.recording' value:'{\"serial\":\"900\",\"kind\":\"mic\",\"app\":\"Sneak\"}' type:'Spa:String'",
    "update: id:901 key:'micsnitch.recording' value:'{\"serial\":\"901\",\"kind\":\"mic\",\"app\":\"Creep\"}' type:'Spa:String'");
notices.length = 0;
handler = new Handler(settings, desktop, handed);
handler.start();
await until(() => notices.length > 0, 'the alarm after the lock');
await pause(200);
assert(notices.length === 1 && notices[0].app === 'Creep',
    'After a lock only what started behind our back is reported');
assert(handler.nameOf({serial: '960', app: 'Chromium input'}) === 'Signal',
    'An app must keep the name the popup gave it through a lock');
assert(!rules()['mic:app:stale / Stale'] && rules()['mic:app:daily / Daily'],
    'Answers from an earlier login are dropped, this login\'s stay');
handed = handler.stop();
await Promise.all([handed.writes, handed.activity]);

// Started from nothing, say after a crash: what records already is taken as it is
board(ACTIVE,
    "update: id:901 key:'micsnitch.recording' value:'{\"serial\":\"901\",\"kind\":\"mic\",\"app\":\"Creep\"}' type:'Spa:String'");
notices.length = 0;
handler = new Handler(settings, desktop);
handler.start();
await until(() => /micsnitch.ui ready \d+/.test(sent()), 'the fresh handler to say it is ready');
await pause(200);
assert(notices.length === 0, 'A fresh start must not report what was recording before it');
post(902, 'recording', {serial: '902', kind: 'mic', app: 'Late'});
await until(() => notices.length === 1, 'the alarm after a fresh start');
handed = handler.stop();
await Promise.all([handed.writes, handed.activity]);
print('PASS: refusals are listed once, and the watch for stray recordings survives a lock and a restart');

for (const path of ['micsnitch-activity.json', 'bin/pw-metadata', 'writes', 'feed', 'gschemas.compiled',
    'real/sleep', 'mask/sleep']) {
    const file = Gio.File.new_for_path(`${directory}/${path}`);
    if (file.query_exists(null)) file.delete(null);
}
for (const path of ['bin', 'real', 'mask', ''])
    Gio.File.new_for_path(`${directory}/${path}`).delete(null);
