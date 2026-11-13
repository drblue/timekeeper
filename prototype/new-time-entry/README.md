# New time entry wireframe

Open [index.html](index.html) in a browser. Use the preview controls on a wide screen to switch between desktop and phone layouts. On a narrow screen, the form uses the phone layout automatically. Preview entry displays the calculated result locally.

Try both entry types. Duration only takes a work date and an editable duration. Timed entries use Stockholm start and end dates and times. Editing Duration recalculates End. Editing End recalculates Duration. When Start changes, the form preserves whichever of End or Duration was last edited. Try overnight and Try clock change load examples of a next-day end and a repeated local time.

This is the original design draft for [issue #7](https://github.com/drblue/timekeeper/issues/7). The app editor is the current version, including compact numeric input, Stockholm time resolution, and persistence.

## Review record

- Sol implemented the draft. Terra verified the final file in Chromium, including both edit directions, mode switching, preview behavior, date rollover, occurrence selection, error recovery, keyboard focus, and narrow layouts. Astra independently reviewed the same file and found no remaining blockers.
- Reviewed HTML SHA-256: `9772cbfff57a67ed228a9aad94f309f297c016504bd596c0e2b7284f52994c25`.
- Taste copy lint reported zero failures and zero warnings. The taste browser gate reported `GATE: ERROR` because its loopback server could not bind. Separate Chromium checks covered interaction and layout, including widths from 320 to 1440 pixels. Phone testing used viewport emulation.
