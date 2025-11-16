/* terrain-analysis.js */
(function() {
  const initialTerrainDebugEnabled = (() => {
    try {
      const searchParams = new URLSearchParams(window.location.search || '');
      if (searchParams.has('terrainDebug')) {
        return true;
      }
      if (typeof window.location.hash === 'string' && window.location.hash.includes('terrainDebug')) {
        return true;
      }
    } catch (error) {
      console.warn('Failed to evaluate terrain debug flag', error);
    }
    return false;
  })();
  let terrainDebugEnabled = initialTerrainDebugEnabled;
  const HillshadeDebug = window.__MapLibreHillshadeDebug || null;
  const hillshadeDebugEnabled = (() => {
    try {
      const searchParams = new URLSearchParams(window.location.search || '');
      if (searchParams.has('hillshadeDebug')) {
        return true;
      }
      return typeof window.location.hash === 'string' && window.location.hash.includes('hillshadeDebug');
    } catch (error) {
      if (terrainDebugEnabled) console.warn('Failed to evaluate hillshade debug flag', error);
      return false;
    }
  })();

  if (HillshadeDebug && typeof HillshadeDebug.install === 'function') {
    HillshadeDebug.install();
    if (hillshadeDebugEnabled) {
      HillshadeDebug.enable();
      console.info('Hillshade debug instrumentation enabled.');
    }
    window.mapLibreHillshadeDebug = Object.freeze({
      enable(options) {
        HillshadeDebug.enable(options);
        if (map) {
          HillshadeDebug.attachToMap(map, { layerId: HILLSHADE_NATIVE_LAYER_ID, sourceId: TERRAIN_SOURCE_ID });
        }
      },
      disable() {
        HillshadeDebug.disable();
      },
      getDrawCalls: () => HillshadeDebug.getDrawCalls(),
      getDemEvents: () => HillshadeDebug.getDemEvents(),
      getDemSnapshots: () => HillshadeDebug.getDemSnapshots(),
      getTiles: (options) => HillshadeDebug.getTiles(options)
    });
  }
  const EXTENT = 8192;
  const TILE_SIZE = 512;
  const DEM_MAX_ZOOM = 18; // native DEM max zoom
  const TERRAIN_FLATTEN_EXAGGERATION = 1e-6;
  const TERRAIN_DEFAULT_EXAGGERATION = 1.0;
  const TERRAIN_SOURCE_ID = 'terrain';
  const HILLSHADE_NATIVE_LAYER_ID = 'terrain-hillshade-native';
  const SKY_LAYER_ID = 'terrain-sky';
  const SKY_BASE_PROPERTIES = {
    'sky-color': '#199EF3',
    'sky-horizon-blend': 0.5,
    'horizon-color': '#ffffff',
    'horizon-fog-blend': 0.5,
    'fog-color': '#0000ff',
    'fog-ground-blend': 0.5,
    'atmosphere-blend': [
      'interpolate',
      ['linear'],
      ['zoom'],
      0,
      1,
      10,
      1,
      12,
      0
    ]
  };
  const DEFAULT_HILLSHADE_SETTINGS = {
    highlightColor: [1.0, 1.0, 1.0],
    shadowColor: [0.0, 0.0, 0.0],
    accentColor: [0.0, 0.0, 0.0],
    exaggeration: 0.5,
    illuminationDirection: 335,
    illuminationAnchor: 'viewport',
    lightAltitude: 45,
    opacity: 1.0
  };
  let hillshadePaintSettings = {
    highlightColor: DEFAULT_HILLSHADE_SETTINGS.highlightColor.slice(),
    shadowColor: DEFAULT_HILLSHADE_SETTINGS.shadowColor.slice(),
    accentColor: DEFAULT_HILLSHADE_SETTINGS.accentColor.slice(),
    exaggeration: DEFAULT_HILLSHADE_SETTINGS.exaggeration,
    illuminationDirection: DEFAULT_HILLSHADE_SETTINGS.illuminationDirection,
    illuminationAnchor: DEFAULT_HILLSHADE_SETTINGS.illuminationAnchor,
    lightAltitude: DEFAULT_HILLSHADE_SETTINGS.lightAltitude,
    opacity: DEFAULT_HILLSHADE_SETTINGS.opacity
  };
  let lastTerrainSpecification = { source: TERRAIN_SOURCE_ID, exaggeration: TERRAIN_DEFAULT_EXAGGERATION };
  let currentTerrainExaggeration = TERRAIN_DEFAULT_EXAGGERATION;
  let terrainAnimationFrameId = null;
  let is3DViewEnabled = true;
  let isTerrainFlattened = false;

  function getHillshadeDebugTiles(mapInstance, options = {}) {
    const debugApi = window.mapLibreHillshadeDebug;
    if (!mapInstance || !debugApi || typeof debugApi.getTiles !== 'function') {
      return [];
    }
    try {
      const tiles = debugApi.getTiles({ map: mapInstance, sourceId: TERRAIN_SOURCE_ID, ...options });
      return Array.isArray(tiles) ? tiles : [];
    } catch (error) {
      if (terrainDebugEnabled) console.warn('Failed to query hillshade tiles from debug API', error);
      return [];
    }
  }

  function extractHillshadeColorAttachment(tile) {
    if (!tile || !tile.fbo || !tile.fbo.colorAttachment) {
      return null;
    }
    const attachment = tile.fbo.colorAttachment;
    if (typeof attachment.get === 'function') {
      try {
        return attachment.get();
      } catch (error) {
        if (terrainDebugEnabled) console.warn('Failed to access hillshade framebuffer attachment', error);
        return null;
      }
    }
    return attachment || null;
  }

  function collectNativeHillshadeTextures(mapInstance) {
    const tiles = getHillshadeDebugTiles(mapInstance, { onlyPrepared: true });
    if (!tiles.length) {
      return null;
    }
    const cache = new Map();
    for (const tile of tiles) {
      const key = tile && tile.tileID ? tile.tileID.key : null;
      if (!key || tile.needsHillshadePrepare) {
        continue;
      }
      const texture = extractHillshadeColorAttachment(tile);
      if (texture) {
        cache.set(key, texture);
      }
    }
    return cache.size > 0 ? cache : null;
  }

  // Global state variables
  const CUSTOM_LAYER_ORDER = Object.freeze(['hillshade', 'normal', 'avalanche', 'slope', 'aspect', 'snow', 'shadow', 'daylight']);
  const activeCustomModes = new Set();
  let currentMode = '';
  let hillshadeMode = 'none'; // "none", "native", or "custom"
  let lastCustomMode = 'hillshade';
  const meshCache = new Map();
  let snowAltitude = 3000;
  let snowMaxSlope = 55; // in degrees
  let snowBlurAmount = 1.0;
  let shadowSampleCount = 1;
  let shadowBlurRadius = 1.0;
  let shadowMaxDistance = 14000; // meters
  let shadowVisibilityThreshold = 0.02;
  let shadowEdgeSoftness = 0.01;
  let shadowMaxOpacity = 0.85;
  let shadowRayStepMultiplier = 1.0;
  let shadowSlopeBias = 0.03;
  let shadowPixelBias = 0.15;
  let pendingCustomLayerEnsure = false;
  function isModeActive(mode) {
    return activeCustomModes.has(mode);
  }
  function getActiveModesInOrder() {
    return CUSTOM_LAYER_ORDER.filter((mode) => activeCustomModes.has(mode));
  }
  const H4_SUNLIGHT_CONFIG = Object.freeze({
    azimuthCount: 48,
    quantizationLevels: 64,
    minutesStep: 5,
    angleMin: -2 * Math.PI / 180,
    angleMax: 90 * Math.PI / 180
  });
  let sunlightEngine = null;
  const SHADOW_BUFFER_MINUTES = 30;
  const DEFAULT_DAYLIGHT_BOUNDS = { min: 360, max: 1080 };
  let shadowTimeBounds = { min: 0, max: 1439 };
  const GRADIENT_ZOOM_PIVOT = 14;
  const MIN_GRADIENT_DISTANCE = 0.001;
  const GRADIENT_DISTANCE_DECIMALS = 3;

  function formatGradientDistance(value) {
    return value.toFixed(GRADIENT_DISTANCE_DECIMALS);
  }

  function formatGradientDistanceLabel(value) {
    return `${formatGradientDistance(value)} m`;
  }

  function formatAutoSamplingScaleLabel(scale) {
    if (!Number.isFinite(scale)) {
      return '1.00×';
    }
    return `${scale.toFixed(2)}×`;
  }

  const gradientParameters = {
    baseDistance: 0.35,
    minDistance: MIN_GRADIENT_DISTANCE,
    maxDistance: 3.0
  };
  let samplingDistance = gradientParameters.baseDistance;
  let isSamplingDistanceManual = false;
  let gradientAutoScaleKey = '0.1';
  let gradientAutoScale = parseFloat(gradientAutoScaleKey);
  let shadowDateValue = null;
  let shadowTimeValue = null;
  let map;

  let gradientSamplingSlider = null;
  let gradientSamplingValueEl = null;
  let gradientBaseSlider = null;
  let gradientBaseValueEl = null;
  let gradientMinSlider = null;
  let gradientMinValueEl = null;
  let gradientMaxSlider = null;
  let gradientMaxValueEl = null;
  let gradientAutoButton = null;
  let gradientAutoScaleSelect = null;
  let terrainMeshBtn = null;
  let terrainExportBtn = null;
  let terrainDebugBtn = null;
  let terrainMenuContainer = null;
  let terrainStatusEl = null;
  let layersPanelEl = null;
  let layersToggleButton = null;
  let layersCloseButton = null;
  let hqModeCheckbox = null;
  let toggle3DButton = null;
  let layersPanelOpen = false;

  const gradientPreparer = TerrainGradientPreparer.create();
  const EARTH_CIRCUMFERENCE_METERS = 40075016.68557849;
  const MIN_METERS_PER_PIXEL = 1e-6;
  const TERRAIN_ELEVATION_TILE_SIZE = 512;
  const TERRAIN_MESH_CONFIG = Object.freeze({
    extent: 8192,
    defaultDemDimension: 256,
    verticalScale: 1,
    verticalOffset: 0
  });
  const EARTH_RADIUS_METERS = 6378137;
  const TERRAIN_WIREFRAME_LAYER_ID = 'terrain-wireframe';
  let terrainWireframeLayerVisible = false;
  let terrainWireframeLayer = null;
  let terrainWireframeScene = null;
  let terrainWireframeMesh = null;
  let terrainSolidMesh = null;
  let terrainAmbientLight = null;
  let terrainDirectionalLight = null;
  let terrainDirectionalLightTarget = null;
  let terrainWireframeLoading = false;
  let terrainWireframeModelTransform = null;
  let supportsUint32IndexBuffer = false;
  let terrainMeshMetadata = null;

  if (typeof window !== 'undefined' && window.maplibregl && !window.mapboxgl) {
    window.mapboxgl = window.maplibregl;
  }

  function ensureSunlightEngine(gl) {
    if (sunlightEngine && sunlightEngine.supported) {
      return sunlightEngine;
    }
    if (sunlightEngine && !sunlightEngine.supported) {
      return null;
    }
    if (typeof window.H4SunlightEngine !== 'function' || !gl) {
      sunlightEngine = { supported: false };
      return null;
    }
    const engine = new window.H4SunlightEngine({
      azimuthCount: H4_SUNLIGHT_CONFIG.azimuthCount,
      quantizationLevels: H4_SUNLIGHT_CONFIG.quantizationLevels,
      minutesStep: H4_SUNLIGHT_CONFIG.minutesStep,
      angleMin: H4_SUNLIGHT_CONFIG.angleMin,
      angleMax: H4_SUNLIGHT_CONFIG.angleMax
    });
    const initialized = engine.initialize(gl, {
      neighborOffsets: NEIGHBOR_OFFSETS,
      maxNeighborOffset: MAX_NEIGHBOR_OFFSET
    });
    engine.supported = !!initialized;
    sunlightEngine = engine;
    return engine.supported ? engine : null;
  }

  function computeTileCenterLatitude(canonical) {
    if (!canonical) {
      return 0;
    }
    const z = Math.max(0, canonical.z || 0);
    const scale = Math.pow(2, z);
    if (!Number.isFinite(scale) || scale <= 0) {
      return 0;
    }
    const mercatorY = canonical.y + 0.5;
    const n = Math.PI - (2 * Math.PI * mercatorY) / scale;
    return (180 / Math.PI) * Math.atan(Math.sinh(n));
  }

  function computeMetersPerPixelForTile(canonical, tileSize) {
    if (!canonical || !Number.isFinite(tileSize) || tileSize <= 0) {
      return MIN_METERS_PER_PIXEL;
    }
    const lat = computeTileCenterLatitude(canonical);
    const latRad = lat * Math.PI / 180;
    const cosLat = Math.cos(latRad);
    const scale = Math.pow(2, Math.max(0, canonical.z || 0)) * tileSize;
    if (!Number.isFinite(scale) || scale <= 0) {
      return MIN_METERS_PER_PIXEL;
    }
    const metersPerPixel = (EARTH_CIRCUMFERENCE_METERS * Math.abs(cosLat)) / scale;
    return Math.max(metersPerPixel, MIN_METERS_PER_PIXEL);
  }
  let recomputeShadowTimeBounds = () => {};

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function sanitizeGradientParameters() {
    const minDistance = Math.max(MIN_GRADIENT_DISTANCE, Math.min(gradientParameters.minDistance, gradientParameters.maxDistance));
    const maxDistance = Math.max(minDistance, Math.max(gradientParameters.minDistance, gradientParameters.maxDistance));
    gradientParameters.minDistance = minDistance;
    gradientParameters.maxDistance = maxDistance;
    gradientParameters.baseDistance = clamp(gradientParameters.baseDistance, minDistance, maxDistance);
  }

  function clampSamplingDistanceToRange() {
    const clamped = clamp(samplingDistance, gradientParameters.minDistance, gradientParameters.maxDistance);
    if (Math.abs(clamped - samplingDistance) > 1e-4) {
      samplingDistance = clamped;
      return true;
    }
    return false;
  }

  function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    return clamp(value, 0, 1);
  }

  function formatExportFloat(value) {
    if (!Number.isFinite(value)) {
      return '0';
    }
    return value.toFixed(6).replace(/\.0+$/, '').replace(/(\.[0-9]*?)0+$/, '$1');
  }

  function updateTerrainExportButtonState() {
    if (!terrainExportBtn) {
      terrainExportBtn = document.getElementById('terrainExportBtn');
    }
    if (!terrainExportBtn) {
      return;
    }
    const vertexCount = terrainMeshMetadata?.vertexCount || 0;
    const hasMesh = Boolean(
      terrainWireframeLayerVisible &&
      terrainSolidMesh &&
      terrainSolidMesh.geometry &&
      vertexCount > 0
    );
    terrainExportBtn.disabled = !hasMesh;
    const baseLabel = 'Export Mesh (.obj)';
    terrainExportBtn.textContent = hasMesh
      ? `${baseLabel} – ${vertexCount.toLocaleString()} verts`
      : baseLabel;
  }

  function setTerrainStatus(message) {
    if (!terrainStatusEl) {
      terrainStatusEl = document.getElementById('terrainStatus');
    }
    if (terrainStatusEl) {
      terrainStatusEl.textContent = message;
    }
    updateTerrainExportButtonState();
  }

  function syncTerrainDebugQueryFlag(enabled) {
    if (typeof window === 'undefined' || !window.history || typeof window.history.replaceState !== 'function') {
      return;
    }
    try {
      const url = new URL(window.location.href);
      if (enabled) {
        url.searchParams.set('terrainDebug', '1');
      } else {
        url.searchParams.delete('terrainDebug');
      }
      window.history.replaceState({}, '', url.toString());
    } catch (error) {
      if (terrainDebugEnabled) {
        console.warn('Failed to update terrain debug flag in URL', error);
      }
    }
  }

  function setTerrainDebugEnabled(enabled, options = {}) {
    const nextEnabled = Boolean(enabled);
    if (terrainDebugEnabled === nextEnabled) {
      return terrainDebugEnabled;
    }
    terrainDebugEnabled = nextEnabled;
    if (options.updateUrl) {
      syncTerrainDebugQueryFlag(nextEnabled);
    }
    updateButtons();
    return terrainDebugEnabled;
  }

  function getRenderableTerrainTiles() {
    const tileManager = getTerrainTileManager(map);
    if (tileManager && typeof tileManager.getRenderableTiles === 'function') {
      try {
        const tiles = tileManager.getRenderableTiles();
        return Array.isArray(tiles) ? tiles : [];
      } catch (error) {
        if (terrainDebugEnabled) {
          console.warn('Failed to access terrain tiles via tile manager', error);
        }
        return [];
      }
    }

    const sourceCache = map?.terrain?.sourceCache;
    if (!sourceCache || typeof sourceCache.getRenderableTiles !== 'function') {
      return [];
    }
    try {
      const tiles = sourceCache.getRenderableTiles();
      return Array.isArray(tiles) ? tiles : [];
    } catch (error) {
      if (terrainDebugEnabled) {
        console.warn('Failed to access terrain tiles via source cache', error);
      }
      return [];
    }
  }

  function tileToLngLat(x, y, z) {
    const n = Math.pow(2, z);
    const lng = (x / n) * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180 / Math.PI;
    return { lng, lat };
  }

  function lngLatToMercator(lng, lat) {
    const x = EARTH_RADIUS_METERS * THREE.MathUtils.degToRad(lng);
    const y = EARTH_RADIUS_METERS * Math.log(Math.tan(Math.PI / 4 + THREE.MathUtils.degToRad(lat) / 2));
    return { x, y };
  }

  function tileToMercator(x, y, z) {
    const { lng, lat } = tileToLngLat(x, y, z);
    return lngLatToMercator(lng, lat);
  }

  function mercatorToLngLat(x, y) {
    const lng = THREE.MathUtils.radToDeg(x / EARTH_RADIUS_METERS);
    const lat = THREE.MathUtils.radToDeg(2 * Math.atan(Math.exp(y / EARTH_RADIUS_METERS)) - Math.PI / 2);
    return { lng, lat };
  }

  function isMatrixLike(value) {
    return Array.isArray(value) || ArrayBuffer.isView(value);
  }

  function resolveProjectionMatrix(input, mapInstance) {
    if (isMatrixLike(input)) {
      return input;
    }
    if (input && typeof input === 'object') {
      if (isMatrixLike(input.matrix)) {
        return input.matrix;
      }
      if (isMatrixLike(input.projectionMatrix)) {
        return input.projectionMatrix;
      }
      const defaultProjectionData = input.defaultProjectionData;
      if (defaultProjectionData && typeof defaultProjectionData === 'object') {
        if (isMatrixLike(defaultProjectionData.mainMatrix)) {
          return defaultProjectionData.mainMatrix;
        }
        if (isMatrixLike(defaultProjectionData.fallbackMatrix)) {
          return defaultProjectionData.fallbackMatrix;
        }
      }
    }
    if (mapInstance?.transform && typeof mapInstance.transform.customLayerMatrix === 'function') {
      const matrix = mapInstance.transform.customLayerMatrix();
      if (isMatrixLike(matrix)) {
        return matrix;
      }
    }
    return null;
  }

  function getTerrainDemUrl(tile) {
    if (!map || typeof map.getStyle !== 'function') {
      return null;
    }
    const style = map.getStyle();
    const demSource = style?.sources?.terrain;
    if (!demSource || !Array.isArray(demSource.tiles) || !demSource.tiles.length) {
      return null;
    }
    const urlTemplate = demSource.tiles[0];
    const { z, x, y } = tile.tileID.canonical;
    return urlTemplate.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  }

  async function loadDemTileForWireframe(tile, terrainData) {
    const url = getTerrainDemUrl(tile);
    if (!url) {
      throw new Error('DEM URL unavailable for tile');
    }
    const demDim = terrainData?.u_terrain_dim || TERRAIN_MESH_CONFIG.defaultDemDimension;
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = demDim;
        canvas.height = demDim;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, demDim, demDim);
        const imageData = ctx.getImageData(0, 0, demDim, demDim);
        const data = imageData.data;
        const elevations = new Float32Array(demDim * demDim);
        for (let i = 0; i < demDim * demDim; i++) {
          const r = data[i * 4];
          const g = data[i * 4 + 1];
          const b = data[i * 4 + 2];
          const elevation = -32768 + (r * 256) + g + (b / 256);
          elevations[i] = elevation;
        }
        resolve({ elevations, demDim });
      };
      img.onerror = () => reject(new Error(`Failed to load DEM tile: ${url}`));
      img.src = url;
    });
  }

  function createTileGeometryForWireframe(tile, elevations, demDim) {
    if (typeof maplibregl?.createTileMesh !== 'function') {
      return null;
    }
    const meshBuffers = maplibregl.createTileMesh({
      granularity: 128,
      generateBorders: false,
      extent: TERRAIN_MESH_CONFIG.extent
    }, '16bit');
    const vertices = new Int16Array(meshBuffers.vertices);
    const indices = new Int16Array(meshBuffers.indices);
    const vertexCount = vertices.length / 2;
    const positions = new Float32Array(vertexCount * 3);
    const extent = TERRAIN_MESH_CONFIG.extent;
    for (let i = 0; i < vertexCount; i++) {
      const x = vertices[i * 2];
      const y = vertices[i * 2 + 1];
      const sampleX = Math.min(demDim - 1, Math.max(0, Math.floor((x / extent) * (demDim - 1))));
      const sampleY = Math.min(demDim - 1, Math.max(0, Math.floor((y / extent) * (demDim - 1))));
      const elevation = elevations[sampleY * demDim + sampleX] || 0;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = elevation * TERRAIN_MESH_CONFIG.verticalScale + TERRAIN_MESH_CONFIG.verticalOffset;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(indices), 1));
    return geometry;
  }

  function mergeBufferGeometries(geometries) {
    let vertexCount = 0;
    let indexCount = 0;
    geometries.forEach((geometry) => {
      vertexCount += geometry.getAttribute('position').count;
      indexCount += geometry.getIndex().count;
    });
    if (vertexCount > 65535 && !supportsUint32IndexBuffer) {
      const error = new Error('WebGL context does not support 32-bit index buffers required for merged terrain geometry.');
      error.code = 'UINT32_INDEX_UNSUPPORTED';
      throw error;
    }
    const IndexArray = vertexCount > 65535 ? Uint32Array : Uint16Array;
    const mergedPositions = new Float32Array(vertexCount * 3);
    const mergedIndices = new IndexArray(indexCount);
    let vertexOffset = 0;
    let indexOffset = 0;
    geometries.forEach((geometry) => {
      const positions = geometry.getAttribute('position').array;
      const indices = geometry.getIndex().array;
      mergedPositions.set(positions, vertexOffset * 3);
      for (let i = 0; i < indices.length; i++) {
        mergedIndices[indexOffset + i] = indices[i] + vertexOffset;
      }
      vertexOffset += positions.length / 3;
      indexOffset += indices.length;
    });
    const mergedGeometry = new THREE.BufferGeometry();
    mergedGeometry.setAttribute('position', new THREE.BufferAttribute(mergedPositions, 3));
    mergedGeometry.setIndex(new THREE.BufferAttribute(mergedIndices, 1));
    return mergedGeometry;
  }

  function exportTerrainMeshAsOBJ() {
    if (!terrainSolidMesh || !terrainSolidMesh.geometry) {
      setTerrainStatus('No Three.js mesh available for export.');
      return;
    }
    try {
      const geometry = terrainSolidMesh.geometry;
      const positionAttr = geometry.getAttribute('position');
      if (!positionAttr) {
        setTerrainStatus('Terrain mesh is missing position data.');
        return;
      }
      const positions = positionAttr.array;
      const normalAttr = geometry.getAttribute('normal');
      const normals = normalAttr ? normalAttr.array : null;
      const hasNormals = Boolean(normals && normalAttr.count === positionAttr.count);
      const indexAttr = geometry.getIndex();
      const indices = indexAttr ? indexAttr.array : null;
      const lines = [];
      lines.push('# MapLibre terrain mesh export');
      lines.push('# Units are meters relative to the mesh origin.');
      if (terrainMeshMetadata) {
        lines.push(`# Vertex count: ${terrainMeshMetadata.vertexCount}`);
        lines.push(`# Index count: ${terrainMeshMetadata.indexCount}`);
        if (terrainMeshMetadata.originMercator) {
          const origin = terrainMeshMetadata.originMercator;
          lines.push(`# Origin (mercator meters): ${formatExportFloat(origin.x)}, ${formatExportFloat(origin.y)}`);
        }
        if (terrainMeshMetadata.modelTransform) {
          const transform = terrainMeshMetadata.modelTransform;
          lines.push(`# Map transform scale: ${formatExportFloat(transform.scale)}`);
          lines.push(`# Map transform translate: ${formatExportFloat(transform.translateX)}, ${formatExportFloat(transform.translateY)}, ${formatExportFloat(transform.translateZ)}`);
        }
        if (terrainMeshMetadata.bounds) {
          const { min, max } = terrainMeshMetadata.bounds;
          lines.push(`# Bounds min: ${formatExportFloat(min.x)}, ${formatExportFloat(min.y)}, ${formatExportFloat(min.z)}`);
          lines.push(`# Bounds max: ${formatExportFloat(max.x)}, ${formatExportFloat(max.y)}, ${formatExportFloat(max.z)}`);
        }
      }
      for (let i = 0; i < positions.length; i += 3) {
        lines.push(`v ${formatExportFloat(positions[i])} ${formatExportFloat(positions[i + 1])} ${formatExportFloat(positions[i + 2])}`);
      }
      if (hasNormals) {
        for (let i = 0; i < normals.length; i += 3) {
          lines.push(`vn ${formatExportFloat(-normals[i])} ${formatExportFloat(-normals[i + 1])} ${formatExportFloat(-normals[i + 2])}`);
        }
      }
      if (indices && indices.length >= 3) {
        for (let i = 0; i < indices.length; i += 3) {
          const a = indices[i] + 1;
          const b = indices[i + 1] + 1;
          const c = indices[i + 2] + 1;
          if (hasNormals) {
            lines.push(`f ${a}//${a} ${c}//${c} ${b}//${b}`);
          } else {
            lines.push(`f ${a} ${c} ${b}`);
          }
        }
      } else {
        for (let i = 0; i < positions.length / 3; i += 3) {
          const a = i + 1;
          const b = i + 2;
          const c = i + 3;
          if (hasNormals) {
            lines.push(`f ${a}//${a} ${c}//${c} ${b}//${b}`);
          } else {
            lines.push(`f ${a} ${c} ${b}`);
          }
        }
      }
      const objContent = `${lines.join('\n')}\n`;
      const blob = new Blob([objContent], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
      const link = document.createElement('a');
      link.href = url;
      link.download = `terrain-mesh-${timestamp}.obj`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setTerrainStatus('Exported terrain mesh as OBJ.');
    } catch (error) {
      if (terrainDebugEnabled) {
        console.error('Failed to export terrain mesh', error);
      }
      setTerrainStatus('Failed to export terrain mesh.');
    }
  }

  async function rebuildTerrainWireframe() {
    logTerrainDebug('rebuildTerrainWireframe invoked', {
      layerVisible: terrainWireframeLayerVisible,
      hasScene: !!terrainWireframeScene,
      loading: terrainWireframeLoading
    });

    if (!terrainWireframeLayerVisible || !terrainWireframeScene) {
      logTerrainDebug('Skipping rebuild: terrain wireframe layer not ready.');
      return;
    }
    if (terrainWireframeLoading) {
      logTerrainDebug('Skipping rebuild: a rebuild is already in progress.');
      return;
    }
    if (typeof THREE === 'undefined') {
      logTerrainDebug('Skipping rebuild: THREE.js is not available.');
      setTerrainStatus('Three.js is required for the mesh layer.');
      return;
    }
    const tiles = getRenderableTerrainTiles();
    if (!tiles.length) {
      logTerrainDebug('Skipping rebuild: no renderable terrain tiles.');
      if (terrainWireframeMesh && terrainWireframeScene) {
        terrainWireframeScene.remove(terrainWireframeMesh);
        terrainWireframeMesh.geometry.dispose();
        if (terrainWireframeMesh.material) {
          terrainWireframeMesh.material.dispose();
        }
        terrainWireframeMesh = null;
      }
      terrainWireframeModelTransform = null;
      terrainMeshMetadata = null;
      setTerrainStatus('No terrain tiles available.');
      return;
    }
    terrainWireframeLoading = true;
    terrainMeshMetadata = null;
    updateTerrainExportButtonState();
    logTerrainDebug('Building Three.js mesh for tiles', tiles.map((tile) => tile?.tileID?.key));
    setTerrainStatus('Building Three.js mesh…');
    try {
      const mercatorPositions = tiles.map((tile) => {
        const { x, y, z } = tile.tileID.canonical;
        return tileToMercator(x, y, z);
      });
      let globalMinX = Infinity;
      let globalMaxY = -Infinity;
      mercatorPositions.forEach((pos) => {
        if (pos.x < globalMinX) globalMinX = pos.x;
        if (pos.y > globalMaxY) globalMaxY = pos.y;
      });
      if (!Number.isFinite(globalMinX) || !Number.isFinite(globalMaxY)) {
        logTerrainDebug('Unable to determine mesh bounds from tiles', {
          globalMinX,
          globalMaxY
        });
        setTerrainStatus('Unable to determine mesh bounds.');
        return;
      }

      const geometries = [];
      for (const tile of tiles) {
        logTerrainDebug('Processing tile for terrain mesh', tile.tileID);
        const terrainData = map?.terrain?.getTerrainData?.(tile.tileID) || null;
        let elevations;
        let demDim;
        if (terrainData?.elevations) {
          logTerrainDebug('Using cached terrain data for tile', tile.tileID);
          elevations = terrainData.elevations;
          demDim = terrainData.u_terrain_dim || TERRAIN_MESH_CONFIG.defaultDemDimension;
        } else {
          try {
            const result = await loadDemTileForWireframe(tile, terrainData);
            logTerrainDebug('Loaded DEM tile for mesh', {
              tileID: tile.tileID,
              demDimension: result.demDim
            });
            elevations = result.elevations;
            demDim = result.demDim;
          } catch (error) {
            if (terrainDebugEnabled) {
              console.warn('Failed to load DEM tile for mesh', tile.tileID, error);
            }
            logTerrainDebug('Skipping tile due to DEM loading failure', tile.tileID);
            continue;
          }
        }
        if (!elevations || !demDim) {
          logTerrainDebug('Skipping tile: no elevation data available', tile.tileID);
          continue;
        }
        const geometry = createTileGeometryForWireframe(tile, elevations, demDim);
        if (!geometry) {
          logTerrainDebug('Skipping tile: failed to create geometry', tile.tileID);
          continue;
        }
        const { x, y, z } = tile.tileID.canonical;
        const tileMercatorTL = tileToMercator(x, y, z);
        const tileMercatorBR = tileToMercator(x + 1, y + 1, z);
        const tileSizeMeters = tileMercatorBR.x - tileMercatorTL.x;
        const scaleFactor = tileSizeMeters / TERRAIN_MESH_CONFIG.extent;
        geometry.scale(scaleFactor, scaleFactor, 1);
        geometry.translate(tileMercatorTL.x - globalMinX, globalMaxY - tileMercatorTL.y, 0);
        geometries.push(geometry);
      }

      if (!geometries.length) {
        logTerrainDebug('No geometries produced for terrain mesh rebuild.');
        if (terrainWireframeMesh && terrainWireframeScene) {
          terrainWireframeScene.remove(terrainWireframeMesh);
          terrainWireframeMesh.geometry.dispose();
          if (terrainWireframeMesh.material) {
            terrainWireframeMesh.material.dispose();
          }
          terrainWireframeMesh = null;
        }
        if (terrainSolidMesh && terrainWireframeScene) {
          terrainWireframeScene.remove(terrainSolidMesh);
          terrainSolidMesh.geometry.dispose();
          if (terrainSolidMesh.material) {
            terrainSolidMesh.material.dispose();
          }
          terrainSolidMesh = null;
        }
        terrainWireframeModelTransform = null;
        terrainMeshMetadata = null;
        setTerrainStatus('No geometry could be generated.');
        if (map) {
          map.triggerRepaint();
        }
        return;
      }

      const mergedGeometry = mergeBufferGeometries(geometries);
      logTerrainDebug('Merged terrain geometry created', {
        geometryCount: geometries.length,
        vertexCount: mergedGeometry.getAttribute('position').count,
        indexCount: mergedGeometry.getIndex().count
      });
      geometries.forEach((geometry) => geometry.dispose());
      mergedGeometry.computeBoundingBox();
      mergedGeometry.computeBoundingSphere();
      mergedGeometry.computeVertexNormals();
      const vertexCount = mergedGeometry.getAttribute('position').count;

      if (terrainWireframeScene) {
        if (terrainWireframeMesh) {
          terrainWireframeScene.remove(terrainWireframeMesh);
          terrainWireframeMesh.geometry.dispose();
          if (terrainWireframeMesh.material) {
            terrainWireframeMesh.material.dispose();
          }
          terrainWireframeMesh = null;
        }
        if (terrainSolidMesh) {
          terrainWireframeScene.remove(terrainSolidMesh);
          terrainSolidMesh.geometry.dispose();
          if (terrainSolidMesh.material) {
            terrainSolidMesh.material.dispose();
          }
          terrainSolidMesh = null;
        }
      }

      const wireframeGeometry = new THREE.WireframeGeometry(mergedGeometry);
      const material = new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        depthTest: false
      });
      terrainWireframeMesh = new THREE.LineSegments(wireframeGeometry, material);
      terrainWireframeMesh.frustumCulled = false;
      logTerrainDebug('Wireframe mesh ready', {
        vertexCount,
        boundingBox: mergedGeometry.boundingBox,
        boundingSphere: mergedGeometry.boundingSphere
      });
      if (terrainWireframeScene) {
        terrainWireframeScene.add(terrainWireframeMesh);
      }

      const meshMaterial = new THREE.MeshStandardMaterial({
        color: 0x777777,
        metalness: 0.05,
        roughness: 0.85,
        flatShading: false
      });
      terrainSolidMesh = new THREE.Mesh(mergedGeometry, meshMaterial);
      terrainSolidMesh.frustumCulled = false;
      terrainSolidMesh.castShadow = true;
      terrainSolidMesh.receiveShadow = true;
      logTerrainDebug('Solid mesh ready', {
        vertexCount,
        materialSettings: {
          color: meshMaterial.color?.getHex?.(),
          metalness: meshMaterial.metalness,
          roughness: meshMaterial.roughness
        }
      });
      if (terrainWireframeScene) {
        terrainWireframeScene.add(terrainSolidMesh);
      }

      const originLngLat = mercatorToLngLat(globalMinX, globalMaxY);
      const originCoord = maplibregl.MercatorCoordinate.fromLngLat(originLngLat, 0);
      const metersInUnits = originCoord.meterInMercatorCoordinateUnits();
      terrainWireframeModelTransform = {
        translateX: originCoord.x,
        translateY: originCoord.y,
        translateZ: originCoord.z,
        scale: metersInUnits
      };
      logTerrainDebug('Updated terrain wireframe transform', terrainWireframeModelTransform);

      const boundingBox = mergedGeometry.boundingBox;
      terrainMeshMetadata = {
        vertexCount,
        indexCount: mergedGeometry.getIndex().count,
        originMercator: { x: globalMinX, y: globalMaxY },
        modelTransform: terrainWireframeModelTransform
          ? {
            translateX: terrainWireframeModelTransform.translateX,
            translateY: terrainWireframeModelTransform.translateY,
            translateZ: terrainWireframeModelTransform.translateZ,
            scale: terrainWireframeModelTransform.scale
          }
          : null,
        bounds: boundingBox
          ? {
            min: { x: boundingBox.min.x, y: boundingBox.min.y, z: boundingBox.min.z },
            max: { x: boundingBox.max.x, y: boundingBox.max.y, z: boundingBox.max.z }
          }
          : null
      };

      if (terrainDirectionalLight && terrainDirectionalLightTarget && mergedGeometry.boundingSphere) {
        const { center, radius } = mergedGeometry.boundingSphere;
        terrainDirectionalLightTarget.position.copy(center);
        const lightOffset = radius * 1.5;
        terrainDirectionalLight.position.set(
          center.x + lightOffset,
          center.y - lightOffset * 0.6,
          center.z + lightOffset
        );
        terrainDirectionalLight.updateMatrixWorld();
        terrainDirectionalLight.target.updateMatrixWorld();
        const shadowCamera = terrainDirectionalLight.shadow && terrainDirectionalLight.shadow.camera;
        if (shadowCamera && typeof shadowCamera.updateProjectionMatrix === 'function') {
          const range = Math.max(radius * 2.0, 100);
          shadowCamera.left = -range;
          shadowCamera.right = range;
          shadowCamera.top = range;
          shadowCamera.bottom = -range;
          shadowCamera.near = Math.max(0.1, radius * 0.01);
          shadowCamera.far = Math.max(range * 3, radius * 4);
          shadowCamera.updateProjectionMatrix();
        }
        logTerrainDebug('Updated terrain lighting for mesh', {
          lightPosition: terrainDirectionalLight.position.clone?.(),
          targetPosition: terrainDirectionalLightTarget.position.clone?.(),
          boundingSphere: mergedGeometry.boundingSphere
        });
      }

      setTerrainStatus(`Three.js mesh ready (${vertexCount} vertices).`);
      logTerrainDebug('Terrain mesh rebuild completed successfully.');
      if (map) {
        map.triggerRepaint();
      }
    } catch (error) {
      if (error?.code === 'UINT32_INDEX_UNSUPPORTED') {
        logTerrainDebug('Terrain mesh rebuild aborted: 32-bit index buffers unavailable.');
        setTerrainStatus('Three.js mesh requires 32-bit index buffer support from WebGL.');
      } else {
        if (terrainDebugEnabled) {
          console.error('Failed to rebuild terrain Three.js mesh', error);
        }
        setTerrainStatus('Failed to build Three.js mesh.');
      }
    } finally {
      terrainWireframeLoading = false;
      updateTerrainExportButtonState();
      logTerrainDebug('Terrain mesh rebuild finished', { loading: terrainWireframeLoading });
    }
  }

  function ensureTerrainWireframeLayer() {
    logTerrainDebug('ensureTerrainWireframeLayer called', {
      hasMap: !!map,
      hasLayer: !!terrainWireframeLayer
    });
    if (!map) {
      logTerrainDebug('Cannot create terrain wireframe layer: map unavailable.');
      return null;
    }
    if (terrainWireframeLayer) {
      logTerrainDebug('Reusing existing terrain wireframe layer instance.');
      return terrainWireframeLayer;
    }
    if (typeof THREE === 'undefined') {
      logTerrainDebug('Cannot create terrain wireframe layer: THREE.js is not available.');
      setTerrainStatus('Three.js is required for the mesh layer.');
      return null;
    }
    terrainWireframeLayer = {
      id: TERRAIN_WIREFRAME_LAYER_ID,
      type: 'custom',
      renderingMode: '3d',
      onAdd(mapInstance, gl) {
        logTerrainDebug('terrainWireframeLayer.onAdd invoked', {
          hasGLContext: !!gl,
          mapId: getMapDebugIdentifier(mapInstance)
        });
        this.map = mapInstance;
        this.camera = new THREE.Camera();
        this.renderer = new THREE.WebGLRenderer({
          canvas: mapInstance.getCanvas(),
          context: gl
        });
        this.renderer.autoClear = false;
        this.renderer.autoClearColor = false;
        this.renderer.autoClearDepth = false;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
        supportsUint32IndexBuffer = isWebGL2;
        if (!supportsUint32IndexBuffer && gl && typeof gl.getExtension === 'function') {
          supportsUint32IndexBuffer = !!gl.getExtension('OES_element_index_uint');
        }
        logTerrainDebug('Terrain wireframe WebGL capabilities detected', {
          isWebGL2,
          supportsUint32IndexBuffer
        });
        if (!supportsUint32IndexBuffer && terrainDebugEnabled) {
          console.warn('32-bit index buffers are not supported by the active WebGL context. Terrain meshes may not render.');
        }
        terrainWireframeScene = new THREE.Scene();
        terrainAmbientLight = new THREE.AmbientLight(0xffffff, 0.4);
        terrainDirectionalLight = new THREE.DirectionalLight(0xffffff, 0.9);
        terrainDirectionalLight.castShadow = true;
        terrainDirectionalLight.shadow.bias = -0.0001;
        terrainDirectionalLight.shadow.mapSize.set(2048, 2048);
        terrainDirectionalLight.shadow.camera.near = 0.1;
        terrainDirectionalLight.shadow.camera.far = 10000;
        terrainDirectionalLightTarget = new THREE.Object3D();
        terrainWireframeScene.add(terrainAmbientLight);
        terrainWireframeScene.add(terrainDirectionalLight);
        terrainWireframeScene.add(terrainDirectionalLightTarget);
        terrainDirectionalLight.target = terrainDirectionalLightTarget;
        logTerrainDebug('Terrain wireframe scene initialized', {
          ambientLightIntensity: terrainAmbientLight.intensity,
          directionalLightIntensity: terrainDirectionalLight.intensity
        });
        rebuildTerrainWireframe();
      },
      render(gl, matrixOrArgs) {
        if (!terrainWireframeScene || !terrainWireframeModelTransform) {
          if (this.map) {
            this.map.triggerRepaint();
          }
          return;
        }
        const camera = this.camera;
        const renderer = this.renderer;
        const projectionArray = resolveProjectionMatrix(matrixOrArgs, this.map);
        if (!projectionArray) {
          if (this.map) {
            this.map.triggerRepaint();
          }
          return;
        }
        const projectionMatrix = new THREE.Matrix4().fromArray(projectionArray);
        if (gl && typeof gl.depthMask === 'function') {
          gl.depthMask(true);
        }
        if (gl && typeof gl.clearDepth === 'function') {
          gl.clearDepth(1.0);
        }
        if (gl && typeof gl.clear === 'function' && typeof gl.DEPTH_BUFFER_BIT === 'number') {
          gl.clear(gl.DEPTH_BUFFER_BIT);
        }
        const transform = new THREE.Matrix4()
          .makeTranslation(
            terrainWireframeModelTransform.translateX,
            terrainWireframeModelTransform.translateY,
            terrainWireframeModelTransform.translateZ
          )
          .scale(new THREE.Vector3(
            terrainWireframeModelTransform.scale,
            -terrainWireframeModelTransform.scale,
            terrainWireframeModelTransform.scale
          ));
        camera.projectionMatrix = projectionMatrix.multiply(transform);
        if (camera.projectionMatrixInverse && typeof camera.projectionMatrixInverse.copy === 'function') {
          camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        }
        if (camera.matrixWorldInverse && typeof camera.matrixWorldInverse.identity === 'function') {
          camera.matrixWorldInverse.identity();
        }
        if (camera.matrixWorld && typeof camera.matrixWorld.identity === 'function') {
          camera.matrixWorld.identity();
        }
        if (typeof renderer.resetState === 'function') {
          renderer.resetState();
        }
        if (typeof renderer.setRenderTarget === 'function') {
          renderer.setRenderTarget(null);
        }
        renderer.render(terrainWireframeScene, camera);
        if (typeof renderer.resetState === 'function') {
          renderer.resetState();
        }
        if (this.map) {
          this.map.triggerRepaint();
        }
      },
      onRemove() {
        logTerrainDebug('terrainWireframeLayer.onRemove invoked');
        if (terrainWireframeScene && terrainWireframeMesh) {
          terrainWireframeScene.remove(terrainWireframeMesh);
          terrainWireframeMesh.geometry.dispose();
          if (terrainWireframeMesh.material) {
            terrainWireframeMesh.material.dispose();
          }
        }
        if (terrainWireframeScene && terrainSolidMesh) {
          terrainWireframeScene.remove(terrainSolidMesh);
          terrainSolidMesh.geometry.dispose();
          if (terrainSolidMesh.material) {
            terrainSolidMesh.material.dispose();
          }
        }
        if (terrainWireframeScene && terrainAmbientLight) {
          terrainWireframeScene.remove(terrainAmbientLight);
        }
        if (terrainWireframeScene && terrainDirectionalLight) {
          terrainWireframeScene.remove(terrainDirectionalLight);
        }
        if (terrainWireframeScene && terrainDirectionalLightTarget) {
          terrainWireframeScene.remove(terrainDirectionalLightTarget);
        }
        terrainWireframeScene = null;
        terrainWireframeMesh = null;
        terrainSolidMesh = null;
        terrainAmbientLight = null;
        terrainDirectionalLight = null;
        terrainDirectionalLightTarget = null;
        terrainWireframeModelTransform = null;
        terrainMeshMetadata = null;
        terrainWireframeLayer = null;
        if (this.renderer && typeof this.renderer.resetState === 'function') {
          this.renderer.resetState();
        }
        this.renderer = null;
        this.camera = null;
        this.map = null;
        supportsUint32IndexBuffer = false;
      }
    };
    logTerrainDebug('Created new terrain wireframe layer instance.');
    return terrainWireframeLayer;
  }

  async function setTerrainWireframeVisibility(visible) {
    const shouldShow = Boolean(visible);
    logTerrainDebug('setTerrainWireframeVisibility called', {
      requestedVisibility: shouldShow,
      currentVisibility: terrainWireframeLayerVisible
    });
    if (terrainWireframeLayerVisible === shouldShow) {
      logTerrainDebug('Terrain wireframe visibility unchanged.');
      return;
    }
    terrainWireframeLayerVisible = shouldShow;
    if (!map) {
      logTerrainDebug('Cannot toggle terrain wireframe: map unavailable.');
      updateButtons();
      return;
    }
    if (shouldShow) {
      const layer = ensureTerrainWireframeLayer();
      if (!layer) {
        terrainWireframeLayerVisible = false;
        updateButtons();
        return;
      }
      const existing = typeof map.getLayer === 'function' ? map.getLayer(TERRAIN_WIREFRAME_LAYER_ID) : null;
      if (!existing) {
        try {
          map.addLayer(layer, getLayerInsertionPoint());
          pushTerrainWireframeLayerToFront();
          logTerrainDebug('Terrain wireframe layer added to map.');
        } catch (error) {
          if (terrainDebugEnabled) {
            console.warn('Failed to add terrain Three.js mesh layer', error);
          }
          terrainWireframeLayerVisible = false;
          terrainWireframeLayer = null;
          setTerrainStatus('Unable to add Three.js mesh layer.');
          updateButtons();
          return;
        }
      }
      await rebuildTerrainWireframe();
      logTerrainDebug('Terrain wireframe rebuild awaited after enabling visibility.');
      pushTerrainWireframeLayerToFront();
    } else {
      if (typeof map.getLayer === 'function' && map.getLayer(TERRAIN_WIREFRAME_LAYER_ID)) {
        try {
          map.removeLayer(TERRAIN_WIREFRAME_LAYER_ID);
          logTerrainDebug('Terrain wireframe layer removed from map.');
        } catch (error) {
          if (terrainDebugEnabled) {
            console.warn('Failed to remove terrain Three.js mesh layer', error);
          }
        }
      }
      terrainWireframeLayer = null;
      terrainWireframeScene = null;
      terrainWireframeMesh = null;
      terrainSolidMesh = null;
      terrainAmbientLight = null;
      terrainDirectionalLight = null;
      terrainDirectionalLightTarget = null;
      terrainWireframeModelTransform = null;
      terrainMeshMetadata = null;
      setTerrainStatus('Mesh hidden.');
      logTerrainDebug('Terrain wireframe visibility disabled.');
    }
    updateButtons();
  }

  function pushTerrainWireframeLayerToFront() {
    if (!map || typeof map.moveLayer !== 'function' || typeof map.getLayer !== 'function') {
      logTerrainDebug('Cannot move terrain wireframe layer: map capabilities missing.');
      return;
    }
    if (!map.getLayer(TERRAIN_WIREFRAME_LAYER_ID)) {
      logTerrainDebug('Cannot move terrain wireframe layer: layer not found.');
      return;
    }
    try {
      if (map.getLayer(SKY_LAYER_ID)) {
        map.moveLayer(TERRAIN_WIREFRAME_LAYER_ID, SKY_LAYER_ID);
      } else {
        map.moveLayer(TERRAIN_WIREFRAME_LAYER_ID);
      }
      logTerrainDebug('Terrain wireframe layer moved to front.');
    } catch (error) {
      if (terrainDebugEnabled) {
        console.warn('Failed to move terrain Three.js mesh layer to the front', error);
      }
    }
  }

  function degreesToRadians(value) {
    return (Number.isFinite(value) ? value : 0) * Math.PI / 180;
  }

  function normalizeVec2(vec) {
    if (!vec || vec.length < 2) return [0, 1];
    const x = Number(vec[0]);
    const y = Number(vec[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return [0, 1];
    }
    const length = Math.hypot(x, y);
    if (!Number.isFinite(length) || length === 0) {
      return [0, 1];
    }
    return [x / length, y / length];
  }

  function copyColorArray(color, fallback) {
    const base = Array.isArray(fallback) ? fallback : DEFAULT_HILLSHADE_SETTINGS.highlightColor;
    if (!Array.isArray(color) || color.length < 3) {
      return base.slice();
    }
    return [
      clamp01(color[0]),
      clamp01(color[1]),
      clamp01(color[2])
    ];
  }

  function parseHexComponent(component) {
    return clamp01(parseInt(component, 16) / 255);
  }

  function parseHexColor(value, fallback) {
    const cleaned = value.replace('#', '');
    if (cleaned.length === 3) {
      return [
        parseHexComponent(cleaned[0] + cleaned[0]),
        parseHexComponent(cleaned[1] + cleaned[1]),
        parseHexComponent(cleaned[2] + cleaned[2])
      ];
    }
    if (cleaned.length >= 6) {
      return [
        parseHexComponent(cleaned.slice(0, 2)),
        parseHexComponent(cleaned.slice(2, 4)),
        parseHexComponent(cleaned.slice(4, 6))
      ];
    }
    return fallback.slice();
  }

  function getMapDebugIdentifier(mapInstance) {
    if (!mapInstance) {
      return undefined;
    }
    const container = typeof mapInstance.getContainer === 'function'
      ? mapInstance.getContainer()
      : mapInstance._container;
    if (container) {
      if (container.id) {
        return container.id;
      }
      if (container.className) {
        const classNames = container.className.trim().split(/\s+/).filter(Boolean);
        if (classNames.length) {
          return `.${classNames.join('.')}`;
        }
      }
    }
    const canvas = typeof mapInstance.getCanvas === 'function'
      ? mapInstance.getCanvas()
      : mapInstance._canvas;
    if (canvas && canvas.id) {
      return canvas.id;
    }
    if (mapInstance._instanceId !== undefined) {
      return mapInstance._instanceId;
    }
    if (mapInstance._id !== undefined) {
      return mapInstance._id;
    }
    if (mapInstance.id !== undefined) {
      return mapInstance.id;
    }
    return undefined;
  }

  function parseRgbColor(value, fallback) {
    const match = value.match(/rgba?\s*\(([^)]+)\)/i);
    if (!match) return fallback.slice();
    const parts = match[1].split(',').map(part => part.trim()).slice(0, 3);
    if (parts.length < 3) return fallback.slice();
    const components = parts.map(part => {
      if (part.endsWith('%')) {
        const num = parseFloat(part) / 100;
        return clamp01(num);
      }
      const num = parseFloat(part);
      if (!Number.isFinite(num)) return 0;
      return num > 1 ? clamp01(num / 255) : clamp01(num);
    });
    return copyColorArray(components, fallback);
  }

  function toColorArray(value, fallback) {
    if (Array.isArray(value)) {
      const normalized = value.map(component => {
        const num = Number(component);
        if (!Number.isFinite(num)) return 0;
        return num > 1 ? clamp01(num / 255) : clamp01(num);
      });
      return copyColorArray(normalized, fallback);
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.startsWith('#')) {
        return parseHexColor(trimmed, fallback);
      }
      if (trimmed.startsWith('rgb')) {
        return parseRgbColor(trimmed, fallback);
      }
    }
    return fallback.slice();
  }

  function updateHillshadePaintSettingsFromMap() {
    if (!map || typeof map.getLayer !== 'function' || !map.getLayer(HILLSHADE_NATIVE_LAYER_ID)) {
      return;
    }
    const highlight = map.getPaintProperty(HILLSHADE_NATIVE_LAYER_ID, 'hillshade-highlight-color');
    const shadow = map.getPaintProperty(HILLSHADE_NATIVE_LAYER_ID, 'hillshade-shadow-color');
    const accent = map.getPaintProperty(HILLSHADE_NATIVE_LAYER_ID, 'hillshade-accent-color');
    const exaggeration = map.getPaintProperty(HILLSHADE_NATIVE_LAYER_ID, 'hillshade-exaggeration');
    const direction = map.getPaintProperty(HILLSHADE_NATIVE_LAYER_ID, 'hillshade-illumination-direction');
    const anchor = map.getPaintProperty(HILLSHADE_NATIVE_LAYER_ID, 'hillshade-illumination-anchor');
    const opacity = map.getPaintProperty(HILLSHADE_NATIVE_LAYER_ID, 'hillshade-opacity');

    hillshadePaintSettings.highlightColor = toColorArray(highlight, DEFAULT_HILLSHADE_SETTINGS.highlightColor);
    hillshadePaintSettings.shadowColor = toColorArray(shadow, DEFAULT_HILLSHADE_SETTINGS.shadowColor);
    hillshadePaintSettings.accentColor = toColorArray(accent, DEFAULT_HILLSHADE_SETTINGS.accentColor);

    if (Number.isFinite(exaggeration)) {
      hillshadePaintSettings.exaggeration = exaggeration;
    }
    if (Number.isFinite(direction)) {
      hillshadePaintSettings.illuminationDirection = direction;
    }
    if (typeof anchor === 'string') {
      hillshadePaintSettings.illuminationAnchor = anchor;
    }
    if (Number.isFinite(opacity)) {
      hillshadePaintSettings.opacity = clamp01(opacity);
    }
  }

  function computeHillshadeLightDirection(settings, mapInstance) {
    const anchor = settings.illuminationAnchor || DEFAULT_HILLSHADE_SETTINGS.illuminationAnchor;
    const baseDirection = Number.isFinite(settings.illuminationDirection)
      ? settings.illuminationDirection
      : DEFAULT_HILLSHADE_SETTINGS.illuminationDirection;
    const bearing = mapInstance && typeof mapInstance.getBearing === 'function'
      ? mapInstance.getBearing()
      : 0;
    const adjusted = anchor === 'viewport' ? baseDirection - bearing : baseDirection;
    const azimuth = degreesToRadians(adjusted);
    const dir = [Math.sin(azimuth), Math.cos(azimuth)];
    return normalizeVec2(dir);
  }

  function getHillshadeUniformsForCustomLayer(mapInstance) {
    const settings = hillshadePaintSettings;
    return {
      highlightColor: copyColorArray(settings.highlightColor, DEFAULT_HILLSHADE_SETTINGS.highlightColor),
      shadowColor: copyColorArray(settings.shadowColor, DEFAULT_HILLSHADE_SETTINGS.shadowColor),
      accentColor: copyColorArray(settings.accentColor, DEFAULT_HILLSHADE_SETTINGS.accentColor),
      exaggeration: Number.isFinite(settings.exaggeration) ? settings.exaggeration : DEFAULT_HILLSHADE_SETTINGS.exaggeration,
      opacity: Number.isFinite(settings.opacity) ? clamp01(settings.opacity) : DEFAULT_HILLSHADE_SETTINGS.opacity,
      lightDir: computeHillshadeLightDirection(settings, mapInstance),
      lightAltitude: degreesToRadians(settings.lightAltitude || DEFAULT_HILLSHADE_SETTINGS.lightAltitude)
    };
  }

  function minutesToIsoTime(totalMinutes) {
    const minutes = clamp(Math.round(totalMinutes), 0, 1439);
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
  }

  function isoTimeToMinutes(isoTime) {
    if (!isoTime || typeof isoTime !== 'string') return null;
    const [hoursStr, minutesStr] = isoTime.split(':');
    const hours = Number(hoursStr);
    const minutes = Number(minutesStr);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
      return null;
    }
    return hours * 60 + minutes;
  }

  function computeSamplingDistanceForZoom(zoom) {
    sanitizeGradientParameters();
    const minDistance = gradientParameters.minDistance;
    const maxDistance = gradientParameters.maxDistance;
    const baseDistance = clamp(gradientParameters.baseDistance, minDistance, maxDistance);
    if (!Number.isFinite(zoom)) {
      return baseDistance;
    }
    const effectiveZoom = Math.min(Math.max(zoom, 0), DEM_MAX_ZOOM);
    const scaled = baseDistance * gradientAutoScale * Math.pow(2, GRADIENT_ZOOM_PIVOT - effectiveZoom);
    return clamp(scaled, minDistance, maxDistance);
  }

  function updateSamplingDistanceForZoom(forceInvalidate = false) {
    if (!map) return;
    if (isSamplingDistanceManual) {
      if (forceInvalidate) {
        gradientPreparer.invalidateAll();
        refreshGradientUI();
      }
      return;
    }
    const previousDistance = samplingDistance;
    const zoom = map.getZoom();
    const newDistance = computeSamplingDistanceForZoom(zoom);
    if (!Number.isFinite(newDistance)) return;
    samplingDistance = newDistance;
    const changed = Math.abs(newDistance - previousDistance) > 0.01;
    if (forceInvalidate || changed) {
      gradientPreparer.invalidateAll();
    }
    if (changed || forceInvalidate) {
      refreshGradientUI();
    }
  }

  /**
   * MapLibre GL JS 5.11.0 ships a Mercator transform helper that throws a
   * "Not implemented" error when `getRayDirectionFromPixel` is invoked.
   * Some of the built-in controls (navigation, terrain and globe controls)
   * rely on this method being available which causes the render loop to crash
   * as soon as it is accessed. The CDN build we consume does not yet include
   * the fix, therefore we patch the prototype at runtime with a small helper
   * that reconstructs the ray direction using the inverse pixel matrix.
   *
   * The implementation mirrors the behaviour of the upstream method by
   * unprojecting the provided pixel against the near and far clip planes and
   * normalising the resulting vector.
   */
  (function patchGetRayDirectionFromPixel() {
    if (!window.maplibregl) return;

    const multiplyMat4Vec4 = (m, v) => {
      const [x, y, z, w] = v;
      return [
        m[0] * x + m[4] * y + m[8] * z + m[12] * w,
        m[1] * x + m[5] * y + m[9] * z + m[13] * w,
        m[2] * x + m[6] * y + m[10] * z + m[14] * w,
        m[3] * x + m[7] * y + m[11] * z + m[15] * w
      ];
    };

    const normalise = (vec) => {
      const length = Math.hypot(vec[0], vec[1], vec[2]);
      if (length === 0) return [0, 0, -1];
      return [vec[0] / length, vec[1] / length, vec[2] / length];
    };

    const resolvePointLike = (pointLike) => {
      if (Array.isArray(pointLike)) {
        return {x: pointLike[0], y: pointLike[1]};
      }
      if (pointLike && typeof pointLike === 'object') {
        if ('x' in pointLike && 'y' in pointLike) {
          return {x: Number(pointLike.x), y: Number(pointLike.y)};
        }
        if ('lng' in pointLike && 'lat' in pointLike) {
          // MapLibre occasionally passes a Point class instance which exposes
          // `lng`/`lat`. Treat it as pixel coordinates to avoid throwing.
          return {x: Number(pointLike.lng), y: Number(pointLike.lat)};
        }
      }
      return {x: 0, y: 0};
    };

    const patchPrototype = (prototype) => {
      if (!prototype) return;
      const original = prototype.getRayDirectionFromPixel;
      const needsPatch = !original || /Not implemented/.test(String(original));
      if (!needsPatch) return;

      prototype.getRayDirectionFromPixel = function(pointLike, coordinateOrigin = 'viewport') {
        const point = resolvePointLike(pointLike);
        const width = this.width || 0;
        const height = this.height || 0;

        if (!width || !height) {
          return new Float32Array([0, 0, -1]);
        }

        let x = point.x;
        let y = point.y;
        if (coordinateOrigin === 'center') {
          x += width / 2;
          y += height / 2;
        }

        if (!this.pixelMatrixInverse) {
          if (typeof this._calcMatrices === 'function') {
            this._calcMatrices();
          }
          if (!this.pixelMatrixInverse) {
            return new Float32Array([0, 0, -1]);
          }
        }

        const inv = this.pixelMatrixInverse;
        const near = multiplyMat4Vec4(inv, [x, y, 0, 1]);
        const far = multiplyMat4Vec4(inv, [x, y, 1, 1]);

        const nearW = near[3] || 1;
        const farW = far[3] || 1;
        const nearPoint = [near[0] / nearW, near[1] / nearW, near[2] / nearW];
        const farPoint = [far[0] / farW, far[1] / farW, far[2] / farW];

        const direction = [
          farPoint[0] - nearPoint[0],
          farPoint[1] - nearPoint[1],
          farPoint[2] - nearPoint[2]
        ];

        const normalised = normalise(direction);
        return new Float32Array(normalised);
      };
    };

    patchPrototype(window.maplibregl?.Transform?.prototype);
    patchPrototype(window.maplibregl?.MercatorTransform?.prototype);
  })();
  const MAX_NEIGHBOR_OFFSET = 2;
  const NEIGHBOR_NAME_OVERRIDES = {
    '-1,0': 'u_image_left',
    '1,0': 'u_image_right',
    '0,-1': 'u_image_top',
    '0,1': 'u_image_bottom',
    '-1,-1': 'u_image_topLeft',
    '1,-1': 'u_image_topRight',
    '-1,1': 'u_image_bottomLeft',
    '1,1': 'u_image_bottomRight'
  };

  function formatOffsetPart(value) {
    if (value === 0) {
      return '0';
    }
    const prefix = value < 0 ? 'm' : 'p';
    return `${prefix}${Math.abs(value)}`;
  }

  function getUniformNameForOffset(dx, dy) {
    const key = `${dx},${dy}`;
    if (NEIGHBOR_NAME_OVERRIDES[key]) {
      return NEIGHBOR_NAME_OVERRIDES[key];
    }
    return `u_image_${formatOffsetPart(dx)}_${formatOffsetPart(dy)}`;
  }

  function getMetersUniformNameForOffset(dx, dy) {
    const base = getUniformNameForOffset(dx, dy);
    return base.replace('u_image', 'u_metersPerPixel');
  }

  function generateNeighborOffsets(maxOffset) {
    const offsets = [];
    for (let dy = -maxOffset; dy <= maxOffset; dy++) {
      for (let dx = -maxOffset; dx <= maxOffset; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (Math.abs(dx) + Math.abs(dy) > maxOffset) continue;
        offsets.push({
          dx,
          dy,
          uniform: getUniformNameForOffset(dx, dy),
          metersUniform: getMetersUniformNameForOffset(dx, dy)
        });
      }
    }
    return offsets;
  }

  const NEIGHBOR_OFFSETS = generateNeighborOffsets(MAX_NEIGHBOR_OFFSET);

  function getTileCacheKey(tileID) {
    if (!tileID || !tileID.canonical) return '';
    const canonical = tileID.canonical;
    return `${canonical.z}/${tileID.wrap}/${canonical.x}/${canonical.y}`;
  }

  function getNeighborCacheKey(tileID, dx, dy) {
    if (!tileID || !tileID.canonical) return null;
    const canonical = tileID.canonical;
    const dim = Math.pow(2, canonical.z);

    let nx = canonical.x + dx;
    let ny = canonical.y + dy;
    let wrap = tileID.wrap;

    if (ny < 0 || ny >= dim) {
      return null;
    }

    if (nx < 0) {
      nx += dim;
      wrap -= 1;
    } else if (nx >= dim) {
      nx -= dim;
      wrap += 1;
    }

    return `${canonical.z}/${wrap}/${nx}/${ny}`;
  }

  function getShadowDateTime() {
    const now = new Date();
    const dateStr = shadowDateValue || now.toISOString().slice(0, 10);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const storedMinutes = isoTimeToMinutes(shadowTimeValue);
    const minutes = storedMinutes !== null ? storedMinutes : nowMinutes;
    const clampedMinutes = clamp(minutes, shadowTimeBounds.min, shadowTimeBounds.max);
    const timeStr = minutesToIsoTime(clampedMinutes);
    return new Date(`${dateStr}T${timeStr}:00`);
  }

  function initializeShadowDateTimeControls() {
    const now = new Date();
    const currentYear = now.getFullYear();
    const startOfYear = new Date(currentYear, 0, 1);
    const isLeapYear = new Date(currentYear, 1, 29).getMonth() === 1;
    const totalDays = isLeapYear ? 366 : 365;
    const defaultDayIndex = Math.min(
      Math.floor((now - startOfYear) / (24 * 60 * 60 * 1000)),
      totalDays - 1
    );
    const defaultMinutes = now.getHours() * 60 + now.getMinutes();

    const dateSlider = document.getElementById('shadowDateSlider');
    const dateValue = document.getElementById('shadowDateValue');
    const timeSlider = document.getElementById('shadowTimeSlider');
    const timeValue = document.getElementById('shadowTimeValue');
    const dateFromDayIndex = (dayIndex) => {
      const baseDate = new Date(currentYear, 0, 1);
      baseDate.setDate(baseDate.getDate() + Number(dayIndex));
      return baseDate;
    };

    const setTimeFromSlider = (totalMinutes) => {
      const minutes = clamp(Number(totalMinutes), shadowTimeBounds.min, shadowTimeBounds.max);
      const isoTime = minutesToIsoTime(minutes);
      shadowTimeValue = isoTime;
      if (timeSlider && Number(timeSlider.value) !== minutes) {
        timeSlider.value = minutes;
      }
      if (timeValue) timeValue.textContent = isoTime;
      if (map && (isModeActive('shadow') || isModeActive('daylight'))) map.triggerRepaint();
    };

    const updateShadowTimeBounds = (preferredMinutes = null) => {
      const center = map ? map.getCenter() : { lat: 0, lng: 0 };
      const isoDate = shadowDateValue;
      const targetDate = isoDate
        ? (() => {
            const [yearStr, monthStr, dayStr] = isoDate.split('-');
            return new Date(Number(yearStr), Number(monthStr) - 1, Number(dayStr));
          })()
        : dateFromDayIndex(defaultDayIndex);

      const times = SunCalc.getTimes(targetDate, center.lat, center.lng);
      const sunriseMinutes = times.sunrise instanceof Date
        ? times.sunrise.getHours() * 60 + times.sunrise.getMinutes()
        : null;
      const sunsetMinutes = times.sunset instanceof Date
        ? times.sunset.getHours() * 60 + times.sunset.getMinutes()
        : null;

      let minMinutes = sunriseMinutes !== null && Number.isFinite(sunriseMinutes)
        ? clamp(Math.round(sunriseMinutes) - SHADOW_BUFFER_MINUTES, 0, 1439)
        : DEFAULT_DAYLIGHT_BOUNDS.min;
      let maxMinutes = sunsetMinutes !== null && Number.isFinite(sunsetMinutes)
        ? clamp(Math.round(sunsetMinutes) + SHADOW_BUFFER_MINUTES, 0, 1439)
        : DEFAULT_DAYLIGHT_BOUNDS.max;

      if (maxMinutes <= minMinutes) {
        minMinutes = DEFAULT_DAYLIGHT_BOUNDS.min;
        maxMinutes = DEFAULT_DAYLIGHT_BOUNDS.max;
      }

      shadowTimeBounds = { min: minMinutes, max: maxMinutes };

      if (timeSlider) {
        timeSlider.min = minMinutes;
        timeSlider.max = maxMinutes;
        timeSlider.step = 1;
      }

      const storedMinutes = isoTimeToMinutes(shadowTimeValue);
      const desiredMinutes = preferredMinutes !== null
        ? preferredMinutes
        : (storedMinutes !== null ? storedMinutes : defaultMinutes);

      setTimeFromSlider(clamp(desiredMinutes, shadowTimeBounds.min, shadowTimeBounds.max));
    };

    recomputeShadowTimeBounds = (preferredMinutes) => updateShadowTimeBounds(preferredMinutes);

    const setDateFromSlider = (dayIndex) => {
      const baseDate = dateFromDayIndex(dayIndex);
      const isoDate = `${baseDate.getFullYear()}-${String(baseDate.getMonth() + 1).padStart(2, '0')}-${String(baseDate.getDate()).padStart(2, '0')}`;
      shadowDateValue = isoDate;
      if (dateValue) dateValue.textContent = isoDate;
      updateShadowTimeBounds();
      if (map && (isModeActive('shadow') || isModeActive('daylight'))) map.triggerRepaint();
    };

    if (dateSlider) {
      dateSlider.max = totalDays - 1;
      dateSlider.value = defaultDayIndex;
      setDateFromSlider(Number(defaultDayIndex));
      dateSlider.addEventListener('input', (e) => {
        setDateFromSlider(e.target.value);
      });
    }

    if (timeSlider) {
      const roundedMinutes = Math.round(defaultMinutes);
      timeSlider.value = roundedMinutes;
      timeSlider.step = 1;
      updateShadowTimeBounds(roundedMinutes);
      timeSlider.addEventListener('input', (e) => {
        const minutes = clamp(Number(e.target.value), shadowTimeBounds.min, shadowTimeBounds.max);
        if (minutes !== Number(e.target.value)) {
          e.target.value = minutes;
        }
        setTimeFromSlider(minutes);
      });
    } else {
      updateShadowTimeBounds();
    }
  }

  function smoothstep(edge0, edge1, x) {
    if (edge0 === edge1) {
      return x < edge0 ? 0 : 1;
    }
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function colorTemperatureToRgb(cct) {
    const temperature = cct / 100;
    let red;
    let green;
    let blue;

    const safeTemp = Math.max(temperature, 1e-3);
    if (temperature <= 66) {
      red = 255;
      green = 99.4708025861 * Math.log(safeTemp) - 161.1195681661;
    } else {
      const t = temperature - 60;
      const safeT = Math.max(t, 1e-3);
      red = 329.698727446 * Math.pow(safeT, -0.1332047592);
      green = 288.1221695283 * Math.pow(safeT, -0.0755148492);
    }

    if (temperature >= 66) {
      blue = 255;
    } else if (temperature <= 19) {
      blue = 0;
    } else {
      const safeBlueT = Math.max(temperature - 10, 1e-3);
      blue = 138.5177312231 * Math.log(safeBlueT) - 305.0447927307;
    }

    const clamp255 = (value) => clamp(Math.round(value), 0, 255) / 255;
    return [clamp255(red), clamp255(green), clamp255(blue)];
  }

  function computeSunParameters(mapInstance) {
    const center = mapInstance.getCenter();
    const sunDate = getShadowDateTime();
    const sunPos = SunCalc.getPosition(sunDate, center.lat, center.lng);
    const azimuth = sunPos.azimuth;
    const altitude = sunPos.altitude;
    const dirX = -Math.sin(azimuth);
    const dirY = -Math.cos(azimuth);
    const minAltitude = -1 * (Math.PI / 180); // approximately -1 degree
    const clampedAltitude = Math.max(altitude, minAltitude);
    const sunSlope = Math.tan(clampedAltitude);
    const times = SunCalc.getTimes(sunDate, center.lat, center.lng);
    const toMillis = (date) => (date instanceof Date ? date.getTime() : null);
    const nowMs = sunDate.getTime();
    const warmWindowMs = 90 * 60 * 1000; // 90 minutes window around sunrise/sunset
    const sunriseMs = toMillis(times.sunrise);
    const sunsetMs = toMillis(times.sunset);
    const sunriseIntensity = sunriseMs
      ? Math.max(0, 1 - Math.abs(nowMs - sunriseMs) / warmWindowMs)
      : 0;
    const sunsetIntensity = sunsetMs
      ? Math.max(0, 1 - Math.abs(nowMs - sunsetMs) / warmWindowMs)
      : 0;
    const altitudeDeg = altitude * (180 / Math.PI);
    const smoothFactor = smoothstep(-6, 15, altitudeDeg);
    const cct = 2000 * (1 - smoothFactor) + 6500 * smoothFactor;
    const warmColor = colorTemperatureToRgb(cct);

    let warmIntensity = 0;
    if (altitude > 0) {
      const sinAltitude = Math.sin(altitude);
      const opticalAirMass = 1 / Math.max(0.1, sinAltitude);
      const transmittance = Math.exp(-0.25 * opticalAirMass);
      const sunriseBoost = Math.max(sunriseIntensity, sunsetIntensity);
      warmIntensity = clamp(1 - transmittance + sunriseBoost * 0.25, 0, 1);
    }

    return { dirX, dirY, altitude, sunSlope, warmColor, warmIntensity, azimuth };
  }

  const MINIMUM_TERRAIN_FRAME_DELTA_METERS = 30;

  let cachedTerrainInterface = null;

  function clampTerrainMeshFrameDelta(terrainInterface) {
    if (!terrainInterface || typeof terrainInterface.getMeshFrameDelta !== 'function') {
      return;
    }
    if (terrainInterface.__minFrameDeltaClampApplied) {
      return;
    }
    const originalGetMeshFrameDelta = terrainInterface.getMeshFrameDelta.bind(terrainInterface);
    terrainInterface.getMeshFrameDelta = function patchedGetMeshFrameDelta(zoom) {
      const baseDelta = originalGetMeshFrameDelta(zoom);
      if (!Number.isFinite(baseDelta)) {
        return baseDelta;
      }
      return Math.max(baseDelta, MINIMUM_TERRAIN_FRAME_DELTA_METERS);
    };
    terrainInterface.__minFrameDeltaClampApplied = true;
  }

  function getTerrainInterface(mapInstance) {
    if (!mapInstance) {
      return cachedTerrainInterface && cachedTerrainInterface.tileManager
        ? cachedTerrainInterface
        : null;
    }

    const fromPublicAPI = mapInstance.terrain;
    if (fromPublicAPI && fromPublicAPI.tileManager) {
      cachedTerrainInterface = fromPublicAPI;
      clampTerrainMeshFrameDelta(cachedTerrainInterface);
      return fromPublicAPI;
    }

    const painterTerrain = mapInstance.painter && mapInstance.painter.terrain;
    if (painterTerrain && painterTerrain.tileManager) {
      cachedTerrainInterface = painterTerrain;
      clampTerrainMeshFrameDelta(cachedTerrainInterface);
      return painterTerrain;
    }

    const hasTerrain = Boolean(mapInstance.terrain || (mapInstance.painter && mapInstance.painter.terrain));
    if (!hasTerrain) {
      if (isTerrainFlattened && cachedTerrainInterface && cachedTerrainInterface.tileManager) {
        return cachedTerrainInterface;
      }
      cachedTerrainInterface = null;
      return null;
    }

    if (cachedTerrainInterface && !cachedTerrainInterface.tileManager) {
      cachedTerrainInterface = null;
      return null;
    }

    if (cachedTerrainInterface && cachedTerrainInterface.tileManager) {
      clampTerrainMeshFrameDelta(cachedTerrainInterface);
      return cachedTerrainInterface;
    }
    return null;
  }

  function getTerrainTileManager(mapInstance) {
    const terrainInterface = getTerrainInterface(mapInstance);
    return terrainInterface ? terrainInterface.tileManager || null : null;
  }

  // Update UI button states and slider visibility based on current mode
  function updateButtons() {
    const isCustomActive = hillshadeMode === 'custom';
    const hillShadeNativeBtn = document.getElementById('hillShadeNativeBtn');
    if (hillShadeNativeBtn) {
      hillShadeNativeBtn.classList.toggle('active', hillshadeMode === 'native');
    }
    const hillShadeCustomBtn = document.getElementById('hillShadeCustomBtn');
    if (hillShadeCustomBtn) {
      hillShadeCustomBtn.classList.toggle('active', isCustomActive && isModeActive('hillshade'));
    }
    const normalBtn = document.getElementById('normalBtn');
    if (normalBtn) {
      normalBtn.classList.toggle('active', isCustomActive && isModeActive('normal'));
    }
    const avalancheBtn = document.getElementById('avalancheBtn');
    if (avalancheBtn) {
      avalancheBtn.classList.toggle('active', isCustomActive && isModeActive('avalanche'));
    }
    const slopeBtn = document.getElementById('slopeBtn');
    if (slopeBtn) {
      slopeBtn.classList.toggle('active', isCustomActive && isModeActive('slope'));
    }
    const aspectBtn = document.getElementById('aspectBtn');
    if (aspectBtn) {
      aspectBtn.classList.toggle('active', isCustomActive && isModeActive('aspect'));
    }
    const snowBtn = document.getElementById('snowBtn');
    if (snowBtn) {
      snowBtn.classList.toggle('active', isCustomActive && isModeActive('snow'));
    }
    const shadowBtn = document.getElementById('shadowBtn');
    if (shadowBtn) {
      shadowBtn.classList.toggle('active', isCustomActive && isModeActive('shadow'));
    }
    const daylightBtn = document.getElementById('daylightBtn');
    if (daylightBtn) {
      daylightBtn.classList.toggle('active', isCustomActive && isModeActive('daylight'));
    }
    if (!terrainDebugBtn) {
      terrainDebugBtn = document.getElementById('terrainDebugBtn');
    }
    if (terrainDebugBtn) {
      terrainDebugBtn.classList.toggle('active', terrainDebugEnabled);
    }
    if (!terrainMeshBtn) {
      terrainMeshBtn = document.getElementById('terrainMeshBtn');
    }
    if (terrainMeshBtn) {
      terrainMeshBtn.classList.toggle('active', terrainWireframeLayerVisible);
    }
    if (!terrainMenuContainer) {
      terrainMenuContainer = document.getElementById('terrainMenu');
    }
    if (terrainMenuContainer) {
      terrainMenuContainer.style.display = terrainWireframeLayerVisible ? 'flex' : 'none';
    }
    updateTerrainExportButtonState();
    if (!terrainStatusEl) {
      terrainStatusEl = document.getElementById('terrainStatus');
    }
    const snowSliderContainer = document.getElementById('snowSliderContainer');
    if (snowSliderContainer) {
      snowSliderContainer.style.display = (isCustomActive && isModeActive('snow')) ? "flex" : "none";
    }
    const shadowControls = document.getElementById('shadowControls');
    if (shadowControls) {
      shadowControls.style.display = (isCustomActive && (isModeActive('shadow') || isModeActive('daylight'))) ? "flex" : "none";
    }
    refreshDebugPanel();
  }
  
  // Slider event listeners
  document.getElementById('snowAltitudeSlider').addEventListener('input', (e) => {
    snowAltitude = parseFloat(e.target.value);
    document.getElementById('snowAltitudeValue').textContent = e.target.value;
    if (map && isModeActive('snow')) map.triggerRepaint();
  });
  document.getElementById('snowSlopeSlider').addEventListener('input', (e) => {
    snowMaxSlope = parseFloat(e.target.value);
    document.getElementById('snowSlopeValue').textContent = e.target.value;
    if (map && isModeActive('snow')) map.triggerRepaint();
  });
  const snowBlurSlider = document.getElementById('snowBlurSlider');
  const snowBlurValueEl = document.getElementById('snowBlurValue');
  if (snowBlurValueEl) {
    snowBlurValueEl.textContent = snowBlurAmount.toFixed(2);
  }
  if (snowBlurSlider) {
    snowBlurSlider.value = snowBlurAmount.toString();
    snowBlurSlider.addEventListener('input', (e) => {
      snowBlurAmount = parseFloat(e.target.value);
      if (snowBlurValueEl) {
        snowBlurValueEl.textContent = snowBlurAmount.toFixed(2);
      }
      if (map && isModeActive('snow')) map.triggerRepaint();
    });
  }

  gradientSamplingSlider = document.getElementById('gradientSamplingSlider');
  gradientSamplingValueEl = document.getElementById('gradientSamplingValue');
  gradientBaseSlider = document.getElementById('gradientBaseSlider');
  gradientBaseValueEl = document.getElementById('gradientBaseValue');
  gradientMinSlider = document.getElementById('gradientMinSlider');
  gradientMinValueEl = document.getElementById('gradientMinValue');
  gradientMaxSlider = document.getElementById('gradientMaxSlider');
  gradientMaxValueEl = document.getElementById('gradientMaxValue');
  gradientAutoButton = document.getElementById('gradientAutoButton');
  gradientAutoScaleSelect = document.getElementById('gradientAutoScaleSelect');
  terrainMeshBtn = document.getElementById('terrainMeshBtn');
  terrainExportBtn = document.getElementById('terrainExportBtn');
  terrainDebugBtn = document.getElementById('terrainDebugBtn');
  terrainMenuContainer = document.getElementById('terrainMenu');
  terrainStatusEl = document.getElementById('terrainStatus');
  layersPanelEl = document.getElementById('layersPanel');
  layersToggleButton = document.getElementById('layersToggle');
  layersCloseButton = document.getElementById('layersClose');
  hqModeCheckbox = document.getElementById('hqMode');
  toggle3DButton = document.getElementById('toggle3D');

  if (gradientAutoScaleSelect) {
    gradientAutoScaleSelect.value = gradientAutoScaleKey;
  }

  function setLayersPanelVisibility(visible) {
    if (!layersPanelEl) {
      layersPanelOpen = false;
      return;
    }
    layersPanelOpen = Boolean(visible);
    layersPanelEl.classList.toggle('open', layersPanelOpen);
    layersPanelEl.setAttribute('aria-hidden', layersPanelOpen ? 'false' : 'true');
    if (layersToggleButton) {
      layersToggleButton.classList.toggle('active', layersPanelOpen);
      layersToggleButton.setAttribute('aria-expanded', layersPanelOpen ? 'true' : 'false');
    }
  }

  setLayersPanelVisibility(false);

  if (layersToggleButton) {
    layersToggleButton.addEventListener('click', () => {
      setLayersPanelVisibility(!layersPanelOpen);
    });
  }

  if (layersCloseButton) {
    layersCloseButton.addEventListener('click', () => {
      setLayersPanelVisibility(false);
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && layersPanelOpen) {
      setLayersPanelVisibility(false);
    }
  });

  function stopTerrainAnimation() {
    if (terrainAnimationFrameId != null) {
      cancelAnimationFrame(terrainAnimationFrameId);
      terrainAnimationFrameId = null;
    }
  }

  function setTerrainExaggerationImmediate(exaggeration) {
    if (!map) {
      return;
    }
    try {
      map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration });
    } catch (error) {
      if (terrainDebugEnabled) {
        console.warn('Failed to update terrain exaggeration', error);
      }
    }
  }

  function animateTerrainExaggeration(targetExaggeration, duration = 1500) {
    if (!map) {
      return;
    }
    stopTerrainAnimation();
    const startExaggeration = currentTerrainExaggeration;
    const startTime = performance.now();
    const ease = (t) => 0.5 * (1 - Math.cos(Math.PI * t));

    function step(now) {
      const progress = duration <= 0 ? 1 : Math.min(1, (now - startTime) / duration);
      const eased = ease(progress);
      const value = startExaggeration + (targetExaggeration - startExaggeration) * eased;
      setTerrainExaggerationImmediate(value);
      if (progress < 1) {
        terrainAnimationFrameId = requestAnimationFrame(step);
      } else {
        terrainAnimationFrameId = null;
      }
    }

    terrainAnimationFrameId = requestAnimationFrame(step);
  }

  function applyHQModeToSources() {
    if (!map || typeof map.setSourceTileLodParams !== 'function') {
      return;
    }
    const minLod = hqModeCheckbox && hqModeCheckbox.checked ? 3 : 4;
    const maxLod = hqModeCheckbox && hqModeCheckbox.checked ? 9 : 6;
    const sourceIds = [TERRAIN_SOURCE_ID];
    for (const sourceId of sourceIds) {
      if (!map.getSource(sourceId)) {
        continue;
      }
      try {
        map.setSourceTileLodParams(minLod, maxLod, sourceId);
      } catch (error) {
        if (terrainDebugEnabled) {
          console.warn(`Failed to adjust LOD params for ${sourceId}`, error);
        }
      }
    }
  }

  function enter3DView() {
    if (!map) {
      return;
    }
    stopTerrainAnimation();
    if (typeof map.stop === 'function') {
      map.stop();
    }
    animateTerrainExaggeration(TERRAIN_DEFAULT_EXAGGERATION, 2000);
    map.easeTo({ pitch: 45, bearing: 0, duration: 1500 });
    is3DViewEnabled = true;
    if (toggle3DButton) {
      toggle3DButton.textContent = 'Revenir en 2D';
    }
  }

  function enter2DView() {
    if (!map) {
      return;
    }
    stopTerrainAnimation();
    if (typeof map.stop === 'function') {
      map.stop();
    }
    animateTerrainExaggeration(TERRAIN_FLATTEN_EXAGGERATION, 1500);
    map.easeTo({ pitch: 0, bearing: 0, duration: 1200 });
    is3DViewEnabled = false;
    if (toggle3DButton) {
      toggle3DButton.textContent = 'Passer en 3D';
    }
  }

  if (hqModeCheckbox) {
    hqModeCheckbox.addEventListener('change', () => {
      applyHQModeToSources();
    });
  }

  if (toggle3DButton) {
    toggle3DButton.addEventListener('click', () => {
      if (is3DViewEnabled) {
        enter2DView();
      } else {
        enter3DView();
      }
    });
  }

  const debugPanelEl = document.getElementById('debugPanel');
  const debugContentEl = document.getElementById('debugContent');
  const debugState = {
    lastRender: null
  };

  function publishRenderDebugInfo(info) {
    if (info) {
      debugState.lastRender = { ...info, timestamp: Date.now() };
    } else {
      debugState.lastRender = null;
    }
    refreshDebugPanel();
  }

  function refreshDebugPanel() {
    if (!debugContentEl) {
      return;
    }

    const lines = [];
    const modeLabel = (() => {
      if (hillshadeMode === 'custom') {
        const active = getActiveModesInOrder();
        const label = active.length ? active.join('+') : (currentMode || 'idle');
        return `custom/${label}`;
      }
      if (hillshadeMode === 'native') {
        return 'native hillshade';
      }
      return hillshadeMode || 'none';
    })();

    lines.push(`Mode: ${modeLabel}`);
    if (hillshadeMode === 'custom') {
      const activeModes = getActiveModesInOrder();
      lines.push(`Active custom modes: ${activeModes.length ? activeModes.join(', ') : 'none'}`);
    }
    lines.push(`Terrain debug logging: ${terrainDebugEnabled ? 'enabled' : 'disabled'}`);

    if (map) {
      const zoom = Number.isFinite(map.getZoom()) ? map.getZoom().toFixed(2) : 'n/a';
      const pitch = Number.isFinite(map.getPitch()) ? map.getPitch().toFixed(1) : 'n/a';
      const bearing = Number.isFinite(map.getBearing()) ? map.getBearing().toFixed(1) : 'n/a';
      lines.push(`View: zoom ${zoom}, pitch ${pitch}, bearing ${bearing}`);

      const terrainSpec = typeof map.getTerrain === 'function' ? map.getTerrain() : null;
      const exaggeration = terrainSpec && Number.isFinite(terrainSpec.exaggeration)
        ? terrainSpec.exaggeration
        : (Number.isFinite(lastTerrainSpecification?.exaggeration) ? lastTerrainSpecification.exaggeration : null);
      if (Number.isFinite(exaggeration)) {
        lines.push(`Terrain exaggeration: ${exaggeration.toFixed(3)}`);
      }

      const tileManager = getTerrainTileManager(map);
      if (tileManager && typeof tileManager.getRenderableTiles === 'function') {
        try {
          const tiles = tileManager.getRenderableTiles();
          const tileCount = Array.isArray(tiles) ? tiles.length : 0;
          lines.push(`Renderable tiles (current): ${tileCount}`);
        } catch (error) {
          lines.push('Renderable tiles (current): unavailable');
        }
      }
    }

    const lastRender = debugState.lastRender;
    const samplingCandidate = lastRender && Number.isFinite(lastRender.samplingDistance)
      ? lastRender.samplingDistance
      : samplingDistance;
    const samplingLabel = Number.isFinite(samplingCandidate)
      ? formatGradientDistanceLabel(samplingCandidate)
      : 'n/a';
    const samplingMode = lastRender && typeof lastRender.isSamplingDistanceManual === 'boolean'
      ? (lastRender.isSamplingDistanceManual ? 'manual' : 'auto')
      : (isSamplingDistanceManual ? 'manual' : 'auto');
    lines.push(`Gradient sampling: ${samplingLabel} (${samplingMode})`);
    lines.push(`Auto sampling scale: ${formatAutoSamplingScaleLabel(gradientAutoScale)}`);

    const meshStateLabel = terrainWireframeLayerVisible
      ? (terrainWireframeLoading ? 'visible (building)' : 'visible')
      : 'hidden';
    lines.push(`Three.js mesh: ${meshStateLabel}`);

    if (lastRender && lastRender.debugMetrics) {
      const metrics = lastRender.debugMetrics;
      const drawn = Number.isFinite(metrics.drawnTiles) ? metrics.drawnTiles : 0;
      const total = Number.isFinite(metrics.totalTiles) ? metrics.totalTiles : (Number.isFinite(lastRender.renderableTileCount) ? lastRender.renderableTileCount : 0);
      const skipped = Number.isFinite(metrics.skippedTiles) ? metrics.skippedTiles : 0;
      const passes = Number.isFinite(metrics.passes) ? metrics.passes : 0;
      lines.push(`Custom tiles (last frame): drawn ${drawn}/${total}, skipped ${skipped}, passes ${passes}`);
      if (lastRender.neighborSamplingActive) {
        lines.push('Neighbor sampling: active');
      } else {
        lines.push('Neighbor sampling: inactive');
      }
      if (Number.isFinite(lastRender.terrainDataCount)) {
        lines.push(`Terrain textures cached: ${lastRender.terrainDataCount}`);
      }
      if (Number.isFinite(lastRender.textureCacheCount)) {
        lines.push(`Neighbor texture cache entries: ${lastRender.textureCacheCount}`);
      }
      if (Number.isFinite(lastRender.nativeGradientTiles)) {
        lines.push(`Native gradient textures: ${lastRender.nativeGradientTiles}`);
      }
    }

    const gradientInfo = lastRender?.gradientDebug
      || (typeof gradientPreparer.getDebugInfo === 'function' ? gradientPreparer.getDebugInfo() : null);
    if (gradientInfo) {
      const gradientMode = gradientInfo.supported ? 'precomputed textures' : 'runtime fallback';
      lines.push(`Gradient pipeline: ${gradientMode}`);
      if (!gradientInfo.supported && gradientInfo.unsupportedReason) {
        lines.push(`Gradient fallback reason: ${gradientInfo.unsupportedReason}`);
      }
      if (Number.isFinite(gradientInfo.tileStateCount)) {
        lines.push(`Gradient tile cache: ${gradientInfo.tileStateCount}`);
      }
      const frameInfo = gradientInfo.lastFrameInfo;
      if (frameInfo) {
        const prepared = Number.isFinite(frameInfo.preparedTiles) ? frameInfo.preparedTiles : 0;
        const reused = Number.isFinite(frameInfo.reusedTiles) ? frameInfo.reusedTiles : 0;
        const discarded = Number.isFinite(frameInfo.discardedTiles) ? frameInfo.discardedTiles : 0;
        lines.push(`Gradient tiles prepared/reused: ${prepared}/${reused}, discarded ${discarded}`);
        const neighborMatches = Number.isFinite(frameInfo.neighborMatches) ? frameInfo.neighborMatches : 0;
        const neighborFallbacks = Number.isFinite(frameInfo.neighborFallbacks) ? frameInfo.neighborFallbacks : 0;
        lines.push(`Gradient neighbor fetch: ok ${neighborMatches}, fallback ${neighborFallbacks}`);
      }
    }

    if (debugPanelEl) {
      debugPanelEl.style.display = lines.length ? 'block' : 'none';
    }
    debugContentEl.textContent = lines.join('\n');
  }

  function refreshGradientUI() {
    sanitizeGradientParameters();
    if (gradientSamplingSlider) {
      gradientSamplingSlider.step = formatGradientDistance(MIN_GRADIENT_DISTANCE);
      gradientSamplingSlider.min = formatGradientDistance(gradientParameters.minDistance);
      gradientSamplingSlider.max = formatGradientDistance(gradientParameters.maxDistance);
      if (document.activeElement !== gradientSamplingSlider) {
        gradientSamplingSlider.value = formatGradientDistance(samplingDistance);
      }
    }
    if (gradientSamplingValueEl) {
      const modeLabel = isSamplingDistanceManual ? 'manual' : 'auto';
      gradientSamplingValueEl.textContent = `${formatGradientDistance(samplingDistance)} m (${modeLabel})`;
    }
    if (gradientBaseSlider) {
      gradientBaseSlider.step = formatGradientDistance(MIN_GRADIENT_DISTANCE);
      gradientBaseSlider.min = formatGradientDistance(gradientParameters.minDistance);
      gradientBaseSlider.max = formatGradientDistance(gradientParameters.maxDistance);
      if (document.activeElement !== gradientBaseSlider) {
        gradientBaseSlider.value = formatGradientDistance(gradientParameters.baseDistance);
      }
    }
    if (gradientBaseValueEl) {
      gradientBaseValueEl.textContent = formatGradientDistanceLabel(gradientParameters.baseDistance);
    }
    if (gradientMinSlider) {
      gradientMinSlider.step = formatGradientDistance(MIN_GRADIENT_DISTANCE);
      gradientMinSlider.min = formatGradientDistance(MIN_GRADIENT_DISTANCE);
      gradientMinSlider.max = formatGradientDistance(gradientParameters.maxDistance);
      if (document.activeElement !== gradientMinSlider) {
        gradientMinSlider.value = formatGradientDistance(gradientParameters.minDistance);
      }
    }
    if (gradientMinValueEl) {
      gradientMinValueEl.textContent = formatGradientDistanceLabel(gradientParameters.minDistance);
    }
    if (gradientMaxSlider) {
      gradientMaxSlider.step = formatGradientDistance(MIN_GRADIENT_DISTANCE);
      gradientMaxSlider.min = formatGradientDistance(gradientParameters.minDistance);
      if (document.activeElement !== gradientMaxSlider) {
        gradientMaxSlider.value = formatGradientDistance(gradientParameters.maxDistance);
      }
    }
    if (gradientMaxValueEl) {
      gradientMaxValueEl.textContent = formatGradientDistanceLabel(gradientParameters.maxDistance);
    }
    if (gradientAutoButton) {
      gradientAutoButton.disabled = !isSamplingDistanceManual;
    }
    if (gradientAutoScaleSelect && gradientAutoScaleSelect.value !== gradientAutoScaleKey) {
      gradientAutoScaleSelect.value = gradientAutoScaleKey;
    }
    refreshDebugPanel();
  }

  sanitizeGradientParameters();
  clampSamplingDistanceToRange();
  refreshGradientUI();

  if (gradientSamplingSlider) {
    gradientSamplingSlider.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      if (!Number.isFinite(value)) return;
      sanitizeGradientParameters();
      samplingDistance = clamp(value, gradientParameters.minDistance, gradientParameters.maxDistance);
      isSamplingDistanceManual = true;
      gradientPreparer.invalidateAll();
      refreshGradientUI();
      if (map) map.triggerRepaint();
    });
  }

  if (gradientBaseSlider) {
    gradientBaseSlider.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      if (!Number.isFinite(value)) return;
      gradientParameters.baseDistance = value;
      sanitizeGradientParameters();
      if (isSamplingDistanceManual) {
        clampSamplingDistanceToRange();
      } else {
        const zoom = map ? map.getZoom() : undefined;
        const newDistance = computeSamplingDistanceForZoom(zoom);
        if (Number.isFinite(newDistance)) {
          samplingDistance = newDistance;
        }
      }
      gradientPreparer.invalidateAll();
      refreshGradientUI();
      if (map) map.triggerRepaint();
    });
  }

  if (gradientMinSlider) {
    gradientMinSlider.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      if (!Number.isFinite(value)) return;
      gradientParameters.minDistance = value;
      sanitizeGradientParameters();
      if (isSamplingDistanceManual) {
        clampSamplingDistanceToRange();
      } else {
        const zoom = map ? map.getZoom() : undefined;
        const newDistance = computeSamplingDistanceForZoom(zoom);
        if (Number.isFinite(newDistance)) {
          samplingDistance = newDistance;
        }
      }
      gradientPreparer.invalidateAll();
      refreshGradientUI();
      if (map) map.triggerRepaint();
    });
  }

  if (gradientMaxSlider) {
    gradientMaxSlider.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      if (!Number.isFinite(value)) return;
      gradientParameters.maxDistance = value;
      sanitizeGradientParameters();
      if (isSamplingDistanceManual) {
        clampSamplingDistanceToRange();
      } else {
        const zoom = map ? map.getZoom() : undefined;
        const newDistance = computeSamplingDistanceForZoom(zoom);
        if (Number.isFinite(newDistance)) {
          samplingDistance = newDistance;
        }
      }
      gradientPreparer.invalidateAll();
      refreshGradientUI();
      if (map) map.triggerRepaint();
    });
  }

  if (gradientAutoButton) {
    gradientAutoButton.addEventListener('click', () => {
      if (!isSamplingDistanceManual) return;
      isSamplingDistanceManual = false;
      clampSamplingDistanceToRange();
      if (map) {
        updateSamplingDistanceForZoom(true);
      } else {
        const newDistance = computeSamplingDistanceForZoom(undefined);
        if (Number.isFinite(newDistance)) {
          samplingDistance = newDistance;
        }
        gradientPreparer.invalidateAll();
      }
      refreshGradientUI();
      if (map) map.triggerRepaint();
    });
  }

  if (gradientAutoScaleSelect) {
    gradientAutoScaleSelect.addEventListener('change', (event) => {
      const value = typeof event.target?.value === 'string' ? event.target.value : '';
      if (!value) {
        return;
      }
      const parsed = parseFloat(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return;
      }
      gradientAutoScaleKey = value;
      gradientAutoScale = parsed;
      if (isSamplingDistanceManual) {
        refreshGradientUI();
      } else {
        updateSamplingDistanceForZoom(true);
      }
    });
  }

  const triggerShadowRepaint = () => {
    if (map && (isModeActive('shadow') || isModeActive('daylight'))) {
      map.triggerRepaint();
    }
  };

  function canModifyStyle() {
    if (!map) return false;
    if (typeof map.isStyleLoaded === 'function') {
      return map.isStyleLoaded();
    }
    return true;
  }

  function scheduleEnsureCustomLayer() {
    if (!map || pendingCustomLayerEnsure) return;
    pendingCustomLayerEnsure = true;
    const retry = () => {
      pendingCustomLayerEnsure = false;
      ensureCustomTerrainLayer();
    };
    if (typeof map.once === 'function') {
      map.once('idle', retry);
    } else {
      setTimeout(retry, 0);
    }
  }

  function ensureCustomTerrainLayer() {
    pendingCustomLayerEnsure = false;
    if (!map || !activeCustomModes.size) return;
    if (!canModifyStyle()) {
      scheduleEnsureCustomLayer();
      return;
    }
    if (map.getLayer('terrain-normal')) return;
    terrainNormalLayer.frameCount = 0;
    map.addLayer(terrainNormalLayer, getLayerInsertionPoint());
  }

  function removeCustomTerrainLayer() {
    if (!canModifyStyle()) return;
    if (map.getLayer('terrain-normal')) {
      map.removeLayer('terrain-normal');
    }
  }

  function ensureNativeHillshadeLayer() {
    if (!canModifyStyle()) return;
    if (map.getLayer(HILLSHADE_NATIVE_LAYER_ID)) return;
    const layerDefinition = {
      id: HILLSHADE_NATIVE_LAYER_ID,
      type: 'hillshade',
      source: TERRAIN_SOURCE_ID
    };
    map.addLayer(layerDefinition, getLayerInsertionPoint());
    updateHillshadePaintSettingsFromMap();
    if (HillshadeDebug && typeof HillshadeDebug.attachToMap === 'function') {
      HillshadeDebug.attachToMap(map, {
        layerId: HILLSHADE_NATIVE_LAYER_ID,
        sourceId: TERRAIN_SOURCE_ID
      });
    }
  }

  function removeNativeHillshadeLayer() {
    if (!canModifyStyle()) return;
    if (map.getLayer(HILLSHADE_NATIVE_LAYER_ID)) {
      updateHillshadePaintSettingsFromMap();
      map.removeLayer(HILLSHADE_NATIVE_LAYER_ID);
    }
  }

  function setCustomModeEnabled(mode, enabled) {
    if (!mode) return;
    const styleReady = canModifyStyle();
    let stateChanged = false;

    if (enabled) {
      if (!activeCustomModes.has(mode)) {
        activeCustomModes.add(mode);
        stateChanged = true;
      }
      lastCustomMode = mode;
      currentMode = mode;
    } else {
      if (activeCustomModes.delete(mode)) {
        stateChanged = true;
        if (!activeCustomModes.has(currentMode)) {
          currentMode = activeCustomModes.size ? Array.from(activeCustomModes).slice(-1)[0] : '';
        }
      }
    }

    if (!stateChanged && hillshadeMode === 'custom') {
      if (styleReady && map && activeCustomModes.size) {
        map.triggerRepaint();
      }
      updateButtons();
      return;
    }

    if (activeCustomModes.size > 0) {
      hillshadeMode = 'custom';
      if (styleReady) {
        removeNativeHillshadeLayer();
        ensureCustomTerrainLayer();
      }
    } else {
      if (styleReady) {
        removeCustomTerrainLayer();
      }
      if (hillshadeMode === 'custom') {
        hillshadeMode = 'none';
      }
      publishRenderDebugInfo(null);
    }

    terrainNormalLayer.shaderMap.clear();
    updateButtons();
    if (styleReady && map) {
      map.triggerRepaint();
    }
  }

  function clearCustomModes() {
    if (!activeCustomModes.size && hillshadeMode !== 'custom') {
      return;
    }
    activeCustomModes.clear();
    const styleReady = canModifyStyle();
    if (styleReady) {
      removeCustomTerrainLayer();
    }
    if (hillshadeMode === 'custom') {
      hillshadeMode = 'none';
    }
    currentMode = '';
    terrainNormalLayer.shaderMap.clear();
    updateButtons();
    if (styleReady && map) {
      map.triggerRepaint();
    }
    publishRenderDebugInfo(null);
  }

  function toggleCustomMode(mode) {
    if (!mode) return;
    const shouldEnable = !activeCustomModes.has(mode);
    setCustomModeEnabled(mode, shouldEnable);
  }

  function enableCustomHillshade(mode) {
    const nextMode = mode || lastCustomMode || 'hillshade';
    setCustomModeEnabled(nextMode, true);
  }

  function disableCustomHillshade() {
    clearCustomModes();
  }

  function setNativeHillshadeEnabled(enabled) {
    const styleReady = canModifyStyle();
    if (enabled) {
      if (activeCustomModes.size) {
        clearCustomModes();
      }
      if (styleReady) {
        removeNativeHillshadeLayer();
        ensureNativeHillshadeLayer();
      }
      hillshadeMode = 'native';
      currentMode = '';
    } else {
      if (styleReady) {
        removeNativeHillshadeLayer();
      }
      if (hillshadeMode === 'native') {
        hillshadeMode = 'none';
      }
    }
    updateButtons();
    if (styleReady && map) {
      map.triggerRepaint();
    }
  }

  const shadowSampleCountSlider = document.getElementById('shadowSampleCountSlider');
  const shadowSampleCountValue = document.getElementById('shadowSampleCountValue');
  if (shadowSampleCountSlider && shadowSampleCountValue) {
    shadowSampleCountValue.textContent = shadowSampleCount.toString();
    shadowSampleCountSlider.addEventListener('input', (e) => {
      shadowSampleCount = Math.max(1, parseInt(e.target.value, 10));
      shadowSampleCountValue.textContent = shadowSampleCount.toString();
      triggerShadowRepaint();
    });
  }

  const shadowBlurRadiusSlider = document.getElementById('shadowBlurRadiusSlider');
  const shadowBlurRadiusValue = document.getElementById('shadowBlurRadiusValue');
  if (shadowBlurRadiusSlider && shadowBlurRadiusValue) {
    shadowBlurRadiusValue.textContent = shadowBlurRadius.toFixed(2);
    shadowBlurRadiusSlider.addEventListener('input', (e) => {
      shadowBlurRadius = Math.max(0, parseFloat(e.target.value));
      shadowBlurRadiusValue.textContent = shadowBlurRadius.toFixed(2);
      triggerShadowRepaint();
    });
  }

  const shadowRayLengthSlider = document.getElementById('shadowRayLengthSlider');
  const shadowRayLengthValue = document.getElementById('shadowRayLengthValue');
  if (shadowRayLengthSlider && shadowRayLengthValue) {
    shadowRayLengthValue.textContent = shadowMaxDistance.toFixed(0);
    shadowRayLengthSlider.addEventListener('input', (e) => {
      shadowMaxDistance = Math.max(0, parseFloat(e.target.value));
      shadowRayLengthValue.textContent = shadowMaxDistance.toFixed(0);
      triggerShadowRepaint();
    });
  }

  const shadowEdgeSoftnessSlider = document.getElementById('shadowEdgeSoftnessSlider');
  const shadowEdgeSoftnessValue = document.getElementById('shadowEdgeSoftnessValue');
  if (shadowEdgeSoftnessSlider && shadowEdgeSoftnessValue) {
    shadowEdgeSoftnessValue.textContent = shadowEdgeSoftness.toFixed(2);
    shadowEdgeSoftnessSlider.addEventListener('input', (e) => {
      shadowEdgeSoftness = Math.max(0, parseFloat(e.target.value));
      shadowEdgeSoftnessValue.textContent = shadowEdgeSoftness.toFixed(2);
      triggerShadowRepaint();
    });
  }

  const shadowMaxOpacitySlider = document.getElementById('shadowMaxOpacitySlider');
  const shadowMaxOpacityValue = document.getElementById('shadowMaxOpacityValue');
  if (shadowMaxOpacitySlider && shadowMaxOpacityValue) {
    shadowMaxOpacityValue.textContent = shadowMaxOpacity.toFixed(2);
    shadowMaxOpacitySlider.addEventListener('input', (e) => {
      shadowMaxOpacity = Math.min(1, Math.max(0, parseFloat(e.target.value)));
      shadowMaxOpacityValue.textContent = shadowMaxOpacity.toFixed(2);
      triggerShadowRepaint();
    });
  }

  const shadowRayStepMultiplierSlider = document.getElementById('shadowRayStepMultiplierSlider');
  const shadowRayStepMultiplierValue = document.getElementById('shadowRayStepMultiplierValue');
  if (shadowRayStepMultiplierSlider && shadowRayStepMultiplierValue) {
    shadowRayStepMultiplierValue.textContent = shadowRayStepMultiplier.toFixed(2);
    shadowRayStepMultiplierSlider.addEventListener('input', (e) => {
      shadowRayStepMultiplier = Math.max(0.25, parseFloat(e.target.value));
      shadowRayStepMultiplierValue.textContent = shadowRayStepMultiplier.toFixed(2);
      triggerShadowRepaint();
    });
  }

  // Minimal getTileMesh: create or return cached mesh for a tile
  function getTileMesh(gl, tile) {
    const key = `mesh_${tile.tileID.key}`;
    if (meshCache.has(key)) return meshCache.get(key);
    const meshBuffers = maplibregl.createTileMesh({ granularity: 220, generateBorders: false, extent: EXTENT }, '16bit');
    const vertices = new Int16Array(meshBuffers.vertices);
    const indices = new Int16Array(meshBuffers.indices);
    const vertexCount = vertices.length / 2;
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    const mesh = { vbo, ibo, indexCount: indices.length, originalVertexCount: vertexCount };
    meshCache.set(key, mesh);
    return mesh;
  }
  
  // Define the custom terrain layer.
  const terrainNormalLayer = {
    id: 'terrain-normal',
    type: 'custom',
    renderingMode: '3d',
    shaderMap: new Map(),
    frameCount: 0,
    terrainTextureCache: new Map(),
    
    onAdd(mapInstance, gl) {
      this.map = mapInstance;
      this.gl = gl;
      this.frameCount = 0;
      this.terrainTextureCache = new Map();
      gradientPreparer.initialize(gl);
      ensureSunlightEngine(gl);
    },
  
    getShader(gl, shaderDescription) {
      const variantName = shaderDescription.variantName + "_" + currentMode;
      if (this.shaderMap.has(variantName)) return this.shaderMap.get(variantName);
      
      // Build the shader sources using our TerrainShaders helper.
      const vertexSource = TerrainShaders.getVertexShader(shaderDescription, EXTENT);
      const fragmentSource = TerrainShaders.getFragmentShader(currentMode);
      
      const program = gl.createProgram();
      const vertexShader = gl.createShader(gl.VERTEX_SHADER);
      const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(vertexShader, vertexSource);
      gl.compileShader(vertexShader);
      if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
        console.error("Vertex shader error:", gl.getShaderInfoLog(vertexShader));
        return null;
      }
      gl.shaderSource(fragmentShader, fragmentSource);
      gl.compileShader(fragmentShader);
      if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
        console.error("Fragment shader error:", gl.getShaderInfoLog(fragmentShader));
        return null;
      }
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error("Program link error:", gl.getProgramInfoLog(program));
        return null;
      }
      const neighborUniforms = [];
      NEIGHBOR_OFFSETS.forEach(offset => {
        neighborUniforms.push(offset.uniform);
        if (offset.metersUniform) {
          neighborUniforms.push(offset.metersUniform);
        }
      });

      const uniforms = [
        'u_matrix',
        'u_projection_matrix',
        'u_projection_clipping_plane',
        'u_projection_transition',
        'u_projection_tile_mercator_coords',
        'u_projection_fallback_matrix',
        'u_image',
        ...neighborUniforms,
        'u_gradient',
        'u_usePrecomputedGradient',
        'u_dimension',
        'u_original_vertex_count',
        'u_terrain_unpack',
        'u_terrain_exaggeration',
        'u_zoom',
        'u_metersPerPixel',
        'u_latrange',
        'u_lightDir',
        'u_shadowsEnabled',
        'u_samplingDistance'
      ];
      if (currentMode === "hillshade") {
        uniforms.push(
          'u_hillshade_highlight_color',
          'u_hillshade_shadow_color',
          'u_hillshade_accent_color',
          'u_hillshade_exaggeration',
          'u_hillshade_light_dir',
          'u_hillshade_light_altitude',
          'u_hillshade_opacity'
        );
      }
      if (currentMode === "snow") {
        uniforms.push('u_snow_altitude', 'u_snow_maxSlope', 'u_snow_blur');
      }
        if (currentMode === "shadow" || currentMode === "daylight") {
          uniforms.push(
            'u_shadowSampleCount',
            'u_shadowBlurRadius',
            'u_shadowMaxDistance',
            'u_shadowVisibilityThreshold',
            'u_shadowEdgeSoftness',
            'u_shadowMaxOpacity',
            'u_shadowRayStepMultiplier',
            'u_shadowSlopeBias',
            'u_shadowPixelBias'
          );
          if (currentMode === "shadow") {
            uniforms.push(
              'u_sunDirection',
              'u_sunAltitude',
              'u_sunSlope',
              'u_sunWarmColor',
              'u_sunWarmIntensity'
            );
          } else {
            uniforms.push(
            'u_h4Horizon',
            'u_h4Lut',
            'u_h4AzimuthCount',
            'u_h4QuantizationLevels',
            'u_h4MinutesToHours',
            'u_h4MaxHours'
          );
        }
      }
      const locations = {};
      uniforms.forEach(u => { locations[u] = gl.getUniformLocation(program, u); });
      const attributes = { a_pos: gl.getAttribLocation(program, 'a_pos') };
      const result = { program, locations, attributes };
      this.shaderMap.set(variantName, result);
      return result;
    },
  
    renderTiles(gl, shader, renderableTiles, terrainInterface, tileManager, terrainDataCache, textureCache, metersPerPixelCache, nativeGradientCache = null, debugMetrics = null) {
      if (!terrainInterface || !tileManager) return;
      let renderedCount = 0;
      let skippedCount = 0;
      const useH4Daylight = currentMode === "daylight";
      const engine = useH4Daylight ? ensureSunlightEngine(gl) : null;
      const MINUTES_TO_HOURS = 1.0 / 60.0;
      let lutInfo = null;

      if (engine && engine.supported && useH4Daylight) {
        const center = this.map ? this.map.getCenter() : { lat: 0, lng: 0 };
        lutInfo = engine.ensureHeliostatLUT({
          lat: center.lat || 0,
          lon: center.lng || 0,
          date: getShadowDateTime(),
          minutesStep: engine.minutesStep || H4_SUNLIGHT_CONFIG.minutesStep
        });
      }

      if (engine && engine.supported && useH4Daylight) {
        const activeKeys = renderableTiles.map(tile => tile.tileID.key);
        engine.collectGarbage(activeKeys);
      }

      if (debugMetrics) {
        if (!Number.isFinite(debugMetrics.totalTiles)) {
          debugMetrics.totalTiles = renderableTiles.length;
        }
        debugMetrics.passes = (debugMetrics.passes || 0) + 1;
      }

      const getNeighborTexture = (tileID, dx, dy, fallbackTexture) => {
        const key = getNeighborCacheKey(tileID, dx, dy);
        if (!key) return fallbackTexture;
        return textureCache.has(key) ? textureCache.get(key) : fallbackTexture;
      };

      const bindTexture = (texture, unit, uniformName) => {
        const location = shader.locations[uniformName];
        if (location == null || !texture) return;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.uniform1i(location, unit);
      };

      const bindTextureNearest2D = (texture, unit, uniformName) => {
        const location = shader.locations[uniformName];
        if (location == null || !texture) return;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.uniform1i(location, unit);
      };

      const bindTextureArrayNearest = (texture, unit, uniformName) => {
        const location = shader.locations[uniformName];
        if (location == null || !texture) return;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.uniform1i(location, unit);
      };

      const setVec3Uniform = (uniformName, values) => {
        const location = shader.locations[uniformName];
        if (!location || !values || values.length < 3) return;
        gl.uniform3f(location, values[0], values[1], values[2]);
      };

      const setVec2Uniform = (uniformName, values) => {
        const location = shader.locations[uniformName];
        if (!location || !values || values.length < 2) return;
        gl.uniform2f(location, values[0], values[1]);
      };

      const setFloatUniform = (uniformName, value) => {
        const location = shader.locations[uniformName];
        if (!location || !Number.isFinite(value)) return;
        gl.uniform1f(location, value);
      };

      const sunParams = currentMode === "shadow" ? computeSunParameters(this.map) : null;
      const gradientTextureUnit = NEIGHBOR_OFFSETS.length + 1;
      const hillshadeUniforms = currentMode === "hillshade"
        ? getHillshadeUniformsForCustomLayer(this.map)
        : null;

      if (hillshadeUniforms) {
        setVec3Uniform('u_hillshade_highlight_color', hillshadeUniforms.highlightColor);
        setVec3Uniform('u_hillshade_shadow_color', hillshadeUniforms.shadowColor);
        setVec3Uniform('u_hillshade_accent_color', hillshadeUniforms.accentColor);
        setFloatUniform('u_hillshade_exaggeration', hillshadeUniforms.exaggeration);
        setVec2Uniform('u_hillshade_light_dir', hillshadeUniforms.lightDir);
        setFloatUniform('u_hillshade_light_altitude', hillshadeUniforms.lightAltitude);
        setFloatUniform('u_hillshade_opacity', hillshadeUniforms.opacity);
      }

      for (const tile of renderableTiles) {
        const sourceTile = tileManager.getSourceTile(tile.tileID, true);
        if (!sourceTile || sourceTile.tileID.key !== tile.tileID.key) {
          if (terrainDebugEnabled) console.log(`Skipping tile ${tile.tileID.key}: source tile mismatch or overscaled`);
          skippedCount++;
          continue;
        }

        let terrainData = terrainDataCache.get(tile.tileID.key) || null;
        if (!terrainData && terrainInterface && terrainInterface.getTerrainData) {
          terrainData = terrainInterface.getTerrainData(tile.tileID);
        }

        if (!terrainData || !terrainData.texture) {
          if (terrainDebugEnabled) console.log(`Skipping tile ${tile.tileID.key}: no terrain data or texture`);
          skippedCount++;
          continue;
        }

        if (terrainData.fallback) {
          if (terrainDebugEnabled) console.log(`Skipping tile ${tile.tileID.key}: fallback tile`);
          skippedCount++;
          continue;
        }

        const mesh = getTileMesh(gl, tile);
        if (!mesh) continue;

        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
        gl.enableVertexAttribArray(shader.attributes.a_pos);
        gl.vertexAttribPointer(shader.attributes.a_pos, 2, gl.SHORT, false, 4, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);

        const canonical = tile.tileID.canonical;
        const tileSize = sourceTile.dem && sourceTile.dem.dim ? sourceTile.dem.dim : TILE_SIZE;
        const metersPerPixel = computeMetersPerPixelForTile(canonical, tileSize);
        if (shader.locations.u_metersPerPixel != null) {
          gl.uniform1f(shader.locations.u_metersPerPixel, metersPerPixel);
        }

        let neighborTextures = null;
        let neighborMeters = null;
        if (terrainData.texture && shader.locations.u_image != null) {
          bindTexture(terrainData.texture, 0, 'u_image');
          if (currentMode === "shadow" || currentMode === "daylight") {
            neighborTextures = [];
            neighborMeters = [];
            NEIGHBOR_OFFSETS.forEach((neighbor, index) => {
              const neighborKey = getNeighborCacheKey(tile.tileID, neighbor.dx, neighbor.dy);
              const texture = getNeighborTexture(
                tile.tileID,
                neighbor.dx,
                neighbor.dy,
                terrainData.texture
              );
              neighborTextures.push(texture);
              bindTexture(texture, index + 1, neighbor.uniform);
              const neighborMetersValue = (neighborKey && metersPerPixelCache && metersPerPixelCache.has(neighborKey))
                ? metersPerPixelCache.get(neighborKey)
                : metersPerPixel;
              neighborMeters.push(neighborMetersValue);
              const metersLocation = shader.locations[neighbor.metersUniform];
              if (metersLocation != null) {
                gl.uniform1f(metersLocation, neighborMetersValue);
              }
            });
          }
        } else if (currentMode === "shadow" || currentMode === "daylight") {
          neighborTextures = [];
          neighborMeters = [];
        }

        const tileKey = tile.tileID ? tile.tileID.key : null;
        let gradientTexture = null;
        if (tileKey && nativeGradientCache && nativeGradientCache.has(tileKey)) {
          gradientTexture = nativeGradientCache.get(tileKey);
        }
        if (!gradientTexture) {
          gradientTexture = gradientPreparer.getTexture(tile.tileID.key);
        }
        const hasGradient = !!gradientTexture;
        if (shader.locations.u_usePrecomputedGradient != null) {
          gl.uniform1i(shader.locations.u_usePrecomputedGradient, hasGradient ? 1 : 0);
        }
        if (hasGradient && gradientTexture) {
          bindTexture(gradientTexture, gradientTextureUnit, 'u_gradient');
        } else if (shader.locations.u_gradient != null) {
          gl.activeTexture(gl.TEXTURE0 + gradientTextureUnit);
          gl.bindTexture(gl.TEXTURE_2D, null);
        }

        const projectionData = this.map.transform.getProjectionData({
          overscaledTileID: tile.tileID,
          applyGlobeMatrix: true
        });

        if (shader.locations.u_projection_tile_mercator_coords != null) {
          gl.uniform4f(
            shader.locations.u_projection_tile_mercator_coords,
            ...projectionData.tileMercatorCoords
          );
        }
        if (shader.locations.u_projection_clipping_plane != null) {
          gl.uniform4f(shader.locations.u_projection_clipping_plane, ...projectionData.clippingPlane);
        }
        if (shader.locations.u_projection_transition != null) {
          gl.uniform1f(shader.locations.u_projection_transition, projectionData.projectionTransition);
        }
        if (shader.locations.u_projection_matrix != null) {
          gl.uniformMatrix4fv(shader.locations.u_projection_matrix, false, projectionData.mainMatrix);
        }
        if (shader.locations.u_projection_fallback_matrix != null) {
          gl.uniformMatrix4fv(shader.locations.u_projection_fallback_matrix, false, projectionData.fallbackMatrix);
        }
        if (shader.locations.u_dimension != null) {
          gl.uniform2f(shader.locations.u_dimension, tileSize, tileSize);
        }
        if (shader.locations.u_original_vertex_count != null) {
          gl.uniform1i(shader.locations.u_original_vertex_count, mesh.originalVertexCount);
        }
        if (shader.locations.u_terrain_exaggeration != null) {
          gl.uniform1f(shader.locations.u_terrain_exaggeration, 1.0);
        }
        const rgbaFactors = {
            r: 256.0,
            g: 1.0,
            b: 1.0 / 256.0,
            base: 32768.0
        };
        if (shader.locations.u_terrain_unpack != null) {
          gl.uniform4f(
              shader.locations.u_terrain_unpack,
              rgbaFactors.r,
              rgbaFactors.g,
              rgbaFactors.b,
              rgbaFactors.base
          );
        }
        if (shader.locations.u_latrange != null) {
          gl.uniform2f(shader.locations.u_latrange, 47.0, 45.0);
        }
        if (shader.locations.u_zoom != null) {
          gl.uniform1f(shader.locations.u_zoom, canonical.z);
        }
        if (shader.locations.u_samplingDistance != null) {
          gl.uniform1f(shader.locations.u_samplingDistance, samplingDistance);
        }

        let horizonEntry = null;
        if (useH4Daylight && engine && engine.supported) {
          horizonEntry = engine.ensureTileResources({
            tileKey: tile.tileID.key,
            tileSize,
            baseTexture: terrainData.texture,
            neighborTextures: neighborTextures || [],
            neighborMeters: neighborMeters || [],
            metersPerPixel,
            maxDistance: shadowMaxDistance,
            stepMultiplier: shadowRayStepMultiplier
          });
        }

        if (useH4Daylight && (!engine || !engine.supported || !horizonEntry || !lutInfo || !lutInfo.texture)) {
          skippedCount++;
          continue;
        }

        if (currentMode === "snow" && shader.locations.u_snow_altitude != null) {
          gl.uniform1f(shader.locations.u_snow_altitude, snowAltitude);
          if (shader.locations.u_snow_maxSlope != null) {
            gl.uniform1f(shader.locations.u_snow_maxSlope, snowMaxSlope);
          }
          if (shader.locations.u_snow_blur != null) {
            gl.uniform1f(shader.locations.u_snow_blur, snowBlurAmount);
          }
        }
        if (currentMode === "shadow" && shader.locations.u_sunDirection != null) {
          if (sunParams) {
            gl.uniform2f(shader.locations.u_sunDirection, sunParams.dirX, sunParams.dirY);
            if (shader.locations.u_sunAltitude != null) {
              gl.uniform1f(shader.locations.u_sunAltitude, sunParams.altitude);
            }
            if (shader.locations.u_sunSlope != null && Number.isFinite(sunParams.sunSlope)) {
              gl.uniform1f(shader.locations.u_sunSlope, sunParams.sunSlope);
            }
            if (shader.locations.u_sunWarmColor != null && Array.isArray(sunParams.warmColor)) {
              gl.uniform3f(
                shader.locations.u_sunWarmColor,
                sunParams.warmColor[0],
                sunParams.warmColor[1],
                sunParams.warmColor[2]
              );
            }
            if (shader.locations.u_sunWarmIntensity != null) {
              gl.uniform1f(shader.locations.u_sunWarmIntensity, sunParams.warmIntensity);
            }
          }
        }

        if (useH4Daylight && engine && engine.supported && horizonEntry && lutInfo && lutInfo.texture) {
          const horizonTextureUnit = gradientTextureUnit + 1;
          const lutTextureUnit = gradientTextureUnit + 2;
          bindTextureArrayNearest(horizonEntry.texture, horizonTextureUnit, 'u_h4Horizon');
          bindTextureNearest2D(lutInfo.texture, lutTextureUnit, 'u_h4Lut');
          if (shader.locations.u_h4AzimuthCount != null) {
            gl.uniform1i(shader.locations.u_h4AzimuthCount, engine.azimuthCount);
          }
          if (shader.locations.u_h4QuantizationLevels != null) {
            gl.uniform1i(shader.locations.u_h4QuantizationLevels, engine.quantizationLevels);
          }
          if (shader.locations.u_h4MinutesToHours != null) {
            gl.uniform1f(shader.locations.u_h4MinutesToHours, MINUTES_TO_HOURS);
          }
          if (shader.locations.u_h4MaxHours != null) {
            const maxHours = lutInfo.maxMinutes ? lutInfo.maxMinutes * MINUTES_TO_HOURS : 0;
            gl.uniform1f(shader.locations.u_h4MaxHours, Math.max(maxHours, 0));
          }
        }

        if ((currentMode === "shadow" || currentMode === "daylight") && shader.locations.u_shadowSampleCount != null) {
          gl.uniform1i(shader.locations.u_shadowSampleCount, Math.floor(shadowSampleCount));
        }
        if ((currentMode === "shadow" || currentMode === "daylight") && shader.locations.u_shadowBlurRadius != null) {
          gl.uniform1f(shader.locations.u_shadowBlurRadius, shadowBlurRadius);
        }
        if ((currentMode === "shadow" || currentMode === "daylight") && shader.locations.u_shadowMaxDistance != null) {
          gl.uniform1f(shader.locations.u_shadowMaxDistance, shadowMaxDistance);
        }
        if ((currentMode === "shadow" || currentMode === "daylight") && shader.locations.u_shadowVisibilityThreshold != null) {
          gl.uniform1f(shader.locations.u_shadowVisibilityThreshold, shadowVisibilityThreshold);
        }
        if ((currentMode === "shadow" || currentMode === "daylight") && shader.locations.u_shadowEdgeSoftness != null) {
          gl.uniform1f(shader.locations.u_shadowEdgeSoftness, shadowEdgeSoftness);
        }
        if ((currentMode === "shadow" || currentMode === "daylight") && shader.locations.u_shadowMaxOpacity != null) {
          gl.uniform1f(shader.locations.u_shadowMaxOpacity, shadowMaxOpacity);
        }
        if ((currentMode === "shadow" || currentMode === "daylight") && shader.locations.u_shadowRayStepMultiplier != null) {
          gl.uniform1f(shader.locations.u_shadowRayStepMultiplier, shadowRayStepMultiplier);
        }
        if ((currentMode === "shadow" || currentMode === "daylight") && shader.locations.u_shadowSlopeBias != null) {
          gl.uniform1f(shader.locations.u_shadowSlopeBias, shadowSlopeBias);
        }
        if ((currentMode === "shadow" || currentMode === "daylight") && shader.locations.u_shadowPixelBias != null) {
          gl.uniform1f(shader.locations.u_shadowPixelBias, shadowPixelBias);
        }

        gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, 0);
        renderedCount++;
        if (debugMetrics) {
          debugMetrics.drawnTiles = (debugMetrics.drawnTiles || 0) + 1;
        }
      }

      if (terrainDebugEnabled && (renderedCount > 0 || skippedCount > 0)) {
        console.log(`Rendered ${renderedCount} tiles, skipped ${skippedCount} tiles`);
      }
      if (debugMetrics) {
        debugMetrics.skippedTiles = (debugMetrics.skippedTiles || 0) + skippedCount;
      }
    },

    render(gl, matrix) {
      if (!activeCustomModes.size) {
        publishRenderDebugInfo(null);
        return;
      }

      this.frameCount++;
      if (this.frameCount < 3) {
        this.map.triggerRepaint();
        return;
      }

      const terrainInterface = getTerrainInterface(this.map);
      const tileManager = terrainInterface ? terrainInterface.tileManager : null;
      if (!tileManager) {
        if (terrainDebugEnabled) console.warn("Tile manager not available; skipping render");
        this.map.triggerRepaint();
        publishRenderDebugInfo(null);
        return;
      }

      const terrainSpec = typeof this.map.getTerrain === 'function'
        ? this.map.getTerrain()
        : null;
      const needsManualTileUpdate = (!terrainSpec || terrainSpec.exaggeration === 0)
        && typeof tileManager.update === 'function';
      if (needsManualTileUpdate) {
        try {
          tileManager.update(this.map.transform, terrainInterface);
        } catch (error) {
          if (terrainDebugEnabled) console.error('Failed to update terrain tiles while terrain is flattened', error);
        }
      }

      if (tileManager.anyTilesAfterTime(Date.now() - 100)) {
        this.map.triggerRepaint();
        return;
      }

      const renderableTiles = tileManager.getRenderableTiles();
      if (renderableTiles.length === 0) {
        const gradientDebug = typeof gradientPreparer.getDebugInfo === 'function'
          ? gradientPreparer.getDebugInfo()
          : null;
        publishRenderDebugInfo({
          debugMetrics: { totalTiles: 0, drawnTiles: 0, skippedTiles: 0, passes: 0 },
          renderableTileCount: 0,
          terrainDataCount: 0,
          textureCacheCount: 0,
          nativeGradientTiles: 0,
          samplingDistance,
          isSamplingDistanceManual,
          neighborSamplingActive: false,
          hillshadeMode,
          currentMode,
          gradientDebug,
          activeModes: getActiveModesInOrder()
        });
        this.map.triggerRepaint();
        return;
      }

      const terrainDataCache = new Map();
      const textureCache = new Map();
      const metersPerPixelCache = new Map();
      const persistentTextureCache = this.terrainTextureCache || (this.terrainTextureCache = new Map());
      for (const tile of renderableTiles) {
        const sourceTile = tileManager.getSourceTile(tile.tileID, true);
        if (!sourceTile || sourceTile.tileID.key !== tile.tileID.key) continue;
        const tileKey = tile.tileID && tile.tileID.key ? tile.tileID.key : null;
        const cacheKey = getTileCacheKey(tile.tileID);
        const canonical = tile.tileID.canonical;
        const tileSize = sourceTile.dem && sourceTile.dem.dim ? sourceTile.dem.dim : TILE_SIZE;
        let terrainData = terrainInterface && terrainInterface.getTerrainData
          ? terrainInterface.getTerrainData(tile.tileID)
          : null;
        let terrainTexture = terrainData && terrainData.texture ? terrainData.texture : null;
        let isFallbackTexture = Boolean(terrainData && terrainData.fallback);

        if (terrainTexture && !isFallbackTexture && tileKey) {
          persistentTextureCache.set(tileKey, terrainTexture);
        }

        if ((!terrainTexture || (isFallbackTexture && isTerrainFlattened)) && tileKey && persistentTextureCache.has(tileKey)) {
          terrainTexture = persistentTextureCache.get(tileKey);
          isFallbackTexture = false;
        }

        if (!terrainTexture) {
          continue;
        }

        if (isFallbackTexture && !isTerrainFlattened) {
          continue;
        }

        if (!terrainData) {
          terrainData = { texture: terrainTexture, fallback: false };
        } else if (terrainData.texture !== terrainTexture || terrainData.fallback) {
          terrainData = { ...terrainData, texture: terrainTexture, fallback: false };
        }

        if (tileKey) {
          terrainDataCache.set(tileKey, terrainData);
        }
        if (cacheKey) {
          textureCache.set(cacheKey, terrainTexture);
          const metersPerPixel = computeMetersPerPixelForTile(canonical, tileSize);
          metersPerPixelCache.set(cacheKey, metersPerPixel);
        }
      }

      updateSamplingDistanceForZoom();

      const nativeGradientCache = collectNativeHillshadeTextures(this.map);

      gradientPreparer.prepare({
        gl,
        renderableTiles,
        tileManager,
        terrainInterface,
        terrainDataCache,
        textureCache,
        metersPerPixelCache,
        neighborOffsets: NEIGHBOR_OFFSETS,
        samplingDistance
      });

      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.enable(gl.DEPTH_TEST);

      const gradientDebug = typeof gradientPreparer.getDebugInfo === 'function'
        ? gradientPreparer.getDebugInfo()
        : null;

      const shared = {
        renderableTiles,
        terrainInterface,
        tileManager,
        terrainDataCache,
        textureCache,
        metersPerPixelCache,
        nativeGradientCache,
        gradientDebug
      };

      let lastDebug = null;
      const modes = getActiveModesInOrder();
      for (const mode of modes) {
        const debugInfo = this.renderMode(gl, matrix, mode, shared);
        if (debugInfo) {
          lastDebug = debugInfo;
        }
      }

      gl.disable(gl.BLEND);

      // Rendering the custom layers overwrites the depth buffer which causes the
      // subsequent sky draw call to fail the depth test and disappear. Reset the
      // depth buffer after we're done so MapLibre's internal sky rendering sees
      // a cleared buffer and can draw above our overlays without us touching the
      // internal renderer.
      if (modes.length) {
        const depthMaskEnabled = gl.getParameter(gl.DEPTH_WRITEMASK);
        if (!depthMaskEnabled) {
          gl.depthMask(true);
        }
        gl.clear(gl.DEPTH_BUFFER_BIT);
        if (!depthMaskEnabled) {
          gl.depthMask(false);
        }
      }

      if (lastDebug) {
        lastDebug.activeModes = modes;
        publishRenderDebugInfo(lastDebug);
      } else {
        publishRenderDebugInfo(null);
      }
    },

    renderMode(gl, matrix, mode, shared) {
      const previousMode = currentMode;
      currentMode = mode;
      try {
        const shader = this.getShader(gl, matrix.shaderData);
        if (!shader) {
          return null;
        }
        gl.useProgram(shader.program);

        const debugMetrics = {
          totalTiles: shared.renderableTiles.length,
          drawnTiles: 0,
          skippedTiles: 0,
          passes: 0
        };

        if (mode === "snow" || mode === "slope") {
          gl.depthFunc(gl.LESS);
          gl.colorMask(false, false, false, false);
          gl.clear(gl.DEPTH_BUFFER_BIT);
          this.renderTiles(gl, shader, shared.renderableTiles, shared.terrainInterface, shared.tileManager, shared.terrainDataCache, shared.textureCache, shared.metersPerPixelCache, shared.nativeGradientCache, debugMetrics);

          gl.colorMask(true, true, true, true);
          gl.depthFunc(gl.LEQUAL);
          gl.enable(gl.BLEND);
          gl.blendFuncSeparate(
            gl.SRC_ALPHA,
            gl.ONE_MINUS_SRC_ALPHA,
            gl.ONE,
            gl.ONE_MINUS_SRC_ALPHA
          );
          this.renderTiles(gl, shader, shared.renderableTiles, shared.terrainInterface, shared.tileManager, shared.terrainDataCache, shared.textureCache, shared.metersPerPixelCache, shared.nativeGradientCache, debugMetrics);
        } else {
          gl.depthFunc(gl.LEQUAL);
          gl.clear(gl.DEPTH_BUFFER_BIT);
          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          if (mode === "shadow") {
            gl.blendFuncSeparate(
              gl.ZERO,
              gl.SRC_COLOR,
              gl.ZERO,
              gl.ONE
            );
          } else if (mode === "daylight") {
            gl.blendFuncSeparate(
              gl.SRC_ALPHA,
              gl.ONE_MINUS_SRC_ALPHA,
              gl.ONE,
              gl.ONE_MINUS_SRC_ALPHA
            );
          } else {
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          }
          this.renderTiles(gl, shader, shared.renderableTiles, shared.terrainInterface, shared.tileManager, shared.terrainDataCache, shared.textureCache, shared.metersPerPixelCache, shared.nativeGradientCache, debugMetrics);
        }

        return {
          debugMetrics,
          renderableTileCount: shared.renderableTiles.length,
          terrainDataCount: shared.terrainDataCache.size,
          textureCacheCount: shared.textureCache.size,
          nativeGradientTiles: shared.nativeGradientCache ? shared.nativeGradientCache.size : 0,
          samplingDistance,
          isSamplingDistanceManual,
          neighborSamplingActive: mode === "shadow" || mode === "daylight",
          hillshadeMode,
          currentMode: mode,
          gradientDebug: shared.gradientDebug
        };
      } finally {
        currentMode = previousMode;
      }
    }
  };
  
  // Map setup and initialization.
  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
      sources: {
        [TERRAIN_SOURCE_ID]: {
          type: 'raster-dem',
          tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'],
          tileSize: TERRAIN_ELEVATION_TILE_SIZE,
          maxzoom: 17,
          encoding: 'terrarium'
        },
        'satellite-base': {
          type: 'raster',
          tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg'],
          tileSize: 256,
          attribution: 'Imagery © EOX IT Services GmbH'
        }
      },
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#000000' } },
        { id: 'satellite-base-layer', type: 'raster', source: 'satellite-base', minzoom: 0, maxzoom: 22 }
      ],
      terrain: { source: TERRAIN_SOURCE_ID, exaggeration: 1.0 }
    },
    zoom: 14,
    center: [7.73044, 46.09915],
    pitch: 45,
    hash: true,
    maxPitch: 85,
    maxZoom: 16,
    minZoom: 2,
    fadeDuration: 500
  });

  function getSkyPaintProperties() {
    const clone = { ...SKY_BASE_PROPERTIES };
    if (Array.isArray(SKY_BASE_PROPERTIES['atmosphere-blend'])) {
      clone['atmosphere-blend'] = SKY_BASE_PROPERTIES['atmosphere-blend'].map((value) => {
        return Array.isArray(value) ? value.slice() : value;
      });
    }
    return clone;
  }

  let skyLayerSupportCache = null;

  function detectSkyLayerSupport() {
    if (skyLayerSupportCache !== null) {
      return skyLayerSupportCache;
    }
    let detectedSupport = false;
    try {
      if (typeof maplibregl !== 'undefined' && typeof maplibregl.validateStyle === 'function') {
        const validationResult = maplibregl.validateStyle({
          version: 8,
          sources: {},
          layers: [{ id: '__sky-support-test__', type: 'sky', paint: {} }]
        });
        if (!Array.isArray(validationResult) || validationResult.length === 0) {
          detectedSupport = true;
        } else {
          const hasSkyTypeError = validationResult.some((entry) => {
            if (!entry || typeof entry !== 'object') {
              return false;
            }
            const message = String(entry.message || '');
            return message.indexOf('sky') !== -1;
          });
          detectedSupport = !hasSkyTypeError;
        }
      }
    } catch (error) {
      if (terrainDebugEnabled) {
        console.warn('Failed to detect sky layer support via validateStyle', error);
      }
    }
    if (!detectedSupport) {
      try {
        if (typeof maplibregl !== 'undefined' && maplibregl.styleSpec && maplibregl.styleSpec.layer && maplibregl.styleSpec.layer.type && maplibregl.styleSpec.layer.type.values) {
          detectedSupport = Object.prototype.hasOwnProperty.call(maplibregl.styleSpec.layer.type.values, 'sky');
        }
      } catch (error) {
        if (terrainDebugEnabled) {
          console.warn('Failed to inspect style specification for sky support', error);
        }
      }
    }
    if (!detectedSupport) {
      const versionString = typeof maplibregl !== 'undefined' && typeof maplibregl.version === 'string'
        ? maplibregl.version
        : null;
      if (versionString) {
        const versionMatch = versionString.match(/^(\d+)(?:\.(\d+))?/);
        if (versionMatch) {
          const major = parseInt(versionMatch[1], 10);
          const minor = versionMatch[2] ? parseInt(versionMatch[2], 10) : 0;
          if (Number.isFinite(major)) {
            detectedSupport = major > 2 || (major === 2 && minor >= 0);
          }
        }
      }
    }
    skyLayerSupportCache = detectedSupport;
    return skyLayerSupportCache;
  }

  function ensureSkyLayer(paintProperties) {
    if (!detectSkyLayerSupport()) {
      return false;
    }
    if (!map || !canModifyStyle()) {
      return false;
    }
    if (typeof map.getLayer === 'function' && map.getLayer(SKY_LAYER_ID)) {
      return false;
    }
    try {
      map.addLayer({
        id: SKY_LAYER_ID,
        type: 'sky',
        paint: paintProperties
      });
      return true;
    } catch (error) {
      if (terrainDebugEnabled) {
        console.warn('Failed to add sky layer', error);
      }
      skyLayerSupportCache = false;
      return false;
    }
  }

  function updateSkyLayerPaint(paintProperties) {
    if (!map || typeof map.getLayer !== 'function' || !map.getLayer(SKY_LAYER_ID)) {
      return;
    }
    if (typeof map.setPaintProperty !== 'function') {
      return;
    }
    Object.entries(paintProperties).forEach(([property, value]) => {
      try {
        map.setPaintProperty(SKY_LAYER_ID, property, value);
      } catch (error) {
        if (terrainDebugEnabled) {
          console.warn(`Failed to update sky paint property ${property}`, error);
        }
      }
    });
  }

  function ensureSkyLayerOrder() {
    if (!map || typeof map.moveLayer !== 'function' || typeof map.getLayer !== 'function') {
      return;
    }
    if (!map.getLayer(SKY_LAYER_ID)) {
      return;
    }
    try {
      map.moveLayer(SKY_LAYER_ID);
    } catch (error) {
      if (terrainDebugEnabled) {
        console.warn('Failed to move sky layer to front', error);
      }
    }
  }

  function getLayerInsertionPoint() {
    if (!map || typeof map.getLayer !== 'function') {
      return undefined;
    }
    return map.getLayer(SKY_LAYER_ID) ? SKY_LAYER_ID : undefined;
  }

  const applySkySettings = () => {
    if (!map) {
      return;
    }
    if (!canModifyStyle()) {
      return;
    }
    const paintProperties = getSkyPaintProperties();
    if (!detectSkyLayerSupport()) {
      return;
    }
    const addedSky = ensureSkyLayer(paintProperties);
    if (!addedSky) {
      updateSkyLayerPaint(paintProperties);
    }
    ensureSkyLayerOrder();
  };

  is3DViewEnabled = map.getPitch() > 5;
  if (toggle3DButton) {
    toggle3DButton.textContent = is3DViewEnabled ? 'Revenir en 2D' : 'Passer en 3D';
  }

  map.on('render', () => {
    refreshDebugPanel();
  });

  if (HillshadeDebug && typeof HillshadeDebug.attachToMap === 'function') {
    HillshadeDebug.attachToMap(map, { sourceId: TERRAIN_SOURCE_ID, autoHookLayer: false });
  }

  map.on('styledata', () => {
    applyHQModeToSources();
    applySkySettings();
  });

  const originalSetTerrain = map.setTerrain.bind(map);
  const originalGetTerrain = typeof map.getTerrain === 'function'
    ? map.getTerrain.bind(map)
    : null;
  map.setTerrain = function(specification) {
    if (specification) {
      lastTerrainSpecification = { ...lastTerrainSpecification, ...specification };
      const nextExaggeration = typeof specification.exaggeration === 'number'
        ? specification.exaggeration
        : lastTerrainSpecification.exaggeration;
      isTerrainFlattened = Number.isFinite(nextExaggeration)
        ? nextExaggeration <= TERRAIN_FLATTEN_EXAGGERATION
        : false;
      if (Number.isFinite(nextExaggeration)) {
        currentTerrainExaggeration = nextExaggeration;
      }
      return originalSetTerrain(specification);
    }
    if (!lastTerrainSpecification || !lastTerrainSpecification.source) {
      lastTerrainSpecification = { source: TERRAIN_SOURCE_ID, exaggeration: TERRAIN_DEFAULT_EXAGGERATION };
    }
    isTerrainFlattened = true;
    const flattenedSpecification = {
      ...lastTerrainSpecification,
      exaggeration: TERRAIN_FLATTEN_EXAGGERATION
    };
    currentTerrainExaggeration = TERRAIN_FLATTEN_EXAGGERATION;
    return originalSetTerrain(flattenedSpecification);
  };

  if (originalGetTerrain) {
    map.getTerrain = function() {
      if (isTerrainFlattened) {
        return null;
      }
      return originalGetTerrain();
    };
  }
  
  map.on('load', () => {
    console.log("Map loaded");
    applySkySettings();
    map.on('zoom', applySkySettings);
    map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: TERRAIN_DEFAULT_EXAGGERATION });
    lastTerrainSpecification = { source: TERRAIN_SOURCE_ID, exaggeration: TERRAIN_DEFAULT_EXAGGERATION };
    currentTerrainExaggeration = TERRAIN_DEFAULT_EXAGGERATION;
    isTerrainFlattened = false;
    const tileManager = getTerrainTileManager(map);
    if (tileManager && typeof tileManager.deltaZoom === 'number') {
      tileManager.deltaZoom = 0;
    }
    console.log("Terrain layer initialized");
    recomputeShadowTimeBounds();
    updateSamplingDistanceForZoom();
    applyHQModeToSources();
    if (HillshadeDebug && typeof HillshadeDebug.attachToMap === 'function') {
      HillshadeDebug.attachToMap(map, {
        layerId: hillshadeMode === 'native' ? HILLSHADE_NATIVE_LAYER_ID : null,
        sourceId: TERRAIN_SOURCE_ID
      });
    }
    if (hillshadeMode === 'native') {
      ensureNativeHillshadeLayer();
    } else if (hillshadeMode === 'custom' && activeCustomModes.size) {
      ensureCustomTerrainLayer();
    }
    is3DViewEnabled = map.getPitch() > 5;
    if (toggle3DButton) {
      toggle3DButton.textContent = is3DViewEnabled ? 'Revenir en 2D' : 'Passer en 3D';
    }
    updateButtons();
  });

  initializeShadowDateTimeControls();

  map.on('moveend', () => {
    recomputeShadowTimeBounds();
  });

  map.on('zoomend', () => {
    updateSamplingDistanceForZoom();
    if (isModeActive('shadow') || isModeActive('daylight')) {
      map.triggerRepaint();
    }
  });

  map.on('moveend', () => {
    if (terrainWireframeLayerVisible) {
      rebuildTerrainWireframe();
    }
  });

  map.on('terrain', () => {
    const previousTerrain = cachedTerrainInterface;
    cachedTerrainInterface = null;
    const refreshedTerrain = getTerrainInterface(map);
    if (!refreshedTerrain && previousTerrain && previousTerrain.tileManager && isTerrainFlattened) {
      cachedTerrainInterface = previousTerrain;
      clampTerrainMeshFrameDelta(cachedTerrainInterface);
    }
    gradientPreparer.invalidateAll();
    terrainNormalLayer.shaderMap.clear();
    if (sunlightEngine && typeof sunlightEngine.invalidateAll === 'function') {
      sunlightEngine.invalidateAll();
    }
    if (hillshadeMode === 'custom' && activeCustomModes.size) {
      ensureCustomTerrainLayer();
    }
    if (map.getLayer('terrain-normal')) {
      terrainNormalLayer.frameCount = 0;
      map.triggerRepaint();
    }
    if (terrainWireframeLayerVisible) {
      rebuildTerrainWireframe();
    }
  });
  
  map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }));
  map.addControl(new maplibregl.GlobeControl());
  map.addControl(new maplibregl.TerrainControl());
  
  // Button click event listeners to toggle rendering modes.
  const hillShadeNativeBtn = document.getElementById('hillShadeNativeBtn');
  if (hillShadeNativeBtn) {
    hillShadeNativeBtn.addEventListener('click', () => {
      const enableNative = hillshadeMode !== 'native';
      setNativeHillshadeEnabled(enableNative);
    });
  }

  const hillShadeCustomBtn = document.getElementById('hillShadeCustomBtn');
  if (hillShadeCustomBtn) {
    hillShadeCustomBtn.addEventListener('click', () => {
      toggleCustomMode('hillshade');
    });
  }

  document.getElementById('normalBtn').addEventListener('click', () => {
    toggleCustomMode('normal');
  });

  document.getElementById('avalancheBtn').addEventListener('click', () => {
    toggleCustomMode('avalanche');
  });

  document.getElementById('slopeBtn').addEventListener('click', () => {
    toggleCustomMode('slope');
  });

  document.getElementById('aspectBtn').addEventListener('click', () => {
    toggleCustomMode('aspect');
  });

  document.getElementById('snowBtn').addEventListener('click', () => {
    toggleCustomMode('snow');
  });

  document.getElementById('shadowBtn').addEventListener('click', () => {
    toggleCustomMode('shadow');
  });

  const daylightBtnEl = document.getElementById('daylightBtn');
  if (daylightBtnEl) {
    daylightBtnEl.addEventListener('click', () => {
      toggleCustomMode('daylight');
    });
  }

  if (terrainDebugBtn) {
    terrainDebugBtn.addEventListener('click', () => {
      if (terrainDebugEnabled) {
        logTerrainDebug('Terrain debug logging disabled via UI.');
      }
      const nextEnabled = !terrainDebugEnabled;
      setTerrainDebugEnabled(nextEnabled, { updateUrl: true });
      if (nextEnabled) {
        logTerrainDebug('Terrain debug logging enabled via UI.');
      }
      console.info(`Terrain debug logging ${nextEnabled ? 'enabled' : 'disabled'}.`);
    });
  }

  if (terrainMeshBtn) {
    terrainMeshBtn.addEventListener('click', () => {
      setTerrainWireframeVisibility(!terrainWireframeLayerVisible);
    });
  }

  if (terrainExportBtn) {
    terrainExportBtn.addEventListener('click', () => {
      exportTerrainMeshAsOBJ();
    });
  }

  updateButtons();

  window.addEventListener('unload', () => {
    meshCache.clear();
    if (sunlightEngine && typeof sunlightEngine.destroy === 'function') {
      sunlightEngine.destroy();
    }
    if (map && typeof map.getLayer === 'function' && map.getLayer(TERRAIN_WIREFRAME_LAYER_ID)) {
      try {
        map.removeLayer(TERRAIN_WIREFRAME_LAYER_ID);
      } catch (error) {
        if (terrainDebugEnabled) {
          console.warn('Failed to remove Three.js mesh layer during unload', error);
        }
      }
    }
  });

  function logTerrainDebug(message, details) {
    if (!terrainDebugEnabled) {
      return;
    }
    if (details !== undefined) {
      console.debug(`[TerrainDebug] ${message}`, details);
    } else {
      console.debug(`[TerrainDebug] ${message}`);
    }
  }

})();
