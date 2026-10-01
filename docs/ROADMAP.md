# Roadmap: ideas and future work

Things we would like to build. Nothing here is promised or scheduled. If you want to work on one, open an issue first (or comment on an existing one) so we can agree on the shape. New ideas are welcome as [feature requests](https://github.com/AryanMotiani/regimen/issues/new/choose).

## Ideas

- **More study room backgrounds** (details below): rooms that are not a student at a desk, like a beach, an open book, a laptop on a desk, a cafe or a library.
- **Browser store listings.** Publish on Firefox Add-ons and Edge Add-ons (free), then the Chrome Web Store (one-time 5 USD). One-click installs, automatic updates, and the lock agent can force-install the extension. Everything is prepared in [store/](store/) and [RELEASING.md](RELEASING.md#browser-stores).
- **A custom domain.** Gives the app its own browser origin (closes the shared `github.io` origin limit in [SECURITY.md](../SECURITY.md)) and an easy name to share. Steps in [DEPLOYMENT.md](DEPLOYMENT.md#custom-domain).
- **Safari.** A Safari Web Extension built from the same code with Xcode's converter. Needs a Mac, an Apple Developer account and checks for the `declarativeNetRequest` features Safari supports. Today Safari is covered only by the lock agent.
- **Phones.** The website works on a phone for tasks, habits and the room, but nothing is blocked there. Options: an Android app using a local VPN or accessibility service, iOS Screen Time (Family Controls) in a native app, or a lighter "phone mode" that syncs with the desktop through an exported file or a QR code (still no server).
- **Code-signed installers.** Authenticode for `Regimen-Setup.exe` and a notarized `Regimen.pkg`, so Windows and macOS stop warning on first run.
- **Package managers.** Submit the prepared winget, Homebrew and AUR templates in [packaging/](../packaging/README.md).
- **Optional sync between your own devices** without a Regimen server, for example through a file in a folder you already sync, or end-to-end encrypted with a key only you hold.
- **Translations.** The UI text is short and plain on purpose. A small i18n layer would let people translate it.
- **More bundles and sounds.** More site bundles (anyone can suggest one with the "Add or fix a site in the block list" issue template), more music styles and ambience.
- **Accessibility pass.** A full keyboard and screen reader review of the study room windows and the decorate mode.

## More study room backgrounds

**The idea.** Today the study room is always one scene: a student at a desk, by a window, and the "scene" changes what you see through that window (night city, sunset, forest, snow, ...). Not everyone wants to see a student character, and some people focus better with a different picture. Let people pick the whole background, the way they pick a scene now:

- a **beach**: sand, sea and a towel with a notebook, waves as optional ambience
- an **open book on a table**, seen from above, with a cup of tea and a lamp
- a **laptop on a desk**, close up, no character, the screen glowing
- a **cafe**: a window table, rain outside, quiet chatter as ambience
- a **library**: tall shelves, a long table, a green banker's lamp
- later: a train window, a cabin at night, a rooftop at dusk, a space station desk

**How it could fit the current design.**

- A new unlock kind, for example `kind: 'backdrop'`, in `packages/core/src/unlocks.js`, next to `scene`, `object` and `music`. The current room becomes the free default backdrop (`backdrop-room`), so nothing changes for existing users.
- A setting next to the scene, for example `settings.lofi.backdrop` (or `settings.room.backdrop`), validated in `sanitizeLofi()` or `sanitizeRoom()` with a migration that defaults to `backdrop-room`.
- **Picked like scenes**: the "Scene and music" window gets a Backdrop row with previews. Owned backdrops are one click, others show the price.
- **Sold in the shop** like scenes, with a price and maybe a level gate (for example a free beach and library, a cafe for coins), so they give the coin economy more to aim for. The shop already supports new categories (`SHOP_CATEGORIES` in `economy.js`).
- **Drawing**: each backdrop is an SVG or layered illustration in the same 1600 by 900 room box, like `StudyRoom.vue` and `SceneSky.vue` today. Backdrops without a character simply hide the avatar.
- **Decor**: decide per backdrop which surfaces exist. The desk and shelf items make sense in the library and the cafe, wall posters do not fit the beach. The simplest first version: decor and the avatar show only on the room backdrop, and other backdrops are fixed pictures.
- **Scenes and backdrops together**: backdrops with a window (cafe, library, train) can keep showing the chosen scene outside, others (beach, open book) ignore it.
- **Themes**: backdrops should look right in light and dark and in Game and Calm, like the room does now (`roomStyle.js`).
- **Sound**: some backdrops could suggest a matching ambience (waves for the beach, chatter for the cafe) without forcing it.

**Open questions.** Who draws the art, and in which style so it matches the current room? Should the avatar be a separate switch ("show me in the room") instead of being tied to the backdrop?

## Done recently

See [CHANGELOG.md](../CHANGELOG.md).
