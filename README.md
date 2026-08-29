# Swordcraft

A peer-to-peer real-time strategy game for 2–4 players, written in vanilla
JavaScript. No build step, no framework, no bundler — a static folder, a canvas,
and a WebRTC data channel between browsers.

Four castles start in the four corners of a procedurally generated island cut up
by rivers and lakes. Your peasants gather wood and gold on their own; you spend it
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
| Right click | move, attack, or send a peasant to a resource |
| `A` then click | attack-move |
| `S` / `G` | stop / hold ground |
| `Tab` | select your whole army |
| Console buttons | select every Peasant, Army, Melee, Ranged, Caster or All unit you own |
| `H` `O` `B` `R` `T` `M` | place house, outpost, barracks, archery range, watchtower, monastery |
| `Y` then click | set a building's rally point |
| `P` | halt or resume training at the selected building |
| `Delete` | cancel a building under construction |
| Demolish button | pull down one of your own buildings, half the cost back |
| `F` / `Space` | centre on selection / on your base |
| Arrows, screen edge, middle-drag | pan · mouse wheel zooms |
| `Esc` | cancel the current tool, or open the menu |

Music and effect levels live behind the gear button in the corner, on every
screen, and are remembered between sessions. So does the battle theme: five
tracks, or **Shuffle** to draw a different one each match.

## How a match works

**The opening.** Everyone starts with five peasants and a small stake — 60 wood
and 50 gold, enough for a single house or one peasant and nothing more.
The first minutes are about getting income running, not spending a treasury you
were handed.

**Peasants.** Your castle trains peasants on a timer. Left alone they choose their
own job — whichever resource you are shortest of, at the nearest seam with a
free slot — and rethink it after every delivery, so income stays balanced
without micromanagement. Right-click a tree or a gold seam to direct one
yourself; it will stay there until the seam runs dry.

**Two resources, both worth having.** Wood is the bulk material — almost
everything is mostly a wood bill — and gold is the smaller, sharper cost on top.
It used to be the other way round in practice: gold was the only resource
anybody thought about and wood piled up unspent. Costs moved onto wood, gold
seams became more common, and a stand of trees now holds 620 rather than 420.
In a twenty-minute AI match both now hover near zero, which is what balance
looks like.

**Buildings.** Placing one costs resources immediately and the nearest peasants
walk over, hammer in hand, and raise it. Once finished, a production building
trains its unit on a timer and pays that unit's cost each time. That is a real
drain, so `P` halts a building when you would rather bank for something else.
Every building shows a countdown to its next unit above its roof, and selecting
one of your own offers a **Demolish** control, which hands back half the cost.

**Rounding up.** The console carries six buttons - **Peasants**, **Army**,
**Melee**, **Ranged**, **Casters**, **All** - each of which selects every unit
of that kind you own, so an attack does not start with hunting for stragglers.
Each shows its live count, which makes the row double as a readout of what your
army is actually made of. They deliberately leave the camera where it is: you
often want to grab a group while watching somewhere else.

Whatever the cursor is over is framed with corner brackets — buildings, units,
and resource seams alike, so it is obvious which things a peasant can be put on.
The camera will not pull back far enough to show more than half the island at
once.

**Expanding.** An **Outpost** is a second base: it trains peasants, accepts their
deliveries so a distant seam stops being a long walk, and raises how many peasants
you may hold (14 per base). Taking ground is how an economy grows.

**Population** starts at 20 and rises by 10 per house, to a ceiling of 150 -
thirteen houses to reach it. A Peasant costs 1 and every soldier costs 2, so a
full cap is seventy-five soldiers, or rather more once workers are counted. The
readout turns red when you are full and another house would help, and stamps
**MAX** when you are full at the ceiling and nothing will. The
**Monastery** additionally needs a settlement of 30 before it can be sited — a
late building for a developed base. Its button carries that requirement next to
its cost and stays locked until you meet it.

**Terrain.** Rivers and lakes cut the island into regions joined by a handful of
land bridges. Water is impassable, so those crossings are where the fighting
happens. You cannot drop a building on ground an enemy is standing on, so
foundations are not a way to shove an army apart.

**The island fits the table.** Its size and shape follow the number of seats:
two players get a 60x60 duelling bar along one diagonal, three a 74x74
triangle, four an 85x85 island with a corner each. Fewer players get a smaller
map rather than the same one with empty quarters - a duel on a four-player map
is mostly walking.

## The four units

| Unit | Role |
|---|---|
| **Warrior** | Melee specialist. Its swing cleaves every enemy in the arc, so a block of them is worth more than the sum of its parts. |
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
  buildtest.js      regression test: every sited building gets finished
  simtest.js        headless four-way AI soak test
  popstress.js      worst case: four full-population armies in one battle
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

### Four test harnesses

```bash
node tools/mapcheck.js 8      # generate 8 maps; check connectivity and fairness
node tools/buildtest.js 8     # site every building on 8 maps; assert each is finished
node tools/simtest.js 10      # run a 10-minute four-way AI match with no browser
node tools/popstress.js 90    # four maxed armies in one fight; measure the worst case
```

`simtest` reports per-tick cost, snapshot size, and what each player's economy
and army were doing every 30 seconds. Most of the balance and pathfinding work
in this project was done against it rather than in the browser.

`popstress` answers the question the population cap raises: four players at 150
pop is 348 units. Measured, that fight costs 0.13 ms a tick on average and 5.7 ms
at its worst against a 50 ms budget, and pushes the largest snapshot to 5.5 KiB
- about 55 KiB/s per peer. The ceiling is a design choice, not a limit the
engine imposed; 200 measured fine too, at 448 units and 6.9 KiB.

`buildtest` exists because of a specific bug: a worker's "have I arrived?" test
measured a circle from the building's centre, which a worker standing on a
diagonal corner tile could never satisfy - so it walked up to the site and
turned around again. The test now checks that predicate against every tile
touching every footprint, and then plays real matches to confirm crews finish
what they start.

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
