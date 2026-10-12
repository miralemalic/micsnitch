// Reads and presses the KDE app's widgets the way a screen reader would.
//   gjs -m tests/atspi.mjs text                every window title, label and control
//   gjs -m tests/atspi.mjs press NAME [NEAR]   presses a button or switch called NAME,
//                                              in the row that mentions NEAR
import Atspi from 'gi://Atspi';
import System from 'system';

Atspi.init();

function* walk(node) {
    yield node;
    for (let i = 0; i < node.get_child_count(); i++) {
        const child = node.get_child_at_index(i);
        if (child)
            yield* walk(child);
    }
}

function app() {
    const desktop = Atspi.get_desktop(0);
    for (let i = 0; i < desktop.get_child_count(); i++) {
        const child = desktop.get_child_at_index(i);
        if (child?.get_name() === 'micsnitch')
            return child;
    }
    return null;
}

const CONTROLS = ['button', 'switch', 'check box', 'toggle button'];

function texts(node) {
    return [...walk(node)].map(n => n.get_name()).filter(Boolean);
}

const [command, name, near] = System.programArgs;
const root = app();
if (!root)
    System.exit(2);

if (command === 'text') {
    for (const node of walk(root)) {
        const text = node.get_name();
        if (text)
            print(`${node.get_role_name()}: ${text}`);
    }
} else if (command === 'press') {
    // The nearest ancestor that mentions NEAR is the row the control belongs to
    const target = [...walk(root)].find(node => {
        if (node.get_name() !== name || !CONTROLS.includes(node.get_role_name()) ||
            !node.get_action_iface()?.get_n_actions())
            return false;
        if (!near)
            return true;
        for (let up = node.get_parent(), depth = 0; up && depth < 4; up = up.get_parent(), depth++) {
            if (texts(up).some(text => text.includes(near)))
                return true;
        }
        return false;
    });
    if (!target)
        System.exit(1);
    target.get_action_iface().do_action(0);
} else {
    printerr(`Unknown command: ${command}`);
    System.exit(2);
}
