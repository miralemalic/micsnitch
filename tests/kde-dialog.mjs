// The KDE popup on its own, for what a screen reader can't do: GTK gives
// checkboxes no action to press. Runs inside tests/kde.sh, next to KWin.
//   gjs -m tests/kde-dialog.mjs APP_DIR
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

Gtk.init();
const {RequestDialog} = await import(`file://${System.programArgs[0]}/dialog.js`);

function check(name, got, expected) {
    print(`${JSON.stringify(got) === JSON.stringify(expected) ? '  ok   ' : '  FAIL '} ${name}`);
    if (JSON.stringify(got) !== JSON.stringify(expected))
        System.exit(1);
}

const app = {name: 'Discord', key: 'app:electron / Discord', claim: 'Discord', detail: 'electron'};
const dialog = new RequestDialog(null, app, 'mic', 'Test mic');
const responses = [];
let closed = false;
dialog.connect('response', (_d, allowed, remember) => responses.push([allowed, remember]));
dialog.connect('closed', () => (closed = true));
dialog.open();

// Answering right away, say with Enter while typing elsewhere, does nothing
dialog._respond(true);
check('an answer within the first moment is ignored', responses, []);

const loop = new GLib.MainLoop(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
    dialog._remember.active = true;
    dialog._respond(true);
    check('a ticked Remember box comes with the answer', responses, [[true, true]]);
    check('answering closes the popup', closed, true);
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
