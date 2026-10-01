import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Unsafe mode opens up Eval and screenshots over D-Bus,
// which is all the popup test needs.
export default class TestHelper extends Extension {
    enable() {
        global.context.unsafe_mode = true;
    }

    disable() {
        global.context.unsafe_mode = false;
    }
}
