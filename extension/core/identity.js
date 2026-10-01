// SPDX-FileCopyrightText: 2026 miralemalic
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');

// Apps run in scopes like app-gnome-org.gnome.Maps-1234.scope, or
// app-codium-1234.scope when they start themselves.
const SCOPE = /app-(?:(?:gnome|flatpak)-)?(.+?)-\d+\.scope/;

async function read(path, cancellable) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return new TextDecoder().decode(bytes);
    } catch {
        return '';
    }
}

async function exeOf(pid, cancellable) {
    try {
        const info = await Gio.File.new_for_path(`/proc/${pid}/exe`).query_info_async(
            'standard::symlink-target', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT, cancellable);
        return info.get_symlink_target();
    } catch {
        return null;
    }
}

function desktopApp(id) {
    return id ? GioUnix.DesktopAppInfo.new(`${id}.desktop`) : null;
}

async function appOfPid(pid, cancellable) {
    const [, scope] = (await read(`/proc/${pid}/cgroup`, cancellable)).match(SCOPE) ?? [];
    return desktopApp(scope?.replace(/\\x([0-9a-f]{2})/g,
        (_, hex) => String.fromCharCode(parseInt(hex, 16))));
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

// Who is asking, as far as that can be trusted. When an app connects to
// PipeWire itself, the kernel tells us its pid. Through pipewire-pulse all
// we get is what the app says about itself.
export async function identify(request, cancellable = null) {
    const {sec_pid: pid, flatpak, binary} = request;

    if (request.sandboxed)
        return describe(`flatpak:${flatpak}`, desktopApp(flatpak), flatpak, flatpak, true);

    const exe = await exeOf(pid, cancellable);
    const program = exe && GLib.path_get_basename(exe);
    if (program && program !== 'pipewire') {
        // Remembering goes by program, so python3 covers every script
        const app = describe(`exe:${exe}`, await appOfPid(pid, cancellable),
            request.app ?? program, exe, true);
        return {...app, program};
    }

    // A claimed pid is good for a name and an icon, nothing more, and only
    // if that process really runs the program the app claims
    const mine = request.pid && binary &&
        (await read(`/proc/${request.pid}/comm`, cancellable)).trim() === binary.slice(0, 15);
    let launched = mine ? await appOfPid(request.pid, cancellable) : null;
    if (!launched?.get_executable()?.includes(binary))
        launched = null;

    // Chromium-based apps all call themselves "Chromium input", so the
    // program name says more. Rules go by both, and a web app by its own
    // launcher, so apps sharing electron or a browser don't share a rule.
    const named = request.app?.startsWith('Chromium') ? null : request.app;
    const claim = flatpak ?? launched?.get_id().replace(/\.desktop$/, '') ??
        ([binary, named].filter(Boolean).join(' / ') || null);
    const info = desktopApp(flatpak) ?? launched;
    const app = describe(claim && `app:${claim}`, info, named ?? binary ?? flatpak, binary, false);
    return {...app, claim: app.name};
}
