#!/usr/bin/env python3
"""Demo TUI used by the integration tests and by examples/menu-smoke.yaml.

It draws down to row 11 and the help line is 55 columns wide, so it needs a terminal of at least
58x12. On anything smaller curses aborts, the pane dies, and every assertion downstream looks like
a bug in the harness rather than a too-small screen. The tests run it at 64x14.
"""

import curses

ITEMS = ["Dashboard", "Settings", "Profile", "Reports", "Quit"]


def main(screen: "curses.window") -> None:
    curses.curs_set(0)
    curses.mousemask(curses.ALL_MOUSE_EVENTS | curses.REPORT_MOUSE_POSITION)
    curses.mouseinterval(0)
    screen.keypad(True)

    if curses.has_colors():
        curses.start_color()
        curses.use_default_colors()
        curses.init_pair(1, curses.COLOR_CYAN, -1)
        curses.init_pair(2, curses.COLOR_BLACK, curses.COLOR_CYAN)
        curses.init_pair(3, curses.COLOR_YELLOW, -1)

    selected = 0
    activated = "-"
    last_event = "-"

    while True:
        screen.erase()
        screen.addstr(0, 2, "TUI DRIVER DEMO", curses.color_pair(1) | curses.A_BOLD)
        screen.addstr(1, 2, "arrows or click to select, enter to activate, q to quit")

        for index, item in enumerate(ITEMS):
            row = 3 + index
            marker = ">" if index == selected else " "
            style = curses.color_pair(2) if index == selected else curses.A_NORMAL
            screen.addstr(row, 4, f"{marker} {item:<12}", style)

        screen.addstr(9, 2, f"SELECTED: {ITEMS[selected]}", curses.color_pair(3))
        screen.addstr(10, 2, f"ACTIVATED: {activated}")
        screen.addstr(11, 2, f"EVENT: {last_event}")
        screen.refresh()

        key = screen.getch()
        if key == curses.KEY_MOUSE:
            try:
                _, mouse_x, mouse_y, _, state = curses.getmouse()
            except curses.error:
                continue
            last_event = f"mouse {mouse_x},{mouse_y} state=0x{state:x}"
            if 3 <= mouse_y < 3 + len(ITEMS):
                selected = mouse_y - 3
                if state & curses.BUTTON1_CLICKED or state & curses.BUTTON1_PRESSED:
                    activated = ITEMS[selected]
        elif key in (curses.KEY_DOWN, ord("j")):
            selected = (selected + 1) % len(ITEMS)
            last_event = "key down"
        elif key in (curses.KEY_UP, ord("k")):
            selected = (selected - 1) % len(ITEMS)
            last_event = "key up"
        elif key in (curses.KEY_ENTER, 10, 13):
            activated = ITEMS[selected]
            last_event = "key enter"
            if ITEMS[selected] == "Quit":
                return
        elif key == ord("q"):
            return
        else:
            last_event = f"key {key}"


curses.wrapper(main)
