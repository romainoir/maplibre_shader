# Custom terrain shader ideas

MapLibre lets you swap fragment shaders at runtime, so you can experiment with a variety of
terrain analysis and cinematic looks. Here are some ready-to-run options that ship with this
repo—each entry names the shader function you can request from
`window.terrainCustomShaderSources` along with the main visual effect it produces.

| Shader | What it visualizes | Why you might try it |
| --- | --- | --- |
| `aspect` (`custom-shaders/aspect.js`) | Maps slope aspect (cardinal direction a slope faces) to a bright categorical palette. | Quickly spot north-/south-facing ridges for snowpack, vegetation, or solar planning studies. |
| `avalanche` (`custom-shaders/avalanche.js`) | Highlights slopes in the 30°–45° range with progressively hotter colors. | Fast hazard screening for avalanche-prone inclines using just DEM gradients. |
| `daylight` (`custom-shaders/daylight.js`) | Integrates per-azimuth horizon data to estimate hours of direct sunlight, tinting pixels from cool blues (short days) to warm oranges (long days). | Preview solar exposure across seasons when you have precomputed H4 horizon rasters. |
| `heavy_fog` (`custom-shaders/heavy_fog.fragment.glsl`) | Linearizes depth and blends terrain toward configurable fog/horizon colors in linear space. | Push atmospheric perspective for cinematic fly-throughs or de-emphasize faraway terrain. |
| `hillshade` (`custom-shaders/hillshade.js`) | Classic multi-parameter hillshade with custom highlights, shadows, and accent tinting. | Baseline topographic relief rendering with full control over exaggeration and light vector. |
| `normal` (`custom-shaders/normal.js`) | Outputs the DEM-derived normal vector encoded as RGB. | Debug slope directions, feed into deferred lighting setups, or visualize normals directly. |
| `shadow` (`custom-shaders/shadow.js`) | Ray-marches along the DEM to cast soft shadows based on sun direction/altitude, combining self-shadowing and ambient tint. | Preview dramatic sunrise/sunset shadows or validate self-consistency of your DEM at different sun angles. |
| `slope` (`custom-shaders/slope.js`) | Converts slope steepness (0°–90°) into a rainbow ramp with smoothed transitions. | Rapid slope classification for geomorphology, trail planning, or erosion modeling. |
| `snow` (`custom-shaders/snow.js`) | Simulates snow cover using altitude, slope, aspect bias, bilateral blur, and stylized snow lighting. | Add believable alpine snowpack overlays that respect shady aspects and elevation bands. |

## How to use them

1. Load your terrain map as usual and ensure `terrain-shaders.js` runs so the `window.terrainCustomShaderSources`
   registry exists.
2. Pick one of the shader keys above (for example `"snow"`).
3. Feed the returned GLSL string into your `CustomLayerInterface` or shader swapping hook.
4. Provide any required uniforms listed in the shader file (sun direction, snow altitude, fog colors, etc.).

Feel free to duplicate any of these files as a starting point for new looks—each shader already
imports the shared helper code defined in `commonShaderHeader` (gradient sampling, elevation
lookups, etc.), so you can focus on the unique visual you want to build.
