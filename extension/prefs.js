// SPDX-FileCopyrightText: 2026 miralemalic
// SPDX-License-Identifier: GPL-3.0-or-later

// Choose whether to ask about system audio and forget remembered answers.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function nameOf(key) {
    const [kind, value] = key.split(/:(.*)/);
    if (kind === 'app')
        return value;
    const info = kind === 'exe' ? null : GioUnix.DesktopAppInfo.new(
        value.endsWith('.desktop') ? value : `${value}.desktop`);
    return info?.get_name() ?? GLib.path_get_basename(value);
}

export default class MicSnitchPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const general = new Adw.PreferencesGroup();
        page.add(general);

        const systemAudio = new Adw.SwitchRow({
            title: _('Ask Before Recording System Audio'),
            subtitle: _('What your speakers play, like the other side of a call'),
        });
        settings.bind('system-audio', systemAudio, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        general.add(systemAudio);

        const remembered = new Adw.PreferencesGroup({
            title: _('Remembered Apps'),
            description: _('These apps are not asked again.'),
        });
        page.add(remembered);

        const rows = [];
        const sync = () => {
            rows.splice(0).forEach(row => remembered.remove(row));

            const rules = settings.get_value('rules').deepUnpack();
            for (const [rule, answer] of Object.entries(rules)) {
                const [kind, key] = rule.split(/:(.*)/);
                const row = new Adw.ActionRow({
                    title: nameOf(key),
                    subtitle: [
                        kind === 'mic' ? _('Microphone') : _('System audio'),
                        answer === 'allow' ? _('Always allowed') : _('Always denied'),
                    ].join(' · '),
                    tooltip_text: key.split(/:(.*)/)[1],
                    use_markup: false,
                });
                const forget = new Gtk.Button({
                    icon_name: 'edit-delete-symbolic',
                    tooltip_text: _('Forget'),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                forget.connect('clicked', () => {
                    delete rules[rule];
                    settings.set_value('rules', new GLib.Variant('a{ss}', rules));
                });
                row.add_suffix(forget);
                rows.push(row);
            }

            if (rows.length === 0)
                rows.push(new Adw.ActionRow({title: _('None yet')}));
            rows.forEach(row => remembered.add(row));
        };
        const rulesSignal = settings.connect('changed::rules', sync);
        sync();

        window.connect('close-request', () => {
            settings.disconnect(rulesSignal);
            return false;
        });
    }
}
