# ref/ — external design references

Not shipped, not loaded by the app. Kept for reading while working on the
Windows 95 HUD skin.

## windows-95-ui-kit/

Themesberg's [windows-95-ui-kit](https://github.com/themesberg/windows-95-ui-kit)
(MIT, `LICENSE` alongside), trimmed to `css/w95.css` + `fonts/`. The clone's
`.git`, jQuery plugin JS, Bootstrap demo pages and screenshot PNGs were
dropped — the kit is a Bootstrap 4 theme overlay and does not run standalone.

What it was used for (2026-09-29 HUD fidelity pass): the palette tokens
(`#c0c0c0` face, `#008080` teal, `#000080`/`#000181` navy) and its component
inventory as a checklist. Its own controls are flat — it has no 3D bevels — so
nothing was copied wholesale; the bevel system in `docs/psx.js` (`W95_CSS`)
predates this kit and is closer to the real thing. Additions it prompted:
keyboard focus rectangles, disabled-control states, hyperlink and selection
colours, and dropping a modern drop shadow from the calibration HUD dialog.

Its `w-95-sans-serif` font is a lighter subset than the shipped W95FA
(`docs/vendor/font/w95/`); W95FA stays because the PT-BR strings need its
accents.
