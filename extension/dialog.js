// SPDX-FileCopyrightText: 2026 miralemalic
// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as CheckBox from 'resource:///org/gnome/shell/ui/checkBox.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

// Long enough that keys meant for another window can't answer by accident
const ARM_DELAY_MS = 750;

export const RequestDialog = GObject.registerClass({
    Signals: {
        'response': {param_types: [GObject.TYPE_BOOLEAN, GObject.TYPE_BOOLEAN]},
    },
}, class RequestDialog extends ModalDialog.ModalDialog {
    _init(app, kind, source) {
        super._init({styleClass: 'access-dialog'});

        if (app.icon) {
            this.contentLayout.add_child(new St.Icon({
                gicon: app.icon,
                icon_size: 48,
                x_align: Clutter.ActorAlign.CENTER,
            }));
        }

        const name = app.name ?? _('an unnamed app');
        const title = kind === 'mic'
            ? _('Allow %s to use the microphone?').format(name)
            : _('Allow %s to record system audio?').format(name);
        const content = new Dialog.MessageDialogContent({title, description: source});
        this.contentLayout.add_child(content);

        if (app.detail && app.detail !== name) {
            content.add_child(new St.Label({
                text: app.detail,
                style_class: 'micsnitch-detail',
                x_align: Clutter.ActorAlign.CENTER,
            }));
        }

        // Nothing to go by, nothing to remember
        if (app.key) {
            this._remember = new CheckBox.CheckBox(app.verified
                ? _('Remember for %s').format(app.program ?? name)
                : _('Remember for anything calling itself %s').format(app.claim ?? name));
            this._remember.add_style_class_name('micsnitch-remember');
            content.add_child(this._remember);
        }

        const buttons = [
            this.addButton({
                label: _('Deny'),
                action: () => this._respond(false),
                key: Clutter.KEY_Escape,
                default: true,
            }),
            this.addButton({
                label: _('Allow'),
                action: () => this._respond(true),
            }),
        ];

        buttons.forEach(b => (b.reactive = false));
        this._armId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ARM_DELAY_MS, () => {
            buttons.forEach(b => (b.reactive = true));
            this._armId = 0;
            return GLib.SOURCE_REMOVE;
        });

        this.connect('destroy', () => {
            if (this._armId)
                GLib.source_remove(this._armId);
        });
    }

    _respond(allowed) {
        if (this._armId)
            return;
        this.emit('response', allowed, this._remember?.checked ?? false);
        this.close();
    }
});
