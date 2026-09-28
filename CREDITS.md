# Credits and licences

Chetwynd 3D is built from open data. The world files in `public/world/` are derived works of the
datasets below. When you share screenshots or the site, keep this attribution; the same text is
shown in-game (Help → Credits).

## Geographic data

| Data | Source | Licence |
| --- | --- | --- |
| 1 m LiDAR terrain (DTM), surface model (DSM), canopy height and point-cloud classes | [LidarBC](https://lidar.gov.bc.ca/), Province of British Columbia | [Open Government Licence – British Columbia](https://www2.gov.bc.ca/gov/content/data/policy-standards/open-data/open-government-licence-bc) |
| 30 m horizon terrain (MRDEM-30 DTM/DSM) | Natural Resources Canada, [Medium Resolution Digital Elevation Model](https://open.canada.ca/data/en/dataset/18752265-bda3-498c-a4ba-9dfe68cb98da) | [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada) |
| Roads, paths, rail, water, land use, power lines, place names, amenities | © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) |
| Building footprints and heights, transportation, base layers, places | [Overture Maps Foundation](https://overturemaps.org/) release 2026-09-23.1 (includes OpenStreetMap, Esri Community Maps, Microsoft and Google building data) | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) / [CDLA Permissive 2.0](https://cdla.dev/permissive-2-0/) per theme |
| Surface colour and water tint | Contains modified Copernicus Sentinel data 2025 (Sentinel-2 L2A, 25 Aug 2025), via the [Sentinel-2 COGs on AWS](https://registry.opendata.aws/sentinel-2-l2a-cogs/) | [Copernicus data licence](https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice) (free, full and open) |
| Chainsaw carving names, carvers, years, awards and locations | District of Chetwynd, [Chainsaw Carving Tour Map](https://www.gochetwynd.com/wp-content/uploads/2019/02/Chainsaw-Carving-Tour-Map.pdf) | Used for factual positions and captions with attribution; the carvings themselves are represented by procedural stand-ins, not reproductions |

## Textures

| Asset | Source | Licence |
| --- | --- | --- |
| Ground materials: forest floor, conifer litter, dirt, gravel, asphalt, concrete, river cobbles, cutbank, mud, ballast, stubble, sand | [Poly Haven](https://polyhaven.com/) | CC0 |
| Ground materials: lawn, meadow, moss, snow | [ambientCG](https://ambientcg.com/) | CC0 |
| Spruce and pine bark | [Poly Haven](https://polyhaven.com/) (fir_tree_01, pine_tree_01) | CC0 |
| Birch bark | [ez-tree](https://github.com/dgreenheck/ez-tree) by Daniel Greenheck | MIT |
| Leaf and needle sprays (aspen, balsam poplar, paper birch, willow, shrubs, white spruce, lodgepole pine) | Procedural, `assets-src/gen_leaf_atlases.py` (this project) | MIT (this project) |
| Buildings, roads, water, props, pickup truck, carvings, sky, clouds | Procedural shaders and geometry (this project) | MIT (this project) |

## Software

| Library | Licence |
| --- | --- |
| [three.js](https://threejs.org/) | MIT |
| [Rapier](https://rapier.rs/) (`@dimforge/rapier3d-compat`) | Apache-2.0 |
| [Vite](https://vitejs.dev/), [TypeScript](https://www.typescriptlang.org/), [Vitest](https://vitest.dev/) | MIT / Apache-2.0 |
| [earcut](https://github.com/mapbox/earcut), [straight-skeleton](https://www.npmjs.com/package/straight-skeleton) | ISC / MIT |
| [ktx2-encoder](https://github.com/gz65555/ktx2-encoder), [sharp](https://sharp.pixelplumbing.com/) (build-time only) | Apache-2.0 |
| Data pipeline: numpy, scipy, scikit-image, rasterio/GDAL, shapely, pyproj, pyarrow, Pillow | BSD / MIT / Apache-2.0 |

The atmosphere follows Hillaire (2020), *A Scalable and Production Ready Sky and Atmosphere
Rendering Technique*; water flow uses Vlachos (2010), *Water Flow in Portal 2*; the tone mapper is AgX.
