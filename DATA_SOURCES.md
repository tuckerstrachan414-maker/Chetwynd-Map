# What is measured, what is inferred

Everything in Chetwynd 3D comes from open data, and every placement is traceable. This page says
how each kind of object gets into the world and how far to trust it.

## Measured (placed exactly where the data says)

| Feature | Source | Accuracy |
| --- | --- | --- |
| Ground shape: roads, ditches, embankments, cutbanks, river terraces | LidarBC bare-earth DEM, 2024/2025 acquisitions | 1 m grid over the townsite, 2 m out to 9 km; vertical ~0.1 m |
| Mountains to the horizon | NRCan MRDEM-30 | 30 m grid, blended beyond the LiDAR |
| Buildings | OpenStreetMap + Overture footprints, aligned to LiDAR roof returns; LiDAR-only structures added where both maps miss them | Footprints ±0.5 m; heights and roof pitch from the LiDAR surface model |
| Trees over 2.5 m | Individual crowns detected in the LiDAR canopy height model | Position ±1 m, height ±0.5 m, crown radius from watershed segmentation |
| Roads, lanes, paths, rail, bridges | OpenStreetMap geometry and tags (surface, lanes, width), draped on the LiDAR | Centrelines ±1–2 m |
| Surface types (asphalt, gravel, lawn, bare soil, sand, forest floor…) | LiDAR intensity and return structure, Sentinel-2 NDVI, OSM land use | 1 m classes |
| Rivers, creeks, ponds | LiDAR (water returns and channel shape), OSM waterways, Sentinel-2 water tint | Banks to ~1 m; water levels from LiDAR |
| Power lines and towers that are mapped | OpenStreetMap | As mapped |
| Chainsaw carvings | District of Chetwynd Chainsaw Carving Tour Map, registered to the road network | 149 of 154 placed, typically within 10–20 m; the remaining five have no position in the map and are omitted |

## Inferred (plausible, correctable in the editor)

The editor's overlay (E) colours these orange, and every one can be moved, deleted or added to.

| Feature | Rule |
| --- | --- |
| Tree species | Crown shape and height, leaf-on vs leaf-off greenness (Sentinel-2), wetness and setting; Peace-region boreal mix (trembling aspen, balsam poplar, paper birch, white and black spruce, lodgepole pine, willow, alder) and town plantings (blue spruce, Mayday, mountain ash) |
| Shrubs | Placed by density in LiDAR returns 0.5–2.5 m above ground; wild rose, red-osier dogwood, caragana/lilac hedges, willow |
| Street lights | Arterials every 38 m staggered on both sides, collectors every 55 m, residential streets every 70 m on one side plus junction corners |
| Power poles and wires | A distribution line on the far side of residential and collector streets, a pole every 45 m, wired in sequence (mapped lines and poles kept) |
| Fire hydrants | Every 120 m along town streets, preferring junction corners |
| Stop and street-name signs | Stop on the minor approach where road classes meet; a name post at each town junction |
| Traffic signals | Corner poles with mast arms at mapped signalised junctions |
| Benches, bins, playgrounds | Park paths, around sports fields, downtown sidewalks every 60 m and at carving sites; a bin beside every other bench; a playground per school and park |
| Roof shape details, facade materials, windows | By building class and size |
| Grass | Density and height from the surface class (mown lawns, meadows, ditches) |

## Not included

Building interiors (exteriors only), vehicles other than yours, people, and small private objects
(sheds under ~10 m², fences, yard ornaments) that no open dataset records.

## Freshness

LiDAR 2024–2025, OpenStreetMap and Overture as of September 2026, Sentinel-2 imagery from
25 August 2025, carving map 2019.
