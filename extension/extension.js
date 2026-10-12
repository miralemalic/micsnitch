// SPDX-FileCopyrightText: 2026 miralemalic
// SPDX-License-Identifier: MIT

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {canUndo, describeEvent} from './core/activity.js';
import {Handler} from './core/handler.js';
import {RequestDialog} from './dialog.js';

const MENU_EVENTS = 10;

function kindName(kind) {
    return kind === 'mic' ? _('Microphone') : _('System audio');
}

function menuRow(title, detail, label = null, action = null) {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    const labels = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
    labels.add_child(new St.Label({text: title}));
    labels.add_child(new St.Label({text: detail, style_class: 'micsnitch-detail'}));
    item.add_child(labels);
    if (label) {
        const button = new St.Button({
            label, style_class: 'button', can_focus: true,
            accessible_name: `${label}: ${title}`,
        });
        button.connect('clicked', () => {
            button.reactive = false;
            action();
        });
        item.add_child(button);
    }
    return item;
}

const MicToggle = GObject.registerClass(
class MicToggle extends QuickMenuToggle {
    _init(extension) {
        super._init({title: _('MicSnitch'), toggleMode: true});
        this._handler = extension._handler;
        extension._privacy.bind('disable-microphone', this, 'checked',
            Gio.SettingsBindFlags.INVERT_BOOLEAN);
        this.menu.setHeader('audio-input-microphone-symbolic', _('MicSnitch'));

        this._recordings = new PopupMenu.PopupMenuSection();
        this._recent = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Recording now')));
        this.menu.addMenuItem(this._recordings);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Recent activity')));
        this.menu.addMenuItem(this._recent);
        this.menu.addAction(_('Settings…'), () => {
            Main.panel.statusArea.quickSettings.menu.close();
            extension.openPreferences();
        });

        this.connect('notify::checked', () => this._sync());
        this._handler.channel.connectObject('notify::active', () => this._sync(),
            'recordings-changed', () => this._sync(), this);
        this._handler.activity.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const {channel, activity} = this._handler;

        // Without the policy nothing is guarded, so warn
        if (!channel.active)
            this.iconName = 'dialog-warning-symbolic';
        else if (this.checked)
            this.iconName = 'audio-input-microphone-symbolic';
        else
            this.iconName = 'microphone-disabled-symbolic';

        this._recordings.removeAll();
        for (const [id, recording] of channel.recordings) {
            this._recordings.addMenuItem(menuRow(
                this._handler.nameOf(recording) ?? _('Unnamed app'),
                [kindName(recording.kind), recording.source].filter(Boolean).join(' · '),
                _('Stop'), () => channel.stopRecording(id, recording.serial)));
        }
        if (!channel.recordings.size) {
            this._recordings.addMenuItem(new PopupMenu.PopupMenuItem(
                channel.active ? _('No apps recording') : _('Protection unavailable'),
                {reactive: false}));
        }

        this._recent.removeAll();
        for (const event of activity.events.slice(-MENU_EVENTS).reverse()) {
            this._recent.addMenuItem(menuRow(event.app || _('Unnamed app'),
                describeEvent(event, _),
                canUndo(event) ? _('Undo') : null, () => this._handler.undo(event.id)));
        }
        if (!activity.events.length) {
            this._recent.addMenuItem(new PopupMenu.PopupMenuItem(
                _('No decisions this login'), {reactive: false}));
        }
    }
});

const Indicator = GObject.registerClass(
class Indicator extends SystemIndicator {
    _init(extension) {
        super._init();
        this.quickSettingsItems.push(new MicToggle(extension));
    }
});

export default class MicSnitchExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._privacy = new Gio.Settings({schema_id: 'org.gnome.desktop.privacy'});
        this._handler = new Handler(this._settings, {
            isLocked: () => Main.sessionMode.isLocked,
            ask: (app, kind, source) => new RequestDialog(app, kind, source),
        }, this._previous);
        this._previous = null;
        const block = () => {
            this._handler.blocked = this._privacy.get_boolean('disable-microphone');
        };
        this._privacy.connectObject('changed::disable-microphone', block, this);
        block();
        this._indicator = new Indicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        this._handler.start();
    }

    disable() {
        // Locking switches us off; requests wait for the unlock
        this._previous = this._handler.stop();
        this._privacy.disconnectObject(this);
        this._indicator.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        this._settings = this._privacy = this._handler = this._indicator = null;
    }
}
