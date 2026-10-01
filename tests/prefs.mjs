// Fills MicSnitch's settings page the way GNOME does, without showing it,
// and prints every row as "title | subtitle". Runs inside tests/gnome.sh.
//   gjs -m tests/prefs.mjs EXTENSION_DIR
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource')._register();
Adw.init();

const dir = System.programArgs[0];
const metadata = JSON.parse(new TextDecoder().decode(
    GLib.file_get_contents(`${dir}/metadata.json`)[1]));
const {default: Preferences} = await import(`file://${dir}/prefs.js`);
const {ExtensionPreferences} = await import(
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js');
const preferences = new Preferences({...metadata, path: dir, dir: Gio.File.new_for_path(dir)});
// Stands in for GNOME's settings service, which translations look up
ExtensionPreferences.lookupByUUID = () => preferences;
const window = new Adw.PreferencesWindow();
preferences.fillPreferencesWindow(window);

function* descendants(widget) {
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        yield child;
        yield* descendants(child);
    }
}

// "title | subtitle", plus any labelled buttons like " [Undo]"
for (const row of descendants(window)) {
    if (!(row instanceof Adw.ActionRow))
        continue;
    const buttons = [...descendants(row)].filter(w => w instanceof Gtk.Button && w.label);
    print(`${row.title} | ${row.subtitle ?? ''}${buttons.map(b => ` [${b.label}]`).join('')}`);
}
