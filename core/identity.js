// SPDX-FileCopyrightText: 2026 miralemalic
// SPDX-License-Identifier: MIT

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');

// Apps run in units like app-gnome-org.gnome.Maps-1234.scope, or
// app-codium-1234.scope when they start themselves. KDE starts them as
// app-org.kde.konsole@<random>.service or app-org.kde.dolphin-<random>.scope,
// and what GNOME starts over D-Bus is dbus-:1.2-org.gnome.Snapshot@0.service.
const UNIT = /(?:app-(?:(?:gnome|flatpak)-)?|dbus-:[\d.]+-)(.+?)(?:-[0-9a-f]+\.scope|@[^/]+\.service)/;
// A snap runs as snap.firefox.firefox-<uuid>.scope, and its launcher is firefox_firefox
const SNAP = /snap\.([^./]+)\.([^/]+?)-[0-9a-f]{8}-[0-9a-f-]+\.scope/;

// Programs that run other programs. Remembering one of these by itself
// would cover every script on the machine.
const INTERPRETERS = [
    'python', 'pypy', 'node', 'nodejs', 'deno', 'bun', 'bash', 'sh', 'dash', 'zsh', 'fish',
    'perl', 'ruby', 'lua', 'luajit', 'php', 'java', 'gjs', 'gjs-console', 'mono', 'dotnet',
    'electron', 'wine', 'wine-preloader', 'wine64-preloader',
];

const GONE = ' (deleted)';

async function read(path, cancellable) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return new TextDecoder().decode(bytes);
    } catch {
        return '';
    }
}

// Two paths, one file?
async function same(a, b, cancellable) {
    try {
        const [x, y] = await Promise.all([a, b].map(path => Gio.File.new_for_path(path)
            .query_info_async('unix::device,unix::inode', Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT, cancellable)));
        return ['unix::device', 'unix::inode'].every(attribute =>
            x.get_attribute_as_string(attribute) === y.get_attribute_as_string(attribute));
    } catch {
        return false;
    }
}

// The program a process runs, if the path it gives can be believed
async function exeOf(pid, cancellable) {
    let exe = null;
    try {
        const info = await Gio.File.new_for_path(`/proc/${pid}/exe`).query_info_async(
            'standard::symlink-target', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT, cancellable);
        exe = info.get_symlink_target();
    } catch {
        // No such process
    }
    // One that has just ended is still listed, with nothing behind the link
    if (!exe)
        return null;
    // An update swapped the file while the program runs. The path was true when
    // it started, as long as the program sees the same disk we do.
    if (exe.endsWith(GONE)) {
        return await same(`/proc/${pid}/ns/mnt`, '/proc/self/ns/mnt', cancellable)
            ? exe.slice(0, -GONE.length) : null;
    }
    // With mounts of its own a program can sit at any path it likes
    return await same(`/proc/${pid}/exe`, exe, cancellable) ? exe : null;
}

function desktopApp(id) {
    return id ? GioUnix.DesktopAppInfo.new(`${id}.desktop`) : null;
}

// The launcher's app ID in a process's cgroup, if a launcher started it
export function appIdOf(cgroup) {
    const [, snap, app] = cgroup.match(SNAP) ?? [];
    if (snap)
        return `${snap}_${app}`;
    const [, id] = cgroup.match(UNIT) ?? [];
    return id?.replace(/\\x([0-9a-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Anything can run in a launcher's scope, say in its terminal. The launcher only
// speaks for a program when its own command names something that program was started with.
export function starts(launcher, command) {
    const names = command.map(word => GLib.path_get_basename(word));
    return launcher.split(/\s+/).some(word =>
        !word.startsWith('-') && names.includes(GLib.path_get_basename(word)));
}

async function appOfPid(pid, cancellable) {
    return desktopApp(appIdOf(await read(`/proc/${pid}/cgroup`, cancellable)));
}

function describe(key, info, name, detail, verified) {
    return {
        key,
        detail,
        verified,
        name: info?.get_name() ?? name,
        icon: info?.get_icon() ?? null,
    };
}

// Who is asking, as far as that can be trusted.
// When an app connects to PipeWire itself, the kernel tells us its pid.
// Through pipewire-pulse all we get is what the app says about itself.
export async function identify(request, cancellable = null) {
    const {sec_pid: pid, flatpak, binary} = request;

    if (request.sandboxed)
        return describe(`flatpak:${flatpak}`, desktopApp(flatpak), flatpak, flatpak, true);

    const exe = await exeOf(pid, cancellable);
    const program = exe && GLib.path_get_basename(exe);
    if (program && program !== 'pipewire') {
        const [, ...args] = (await read(`/proc/${pid}/cmdline`, cancellable)).split('\0');
        const command = [exe, ...args.filter(Boolean)];
        let launcher = await appOfPid(pid, cancellable);
        if (!starts(launcher?.get_commandline() ?? '', command))
            launcher = null;

        // python3.14 is python. The loader and qemu run anything too.
        const runner = program.replace(/[\d.]+$/, '');
        if (INTERPRETERS.includes(runner) || /^(ld-|qemu-)/.test(program)) {
            // A script is remembered together with its launcher, or not at all.
            // What it was started with is its own word, so that's only shown.
            const id = launcher?.get_id().replace(/\.desktop$/, '');
            const line = command.join(' ');
            return describe(id && `script:${id}:${exe}`, launcher, request.app ?? program,
                line.length > 80 ? `${line.slice(0, 79)}…` : line, true);
        }
        // Remembering goes by program
        const app = describe(`exe:${exe}`, launcher, request.app ?? program, exe, true);
        return {...app, program};
    }

    // A claimed pid is good for a name and an icon, nothing more,
    // and only if that process really runs the program the app claims
    const mine = request.pid && binary &&
        (await read(`/proc/${request.pid}/comm`, cancellable)).trim() === binary.slice(0, 15);
    let launched = mine ? await appOfPid(request.pid, cancellable) : null;
    if (!launched?.get_commandline()?.includes(binary))
        launched = null;

    // Chromium-based apps all call themselves "Chromium input", so the program name says more.
    // Rules go by both, and a web app by its own launcher,
    // so apps sharing electron or a browser don't share a rule.
    const named = request.app?.startsWith('Chromium') ? null : request.app;
    const claim = flatpak ?? launched?.get_id().replace(/\.desktop$/, '') ??
        ([binary, named].filter(Boolean).join(' / ') || null);
    const info = desktopApp(flatpak) ?? launched;
    const app = describe(claim && `app:${claim}`, info, named ?? binary ?? flatpak, binary, false);
    return {...app, claim: app.name};
}
