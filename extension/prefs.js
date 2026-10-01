// SPDX-FileCopyrightText: 2026 miralemalic
// SPDX-License-Identifier: MIT

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {activityFile, canUndo, describeEvent} from './core/activity.js';

function nameOf(key) {
    const [kind, value] = key.split(/:(.*)/);
    if (kind === 'exe')
        return GLib.path_get_basename(value);
    // Flatpak and launcher IDs have a name, "program / name" claims don't
    const info = value.includes('/') ? null : GioUnix.DesktopAppInfo.new(`${value}.desktop`);
    return info?.get_name() ?? value;
}

function button(label, props) {
    return new Gtk.Button({valign: Gtk.Align.CENTER, css_classes: ['flat'], label, ...props});
}

// Swaps a group's rows for new ones, or a placeholder when there are none
function replaceRows(group, rows, fresh) {
    rows.splice(0).forEach(row => group.remove(row));
    rows.push(...fresh.length ? fresh : [new Adw.ActionRow({title: _('None yet')})]);
    rows.forEach(row => group.add(row));
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
        settings.bind('system-audio', systemAudio, 'active', Gio.SettingsBindFlags.DEFAULT);
        general.add(systemAudio);

        const remembered = new Adw.PreferencesGroup({
            title: _('Remembered Apps'),
            description: _('These apps are not asked again.'),
        });
        page.add(remembered);
        const ruleRows = [];
        const showRules = () => {
            const rules = settings.get_value('rules').deepUnpack();
            replaceRows(remembered, ruleRows, Object.entries(rules).map(([rule, answer]) => {
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
                const forget = button(null, {icon_name: 'edit-delete-symbolic', tooltip_text: _('Forget')});
                forget.connect('clicked', () => {
                    delete rules[rule];
                    settings.set_value('rules', new GLib.Variant('a{ss}', rules));
                });
                row.add_suffix(forget);
                return row;
            }));
        };

        const recent = new Adw.PreferencesGroup({
            title: _('Recent Activity'),
            description: _('Decisions since you logged in, newest first. No audio is kept.'),
        });
        page.add(recent);
        const eventRows = [];
        const showEvents = () => {
            let events = [];
            try {
                const [, bytes] = GLib.file_get_contents(activityFile().get_path());
                events = JSON.parse(new TextDecoder().decode(bytes)).events;
            } catch {
                // Nothing decided yet this login
            }
            replaceRows(recent, eventRows, events.slice().reverse().map(event => {
                const row = new Adw.ActionRow({
                    title: event.app || _('Unnamed app'),
                    subtitle: [describeEvent(event, _), event.source].filter(Boolean).join(' · '),
                    use_markup: false,
                });
                if (canUndo(event)) {
                    // The popup does the undoing and clears the key when done
                    const undo = button(_('Undo'));
                    undo.connect('clicked', () => {
                        undo.sensitive = false;
                        settings.set_string('undo', event.id);
                    });
                    row.add_suffix(undo);
                }
                return row;
            }));
        };

        const signals = [
            settings.connect('changed::rules', showRules),
            settings.connect('changed::undo', () => {
                if (!settings.get_string('undo'))
                    showEvents();
            }),
        ];
        showRules();
        showEvents();
        window.connect('close-request', () => {
            signals.forEach(id => settings.disconnect(id));
            return false;
        });
    }
}
