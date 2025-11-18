const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const CUSTOM_DIR = path.join(ROOT, 'custom-shaders');

function loadTerrainShaders() {
  const terrainSource = fs.readFileSync(path.join(ROOT, 'terrain-shaders.js'), 'utf8');
  const augmented = `${terrainSource}\nif (typeof TerrainShaders !== 'undefined') { this.__terrainShaders = TerrainShaders; }`;
  const context = { console };
  vm.createContext(context);
  vm.runInContext(augmented, context, { filename: 'terrain-shaders.js' });
  if (!context.__terrainShaders) {
    throw new Error('TerrainShaders object was not defined.');
  }
  return context.__terrainShaders;
}

function loadCustomShaderRegistry() {
  const baseContext = {
    console,
    window: { terrainCustomShaderSources: {} },
    SHADER_MAX_NEIGHBOR_OFFSET: 2
  };
  vm.createContext(baseContext);
  const shaderFiles = fs
    .readdirSync(CUSTOM_DIR)
    .filter((file) => file.endsWith('.js') && file !== 'dump-plain-shaders.js')
    .sort();
  for (const file of shaderFiles) {
    const source = fs.readFileSync(path.join(CUSTOM_DIR, file), 'utf8');
    vm.runInContext(source, baseContext, { filename: file });
  }
  return baseContext.window.terrainCustomShaderSources;
}

function toTitleCase(key) {
  return key
    .split(/[_-]/)
    .filter(Boolean)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(' ');
}

const SHADER_DESCRIPTIONS = {
  aspect: 'Color-coded slope aspect using a bright categorical palette.',
  avalanche: 'Highlights avalanche-prone slopes with a thermal ramp.',
  daylight: 'Integrates H4 horizon rasters into day-length hues.',
  hillshade: 'Multi-parameter analytic hillshade with custom tints.',
  normal: 'Visualizes DEM normals as RGB vectors.',
  shadow: 'Ray-marched sun shadows with soft penumbra control.',
  slope: 'Rainbow ramp of slope steepness in degrees.',
  snow: 'Stylized snow-cover estimator with slope/aspect bias.',
  heavy_fog: 'Depth-based atmospheric fog with a sky-tinted horizon.'
};

function buildSections() {
  const terrainShaders = loadTerrainShaders();
  const registry = loadCustomShaderRegistry();
  const sections = [];
  const names = Object.keys(registry).sort();
  for (const name of names) {
    const fragment = registry[name](terrainShaders.commonFunctions).trim();
    sections.push({
      key: name,
      title: toTitleCase(name),
      description: SHADER_DESCRIPTIONS[name] || '',
      code: fragment
    });
  }
  const heavyFogPath = path.join(CUSTOM_DIR, 'heavy_fog.fragment.glsl');
  if (fs.existsSync(heavyFogPath)) {
    const heavyCode = fs.readFileSync(heavyFogPath, 'utf8').trim();
    sections.push({
      key: 'heavy_fog',
      title: 'Heavy Fog',
      description: SHADER_DESCRIPTIONS.heavy_fog || '',
      code: heavyCode
    });
  }
  return sections;
}

function writeMarkdown(sections) {
  const output = [];
  output.push('# Copy-paste GLSL shader library');
  output.push('');
  output.push('Each snippet below is a full fragment shader that already inlines the shared terrain helper');
  output.push('functions (elevation sampling, Sobel gradients, SRGB helpers, etc.). Copy the block you want');
  output.push('into your MapLibre custom layer panel and wire up the uniforms listed at the top of the shader.');
  output.push('For background on what each effect does, see [custom-shaders/README.md](./README.md).');
  output.push('');
  for (const section of sections) {
    output.push(`## ${section.title}`);
    if (section.description) {
      output.push('');
      output.push(section.description);
    }
    output.push('');
    output.push('```glsl');
    output.push(section.code);
    output.push('```');
    output.push('');
  }
  fs.writeFileSync(path.join(CUSTOM_DIR, 'PLAIN_GLSL.md'), output.join('\n'), 'utf8');
}

writeMarkdown(buildSections());
