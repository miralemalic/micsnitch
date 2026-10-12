// Tests for the shared parts, which need neither GNOME Shell nor KDE
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
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
const {appIdOf, identify} = await import('../core/identity.js');

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
    ['0::/user.slice/user-1000.slice/session-2.scope', undefined],
])
    assert(appIdOf(cgroup) === id, `${cgroup} should belong to ${id}, not ${appIdOf(cgroup)}`);
print('PASS: GNOME and KDE launchers both lead to the app');

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

for (const path of ['micsnitch-activity.json', 'bin/pw-metadata', 'writes']) {
    const file = Gio.File.new_for_path(`${directory}/${path}`);
    if (file.query_exists(null)) file.delete(null);
}
for (const path of ['bin', ''])
    Gio.File.new_for_path(`${directory}/${path}`).delete(null);
