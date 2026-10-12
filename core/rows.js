// SPDX-FileCopyrightText: 2026 miralemalic
// SPDX-License-Identifier: MIT

// Rows for GNOME's settings window and the KDE app's window.
// GTK, so GNOME Shell itself never imports this.
import Adw from 'gi://Adw';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {canUndo, describeEvent} from './activity.js';

function nameOf(key) {
    const [kind, value] = key.split(/:(.*)/);
    if (kind === 'exe')
        return GLib.path_get_basename(value);
    // Flatpak and launcher IDs have a name, "program / name" claims don't
    const info = value.includes('/') ? null : GioUnix.DesktopAppInfo.new(`${value}.desktop`);
    return info?.get_name() ?? value;
}

export function kindName(kind, _) {
    return kind === 'mic' ? _('Microphone') : _('System audio');
}

export function button(props) {
    return new Gtk.Button({valign: Gtk.Align.CENTER, css_classes: ['flat'], ...props});
}

// Swaps a group's rows for new ones, or a placeholder when there are none
export function replaceRows(group, rows, fresh, placeholder) {
    rows.splice(0).forEach(row => group.remove(row));
    rows.push(...fresh.length ? fresh : [new Adw.ActionRow({title: placeholder})]);
    rows.forEach(row => group.add(row));
}

// Every remembered answer, each with a way to forget it
export function ruleRows(settings, _) {
    const rules = settings.get_value('rules').deepUnpack();
    return Object.entries(rules).map(([rule, answer]) => {
        const [kind, key] = rule.split(/:(.*)/);
        const row = new Adw.ActionRow({
            title: nameOf(key),
            subtitle: [
                kindName(kind, _),
                answer === 'allow' ? _('Always allowed') : _('Always denied'),
            ].join(' · '),
            tooltip_text: key.split(/:(.*)/)[1],
            use_markup: false,
        });
        // The tooltip is also what screen readers call it
        const forget = button({icon_name: 'edit-delete-symbolic', tooltip_text: _('Forget')});
        forget.connect('clicked', () => {
            delete rules[rule];
            settings.set_value('rules', new GLib.Variant('a{ss}', rules));
        });
        row.add_suffix(forget);
        return row;
    });
}

// A decision, with Undo while it can still be taken back
export function eventRow(event, _, undo) {
    const row = new Adw.ActionRow({
        title: event.app || _('Unnamed app'),
        subtitle: [describeEvent(event, _), event.source].filter(Boolean).join(' · '),
        use_markup: false,
    });
    if (canUndo(event)) {
        const undoButton = button({label: _('Undo')});
        undoButton.connect('clicked', () => {
            undoButton.sensitive = false;
            undo(event.id);
        });
        row.add_suffix(undoButton);
    }
    return row;
}
