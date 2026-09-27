# Chetwynd 3D

A walkable, drivable, flyable 3D replica of **Chetwynd, British Columbia**, the Chainsaw Carving
Capital of the World. It runs in any modern desktop browser.

**Play:** https://tuckerstrachan414-maker.github.io/Chetwynd-Map/

The world is built from real measurements, not by hand:
- LiDAR terrain and canopy: 1 m across the townsite (about 10 × 9 km) and 2 m for 18 × 18 km around town
- every building footprint, with roof shapes fitted to the LiDAR
- every tree over 2.5 m detected individually from the LiDAR, with its species inferred
- roads, rail and water from OpenStreetMap
- ground colours from Sentinel-2 satellite imagery
- the real valley and mountains out to about 65 km

## Controls

Click the scene to capture the mouse (Esc releases it). Press **H** to show or hide the help line.

| Key | Anywhere |
| --- | --- |
| **T** / **Shift+T** | Time of day forward / back one hour |
| **Y** | Season: summer → autumn → winter → spring |
| **U** | Weather: scattered cloud → clear → overcast → rain → snow → fog |
| **N** | Go to a landmark (then 1–8) |
| **O** | Settings: graphics quality (Low / Medium / High / Ultra), field of view, mouse sensitivity, benchmark, credits |
| **F** | Free-fly camera (WASD, Q/E down/up, mouse wheel speed, Shift fast) |

| Mode | Key | Controls |
| --- | --- | --- |
| Walk | (default) | WASD / arrows, mouse look, Shift run, Space jump. Wade, swim and walk on winter ice |
| Drive | **V** | W/S throttle/brake and reverse, A/D steer, Space handbrake, C chase/hood/bumper camera, mouse orbits the chase camera, R reset. Gamepad: RT/LT, left stick, A handbrake |
| FPV drone | **G** | See below |
| Photo | **P** | World pauses; WASD fly, right-drag look; panel for focal length, aperture, focus (real depth of field), exposure, roll, time, season, weather, vignette, grain; Save PNG up to 4× resolution. H hides the panel, P returns |
| Editor | **E** (from walking) | See below |

### FPV drone

A 5-inch freestyle quad: 7:1 thrust-to-weight on a 4S 1300 mAh pack whose voltage sags under
load, with Betaflight rate curves (RC rate 1.0, super rate 0.7: 667°/s), air mode, 25° camera
uptilt and a 120° lens with FPV barrel distortion (**B** toggles it). It flies in **acro** (rate)
mode by default; **M** toggles self-levelling **angle** mode. Hard hits break the props (**R** resets). The OSD shows the timer, voltage and
per-cell voltage, current, mAh used, altitude, speed and an artificial horizon.

- **Radio (recommended):** plug in an EdgeTX/OpenTX transmitter (RadioMaster, Jumper, FrSky,
  TBS…) in *USB Joystick* mode, or an ELRS/CRSF USB dongle. Press **K** and follow the wizard:
  it detects each stick and switch, so no channel order matters. The calibration is saved in the
  browser.
- **Gamepad:** Mode 2 by default (left stick throttle/yaw, right stick pitch/roll; throttle is the
  upper half of the left stick). **K** recalibrates.
- **Keyboard:** Shift/Ctrl throttle up/down (it stays set), Space full throttle, W/S pitch, A/D
  roll, Q/E or mouse yaw. Angle mode (M) is easiest on keys.

### World editor

No dataset records every bench or bush. Mapped objects are placed where the data says. The rest is
inferred: shrubs from LiDAR density, tree species from imagery, street furniture from rules (lamps
along arterials, hydrants every 120 m, poles and wires along streets, stop signs by road hierarchy…).

The editor overlay marks each object by source: **green** mapped, **orange** inferred, **blue**
your edits.

- **Left click** places the selected item on the ground, or selects an object.
- **Fences:** pick a board, chain-link or rail fence, click each corner, then **Enter** (Backspace removes the last point, Esc cancels).
- **Drag** a selection to move it; it snaps to the terrain.
- **R** / **Shift+R** rotate, **[ ]** resize trees, **Del** delete, **Ctrl+Z** undo.
- **Right-drag** looks around; WASD moves, Space/Ctrl go up and down.

Edits apply live and persist in your browser. **Export** downloads `overrides.json`. Commit it to
`public/world/overrides.json` and everyone gets your corrections (**Import** loads one back).

### URL options

`?at=x,z&yaw=deg&pitch=deg` start position (engine metres from the town centre; yaw 0 = north) ·
`t=14.5` hour · `date=2025-7-15` date for the sun and moon · `season=summer|autumn|winter|spring` ·
`weather=clear|scattered|overcast|rain|snow|fog` · `mode=drive|drone|photo|edit` · `fov=70` ·
`q=low|medium|high|ultra` graphics quality · `bench` run the benchmark

## Requirements and performance

A desktop or laptop browser with WebGL 2 (Chrome, Edge, Firefox, Safari 16+) and a GPU from
roughly 2016 or later. World data streams in as you move (about 230 MB in total).

Quality is picked from your GPU the first time (change it with **O**):

| Level | Typical GPU | What changes |
| --- | --- | --- |
| Low | Older integrated graphics | 70 % resolution, FXAA, no ambient occlusion or water reflections, sparse grass, shorter tree/building distances |
| Medium | Intel Iris Xe, AMD Radeon 680M/780M | 85 % resolution, 2× MSAA, ambient occlusion, medium grass |
| High | GTX 1060, RTX, RX 5000+, Apple M1 | Full resolution, 4× MSAA, 4K shadows, full grass and draw distances |
| Ultra | RTX 3070 / RX 6800 and up, Apple M-Pro/Max | Up to 2× pixel density, denser grass, longer tree and building distances |

Dynamic resolution lowers the render scale a little when a frame runs long, to hold 60 fps (30 fps
on Low). To measure your machine, open `?bench`: a 70-second flight that reports average and
1 % low frame rates and copies them to the clipboard.

## Run locally

```bash
npm install
npm run dev          # http://localhost:5173
npm run check        # typecheck, lint, unit tests, production build
```

## How it is built

`pipeline/` (Python) turns the open datasets into compact streamed tiles in `public/world/`:

| Stage | What it does |
| --- | --- |
| `lidar_index`, `fetch_lidar`, `lidar_mosaic`, `pointcloud_rasters` | LidarBC 2024/25 DEM, DSM and point clouds → 1 m and 2 m mosaics, per-cell return statistics |
| `ground` | 1 m surface classes (asphalt, gravel, lawn, forest floor, cutbanks, sand bars…) from LiDAR intensity, return structure, NDVI and OSM |
| `buildings` | OSM + Overture footprints aligned to the LiDAR, LiDAR-only structures added, roofs fitted (gable, hip, flat, shed) with limits on pitch and height |
| `trees` | Canopy-height local maxima and watershed crowns → position, height and crown radius per tree; species from crown shape, summer/winter NDVI and setting |
| `water` | Pine and Sukunka rivers, creeks, ditches, ponds and lagoons: surfaces, flow vectors, carved channels, winter ice |
| `roads` | Draped road, sidewalk, curb, parking and marking meshes; bridges with decks, parapets and piers; rails with ties and crossings |
| `props`, `carvings` | Street furniture and utilities; 149 chainsaw carving positions registered from the District's tour map |
| `terrain_pyramid`, `imagery` | Terrain quadtree (1 m → 32 m), Sentinel-2 colour |

```bash
python -m venv .venv && . .venv/bin/activate
pip install numpy scipy scikit-image rasterio shapely pyproj pyarrow laspy[lazrs] pillow pymupdf
python -m pipeline.run_all              # everything (downloads ~60 GB of LiDAR point clouds)
python -m pipeline.run_all roads props  # selected stages
```

Textures: `assets-src/gen_leaf_atlases.py` (procedural leaf and needle sprays),
`assets-src/prep_tree_textures.py` (bark), then `node assets-src/build_tree_textures.mjs` and
`node assets-src/build_terrain_textures.mjs` encode KTX2.

The runtime (`src/`, TypeScript, three.js, Rapier) streams 256 m tiles around the camera. It
renders a physically based sky and aerial perspective, cloud layer and cloud shadows, water with
refraction, reflections and flow, instanced trees with LOD and impostors, GPU grass, street-light
pools at night, weather, and a filmic HDR pipeline.

See [DATA_SOURCES.md](DATA_SOURCES.md) for what is measured and what is inferred, and
[CREDITS.md](CREDITS.md) for licences and attribution.
