# Swordcraft

A peer-to-peer real-time strategy game for 2–4 players, written in vanilla
JavaScript. No build step, no framework, no bundler — a static folder, a canvas,
and a WebRTC data channel between browsers.

Four castles start in the four corners of a procedurally generated island cut up
by rivers and lakes. Your drones gather wood and gold on their own; you spend it
on buildings that train Warriors, Lancers, Archers and Monks. The last castle
standing wins.

## Running it

```bash
npm start
```

Then open <http://localhost:8080>. Any static file server will do — the game is
plain ES modules, images and two MP3s — but `serve.js` is included so there is
nothing to install.

To play with other people, one player picks **Host a game** and reads out the
four-character room code; everyone else picks **Join a game** and types it in.
Signalling goes through the public PeerJS broker, so no server of your own is
needed, but the machines do need internet access to find each other. Once
connected, game traffic is a direct browser-to-browser data channel.

**Skirmish vs AI** needs no network at all.

## Controls

| | |
|---|---|
| Left drag | box select |
| Left click | select one · double-click selects all of that type on screen |
| Shift + click | add to / remove from selection |
| Right click | move, attack, or send a drone to a resource |
| `A` then click | attack-move |
| `S` / `G` | stop / hold ground |
| `Tab` | select your whole army |
| `H` `O` `B` `R` `T` `M` | place house, outpost, barracks, archery range, watchtower, monastery |
| `Y` then click | set a building's rally point |
| `P` | halt or resume training at the selected building |
| `Delete` | cancel a building under construction |
| `Ctrl`+`1`–`9` / `1`–`9` | make / recall a control group |
| `F` / `Space` | centre on selection / on your base |
| Arrows, screen edge, middle-drag | pan · mouse wheel zooms |
| `Esc` | cancel the current tool, or open the menu |

Music and effect levels live behind the gear button in the corner, on every
screen, and are remembered between sessions.

## How a match works

**Drones.** Your castle trains Pawns on a timer. Left alone they choose their
own job — whichever resource you are shortest of, at the nearest seam with a
free slot — and rethink it after every delivery, so income stays balanced
without micromanagement. Right-click a tree or a gold seam to direct one
yourself; it will stay there until the seam runs dry.

**Buildings.** Placing one costs resources immediately and the nearest drones
walk over, hammer in hand, and raise it. Once finished, a production building
trains its unit on a timer and pays that unit's cost each time. That is a real
drain, so `P` halts a building when you would rather bank for something else.
Every building shows a countdown to its next unit above its roof.

**Expanding.** An **Outpost** is a second base: it trains drones, accepts their
deliveries so a distant seam stops being a long walk, and raises how many drones
you may hold (14 per base). Taking ground is how an economy grows.

**Population** starts at 20 and rises by 10 per house, to a ceiling of 80. The
**Monastery** additionally needs a settlement of 30 before it can be sited — a
late building for a developed base.

**Terrain.** Rivers and lakes cut the island into regions joined by a handful of
land bridges. Water is impassable, so those crossings are where the fighting
happens.

## The four units

| Unit | Role |
|---|---|
| **Warrior** | Melee specialist with unstoppable offensive power. |
| **Lancer** | Defensive expert; braces when holding ground, blunting all damage. |
| **Archer** | Long-range, kills from a distance with real arrow projectiles. |
| **Monk** | Heals the most wounded ally in range. |

## How it is put together

```
index.html          shell + PeerJS from CDN
styles.css          pixel-art UI theme, panels 9-sliced by CSS
serve.js            zero-dependency static server
audio/              the two music tracks
src/
  main.js           app shell: loading, menus, lobby, launching a match
  game/
    assets.js       manifest + loader; frame counts measured from the PNGs
    consts.js       every tuning number in the game
    mapgen.js       seeded island, lakes, rivers, land bridges, fair bases
    pathfind.js     A* with a budgeted request queue
    sim.js          the authoritative simulation
    ai.js           computer opponent, playing through the same commands
    render.js       terrain baking, depth-sorted sprites, minimap
    particles.js    sheet effects, sparks, floating text
    audio.js        synthesised effects, plus the music buses
    input.js        selection, orders, camera
    game.js         the match: host loop or guest playback
  net/
    protocol.js     binary snapshot format + object messages
    peer.js         PeerJS transport
  ui/
    menu.js         title, skirmish setup, lobby, help
    hud.js          in-game interface
    settings.js     the sound panel, mounted on every screen
    skin.js         repacks the 9-slice UI art into CSS custom properties
tools/
  mapcheck.js       offline map generator sanity check
  simtest.js        headless four-way AI soak test
```

### Networking

The host runs the only simulation. Guests send commands and receive snapshots;
they never advance the world themselves, which sidesteps the problem that
floating-point maths is not identical across browsers.

Commands and effect events ride as objects. Snapshots do not — at ten a second
with four armies on the field that would be hundreds of kilobytes per second, so
they use a hand-packed binary layout: 14 bytes per unit, 11 per building, and
only the resource nodes whose amount actually changed. A full 240-unit snapshot
lands around 4 KiB, or roughly 40 KiB/s per peer.

The host also ships each unit's current animation frame, which costs one byte
and guarantees every screen shows the same frame of the same swing.

Commands are attributed by the connection they arrived on, never by anything the
sender claims, and every field is re-validated against authoritative state — a
guest cannot move another player's army or conjure resources.

Map data is never sent. The host broadcasts a 32-bit seed and every peer
generates a byte-identical island locally.

Disconnects are noticed through the peer connection's ICE state rather than a
heartbeat, because browsers throttle timers in background tabs to about once a
minute and a player who merely alt-tabs has not left.

### Two test harnesses

```bash
node tools/mapcheck.js 8      # generate 8 maps; check connectivity and fairness
node tools/simtest.js 10      # run a 10-minute four-way AI match with no browser
```

`simtest` reports per-tick cost, snapshot size, and what each player's economy
and army were doing every 30 seconds. Most of the balance and pathfinding work
in this project was done against it rather than in the browser.

## Deployment

Pushing to `main` publishes the site to GitHub Pages through
`.github/workflows/pages.yml`. There is no build step; the workflow uploads the
repository as-is, which works because every path in the project is relative and
therefore fine under a `/Swordcraft/` sub-path.

## Assets

Art is the [Tiny Swords](https://pixelfrog-assets.itch.io/tiny-swords) pack by
Pixel Frog. Every sound *effect* is generated at runtime with WebAudio — there
are no effect samples in the project. The two music tracks in `audio/` were
supplied for this build.
