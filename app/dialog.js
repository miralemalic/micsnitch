// SPDX-FileCopyrightText: 2026 miralemalic
// SPDX-License-Identifier: MIT

// The question, on a layer of its own above every window and panel,
// so it looks and acts like a system dialog
import Gettext from 'gettext';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import LayerShell from 'gi://Gtk4LayerShell';

const {gettext: _} = Gettext.domain('micsnitch');

// Long enough that keys meant for another window can't answer by accident
const ARM_DELAY_MS = 750;

function label(text, css_classes = []) {
    return new Gtk.Label({
        label: text, wrap: true, max_width_chars: 40,
        justify: Gtk.Justification.CENTER, css_classes,
    });
}

export const RequestDialog = GObject.registerClass({
    Signals: {
        'response': {param_types: [GObject.TYPE_BOOLEAN, GObject.TYPE_BOOLEAN]},
        'closed': {},
    },
}, class RequestDialog extends Gtk.Window {
    _init(application, app, kind, source) {
        super._init({application, title: _('MicSnitch'), css_classes: ['micsnitch-backdrop']});

        // The whole screen is ours, keyboard too, until you answer
        LayerShell.init_for_window(this);
        LayerShell.set_namespace(this, 'micsnitch');
        LayerShell.set_layer(this, LayerShell.Layer.OVERLAY);
        LayerShell.set_keyboard_mode(this, LayerShell.KeyboardMode.EXCLUSIVE);
        LayerShell.set_exclusive_zone(this, -1);
        for (const edge of ['TOP', 'BOTTOM', 'LEFT', 'RIGHT'])
            LayerShell.set_anchor(this, LayerShell.Edge[edge], true);

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 12,
            halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
            css_classes: ['micsnitch-dialog'],
        });
        this.set_child(box);
        if (app.icon)
            box.append(new Gtk.Image({gicon: app.icon, pixel_size: 48}));

        const name = app.name ?? _('an unnamed app');
        const title = kind === 'mic'
            ? _('Allow %s to use the microphone?')
            : _('Allow %s to record system audio?');
        box.append(label(title.replace('%s', name), ['title-2']));
        if (source)
            box.append(label(source));
        if (app.detail && app.detail !== name)
            box.append(label(app.detail, ['caption', 'dim-label']));

        // Nothing to go by, nothing to remember
        if (app.key) {
            const remember = app.verified
                ? _('Remember for %s').replace('%s', app.program ?? name)
                : _('Remember for anything calling itself %s').replace('%s', app.claim ?? name);
            this._remember = new Gtk.CheckButton({label: remember, halign: Gtk.Align.CENTER});
            box.append(this._remember);
        }

        const deny = new Gtk.Button({label: _('Deny')});
        const allow = new Gtk.Button({label: _('Allow')});
        deny.connect('clicked', () => this._respond(false));
        allow.connect('clicked', () => this._respond(true));
        const buttons = new Gtk.Box({spacing: 12, homogeneous: true, css_classes: ['micsnitch-buttons']});
        buttons.append(deny);
        buttons.append(allow);
        box.append(buttons);
        this.set_default_widget(deny);

        // Escape says no, like Deny
        const keys = new Gtk.ShortcutController();
        keys.add_shortcut(new Gtk.Shortcut({
            trigger: Gtk.ShortcutTrigger.parse_string('Escape'),
            action: Gtk.CallbackAction.new(() => {
                this._respond(false);
                return true;
            }),
        }));
        this.add_controller(keys);

        [deny, allow].forEach(b => (b.sensitive = false));
        this._armId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ARM_DELAY_MS, () => {
            [deny, allow].forEach(b => (b.sensitive = true));
            deny.grab_focus();
            this._armId = 0;
            return GLib.SOURCE_REMOVE;
        });

        // If something else closes it, the handler still has to know
        this.connect('close-request', () => {
            this.close();
            return true;
        });
    }

    open() {
        this.present();
        return true;
    }

    _respond(allowed) {
        if (this._armId)
            return;
        this.emit('response', allowed, this._remember?.active ?? false);
        this.close();
    }

    close() {
        if (this._done)
            return;
        this.dismiss();
        this.emit('closed');
    }

    // For when the handler shuts down, so no "closed"
    dismiss() {
        if (this._armId)
            GLib.source_remove(this._armId);
        this._armId = 0;
        this._done = true;
        this.destroy();
    }
});
