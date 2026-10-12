// SPDX-FileCopyrightText: 2026 miralemalic
// SPDX-License-Identifier: MIT

// What the tray icon opens: who is recording, what you decided
// and what MicSnitch remembers, plus the switches
import Adw from 'gi://Adw';
import Gettext from 'gettext';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import {button, eventRow, kindName, replaceRows, ruleRows} from './core/rows.js';

const {gettext: _} = Gettext.domain('micsnitch');

export const MainWindow = GObject.registerClass(
class MainWindow extends Adw.ApplicationWindow {
    _init(application, handler, settings) {
        super._init({application, title: _('MicSnitch'), default_width: 480, default_height: 680});

        const page = new Adw.PreferencesPage();
        const banner = new Adw.Banner({title: _('Protection unavailable: the MicSnitch policy isn’t running')});
        const view = new Adw.ToolbarView({content: page});
        view.add_top_bar(new Adw.HeaderBar());
        view.add_top_bar(banner);
        this.set_content(view);

        const general = new Adw.PreferencesGroup();
        page.add(general);
        const microphone = new Adw.SwitchRow({
            title: _('Microphone'),
            subtitle: _('Off cuts every recording and refuses new ones'),
        });
        settings.bind('disable-microphone', microphone, 'active', Gio.SettingsBindFlags.INVERT_BOOLEAN);
        general.add(microphone);
        const systemAudio = new Adw.SwitchRow({
            title: _('Ask Before Recording System Audio'),
            subtitle: _('What your speakers play, like the other side of a call'),
        });
        settings.bind('system-audio', systemAudio, 'active', Gio.SettingsBindFlags.DEFAULT);
        general.add(systemAudio);

        const recording = new Adw.PreferencesGroup({title: _('Recording Now')});
        const recent = new Adw.PreferencesGroup({
            title: _('Recent Activity'),
            description: _('Decisions since you logged in, newest first. No audio is kept.'),
        });
        const remembered = new Adw.PreferencesGroup({
            title: _('Remembered Apps'),
            description: _('These apps are not asked again.'),
        });
        [recording, recent, remembered].forEach(group => page.add(group));

        const {channel, activity} = handler;
        const recordingList = [], eventList = [], ruleList = [];
        const showRecordings = () => {
            banner.revealed = !channel.active;
            replaceRows(recording, recordingList, [...channel.recordings].map(([id, recorded]) => {
                const row = new Adw.ActionRow({
                    title: handler.nameOf(recorded) ?? _('Unnamed app'),
                    subtitle: [kindName(recorded.kind, _), recorded.source].filter(Boolean).join(' · '),
                    use_markup: false,
                });
                const stop = button({label: _('Stop')});
                stop.connect('clicked', () => {
                    stop.sensitive = false;
                    channel.stopRecording(id, recorded.serial);
                });
                row.add_suffix(stop);
                return row;
            }), _('No apps recording'));
        };
        const showEvents = () => replaceRows(recent, eventList, activity.events.slice().reverse()
            .map(event => eventRow(event, _, id => handler.undo(id))), _('None yet'));
        const showRules = () => replaceRows(remembered, ruleList, ruleRows(settings, _), _('None yet'));

        const signals = [
            [channel, channel.connect('notify::active', showRecordings)],
            [channel, channel.connect('recordings-changed', showRecordings)],
            [activity, activity.connect('changed', showEvents)],
            [settings, settings.connect('changed::rules', showRules)],
        ];
        this.connect('destroy', () => signals.forEach(([object, id]) => object.disconnect(id)));
        showRecordings();
        showEvents();
        showRules();
    }
});
