/**
 * ansiUtils — shared helpers for taming raw ANSI-terminal byte streams
 * that arrive from `script`-wrapped PTY sessions.
 *
 * Both the flat scrollback (FlatList of <Text> lines) in LiveTab and the
 * ANSI-stripped preview in AITab need the same clean-up. Historically this
 * lived only inside AITab, so LiveTab's ended-session view showed raw
 * garble like `]0;root@kali: /  [0m[27m[24m[J[34m...` — the ESC bytes got
 * stripped somewhere upstream but the CSI/OSC PAYLOAD survived and was
 * rendered as literal text. Now both go through the same function.
 *
 * cleanAnsi() covers:
 *   • CSI sequences:  ESC [ params final-letter        (colors, cursor)
 *   • OSC sequences:  ESC ] ... BEL | ESC \             (window title, hyperlinks)
 *   • Two-char ESC:   ESC = | > | 7 | 8 | ( | )         (keypad mode, save/restore)
 *   • Bare ESC bytes leftover from partial matches
 *   • Bracketed-paste mode toggles that survived when ESC was stripped
 *     upstream — a common failure mode inside script(1) output. E.g.
 *     `[?2004h`, `[?2004l`, `[?1h=`, `[?1l>` all leak through if we only
 *     match on ESC-prefixed forms.
 *   • Lone \r without \n: terminal would overwrite; we drop the prefix
 *     and keep whatever's after the last \r on the line.
 */
export function cleanAnsi(line: string): string {
  if (!line) return line;
  let out = line
    // Complete CSI:  ESC [ ... final-letter
    .replace(/\x1b\[[\d;?]*[A-Za-z]/g, "")
    // Complete OSC:  ESC ] ... (BEL | ESC \)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    // Two-char ESC: ESC + one of =, >, 7, 8, (, )
    .replace(/\x1b[=>78()][0-9A-Za-z]?/g, "")
    // Any remaining bare ESC
    .replace(/\x1b/g, "")
    // Orphaned CSI-shaped fragments where ESC was already stripped
    // upstream. Matches `[<params><final-letter>` at line-start OR
    // after whitespace, and the private-mode variants `[?…h`, `[?…l`.
    // Only match a bounded set of finals so we don't chew normal
    // bracket-heavy prose like `[/]` in a shell prompt.
    .replace(/(^|\s|\])\[\?[\d;]*[hlHL=><]/g, "$1")
    .replace(/(^|\s|\])\[[\d;]*[mABCDEFGHJKfnsu]/g, "$1")
    // OSC-shaped fragments where ESC was stripped:  `]0;title BEL/ST`
    .replace(/\]\d+;[^\x07\x1b\n]*(\x07|\x1b\\)?/g, "");
  // Lone carriage-returns: everything before the last \r would have been
  // overwritten in a real terminal, so drop it.
  if (out.indexOf("\r") !== -1) {
    const parts = out.split("\r");
    out = parts[parts.length - 1];
  }
  return out;
}
