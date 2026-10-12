// SPDX-FileCopyrightText: 2026 miralemalic
// SPDX-License-Identifier: MIT

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {activityFile} from './core/activity.js';
import {eventRow, replaceRows, ruleRows} from './core/rows.js';

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
        const ruleList = [];
        const showRules = () => replaceRows(remembered, ruleList, ruleRows(settings, _), _('None yet'));

        const recent = new Adw.PreferencesGroup({
            title: _('Recent Activity'),
            description: _('Decisions since you logged in, newest first. No audio is kept.'),
        });
        page.add(recent);
        const eventList = [];
        const showEvents = () => {
            let events = [];
            try {
                const [, bytes] = GLib.file_get_contents(activityFile().get_path());
                events = JSON.parse(new TextDecoder().decode(bytes)).events;
            } catch {
                // Nothing decided yet this login
            }
            // The popup does the undoing and clears the key when done
            replaceRows(recent, eventList, events.slice().reverse().map(event =>
                eventRow(event, _, id => settings.set_string('undo', id))), _('None yet'));
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
