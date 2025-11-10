/* terrain-analysis.js */
(function() {
  const DEBUG = false;
  const HillshadeDebug = window.__MapLibreHillshadeDebug || null;
  const hillshadeDebugFlagEnabled = (() => {
    try {
      const searchParams = new URLSearchParams(window.location.search || '');
      if (searchParams.has('hillshadeDebug')) {
        return true;
      }
      return typeof window.location.hash === 'string' && window.location.hash.includes('hillshadeDebug');
    } catch (error) {
      if (DEBUG) console.warn('Failed to evaluate hillshade debug flag', error);
      return false;
    }
  })();

  let isHillshadeDebugEnabled = false;
  let map;
  let hillshadeMode = 'none'; // "none", "native", or "custom"

  function attachHillshadeDebugToMap() {
    if (!isHillshadeDebugEnabled || !map || !HillshadeDebug || typeof HillshadeDebug.attachToMap !== 'function') {
      return;
    }
    try {
      HillshadeDebug.attachToMap(map, {
        layerId: hillshadeMode === 'native' ? HILLSHADE_NATIVE_LAYER_ID : null,
        sourceId: TERRAIN_SOURCE_ID
      });
    } catch (error) {
      if (DEBUG) console.warn('Failed to attach hillshade debug instrumentation', error);
    }
  }

  function setHillshadeDebugEnabled(enabled, options) {
    if (!HillshadeDebug || typeof HillshadeDebug.enable !== 'function' || typeof HillshadeDebug.disable !== 'function') {
      if (isHillshadeDebugEnabled) {
        isHillshadeDebugEnabled = false;
        updateButtons();
      }
      return false;
    }
    const shouldEnable = Boolean(enabled);
    if (shouldEnable === isHillshadeDebugEnabled) {
      if (shouldEnable && options) {
        HillshadeDebug.enable(options);
        attachHillshadeDebugToMap();
      }
      return isHillshadeDebugEnabled;
    }
    if (shouldEnable) {
      HillshadeDebug.enable(options);
      isHillshadeDebugEnabled = true;
      attachHillshadeDebugToMap();
      if (!options || options.silent !== true) {
        console.info('Hillshade debug instrumentation enabled.');
      }
    } else {
      HillshadeDebug.disable();
      isHillshadeDebugEnabled = false;
      if (!options || options.silent !== true) {
        console.info('Hillshade debug instrumentation disabled.');
      }
    }
    updateButtons();
    return isHillshadeDebugEnabled;
  }

  if (HillshadeDebug && typeof HillshadeDebug.install === 'function') {
    HillshadeDebug.install();
    if (hillshadeDebugFlagEnabled) {
      setHillshadeDebugEnabled(true, { silent: true });
    }
    window.mapLibreHillshadeDebug = Object.freeze({
      enable(options) {
        return setHillshadeDebugEnabled(true, options);
      },
      disable() {
        return setHillshadeDebugEnabled(false);
      },
      getDrawCalls: () => HillshadeDebug.getDrawCalls(),
      getDemEvents: () => HillshadeDebug.getDemEvents(),
      getDemSnapshots: () => HillshadeDebug.getDemSnapshots(),
      getTiles: (options) => HillshadeDebug.getTiles(options)
    });
  }
  const EXTENT = 8192;
  const TILE_SIZE = 512;
  const DEM_MAX_ZOOM = 16; // native DEM max zoom
  const TERRAIN_FLATTEN_EXAGGERATION = 1e-5;
  const TERRAIN_SOURCE_ID = 'terrain';
  const HILLSHADE_NATIVE_LAYER_ID = 'terrain-hillshade-native';
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
  let storedNativeHillshadeVisibility = 'visible';
  let storedNativeHillshadeOpacity = DEFAULT_HILLSHADE_SETTINGS.opacity;
  let nativeHillshadeOpacitySupported = null;
  let lastTerrainSpecification = { source: TERRAIN_SOURCE_ID, exaggeration: 1.0 };
  let isTerrainFlattened = false;

  function getNativeHillshadeOpacity() {
    if (nativeHillshadeOpacitySupported === false) {
      return null;
    }
    if (!map || typeof map.getLayer !== 'function' || !map.getLayer(HILLSHADE_NATIVE_LAYER_ID)) {
      return null;
    }
    try {
      const value = map.getPaintProperty(HILLSHADE_NATIVE_LAYER_ID, 'hillshade-opacity');
      if (nativeHillshadeOpacitySupported === null) {
        nativeHillshadeOpacitySupported = true;
      }
      return value;
    } catch (error) {
      nativeHillshadeOpacitySupported = false;
      if (DEBUG) {
        console.warn('Hillshade opacity paint property is not supported by the current MapLibre build.', error);
      }
      return null;
    }
  }

  function setNativeHillshadeOpacity(value) {
    if (nativeHillshadeOpacitySupported === false) {
      return false;
    }
    if (!map || typeof map.getLayer !== 'function' || !map.getLayer(HILLSHADE_NATIVE_LAYER_ID)) {
      return false;
    }
    if (typeof map.setPaintProperty !== 'function') {
      return false;
    }
    try {
      map.setPaintProperty(HILLSHADE_NATIVE_LAYER_ID, 'hillshade-opacity', value);
      nativeHillshadeOpacitySupported = true;
      return true;
    } catch (error) {
      nativeHillshadeOpacitySupported = false;
      if (DEBUG) {
        console.warn('Failed to set the native hillshade opacity; falling back to visibility toggling.', error);
      }
      return false;
    }
  }

  const gradientDebugState = {
    element: null,
    frameIndex: 0,
    totalPrecomputed: 0,
    totalFallback: 0
  };

  function getGradientDebugElement() {
    if (gradientDebugState.element) {
      const element = gradientDebugState.element;
      if (typeof document === 'undefined' || !document.body || document.body.contains(element)) {
        return element;
      }
    }
    if (typeof document === 'undefined') {
      return null;
    }
    const element = document.getElementById('gradientDebugPanel');
    if (element) {
      gradientDebugState.element = element;
    }
    return gradientDebugState.element;
  }

  function resetGradientDebugStats(options = {}) {
    gradientDebugState.frameIndex = 0;
    gradientDebugState.totalPrecomputed = 0;
    gradientDebugState.totalFallback = 0;
    const element = getGradientDebugElement();
    if (!element) {
      return;
    }
    element.classList.remove('debug-warning');
    if (options.hide) {
      element.style.display = 'none';
      element.innerHTML = '';
      return;
    }
    element.style.display = 'block';
    element.innerHTML = '<strong>Gradient usage</strong><div>Waiting for terrain tiles…</div>';
  }

  function updateGradientDebugPanel(stats) {
    const element = getGradientDebugElement();
    if (!element) {
      return;
    }
    if (!stats || stats.renderedCount <= 0) {
      element.innerHTML = '<strong>Gradient usage</strong><div>No terrain tiles rendered.</div>';
      element.classList.remove('debug-warning');
      element.style.display = 'block';
      return;
    }

    gradientDebugState.frameIndex += 1;
    gradientDebugState.totalPrecomputed += stats.framePrecomputed;
    gradientDebugState.totalFallback += stats.frameFallback;

    const frameTotal = stats.framePrecomputed + stats.frameFallback;
    const framePrecomputedPct = frameTotal > 0
      ? Math.round((stats.framePrecomputed / frameTotal) * 100)
      : 0;
    const totalTiles = gradientDebugState.totalPrecomputed + gradientDebugState.totalFallback;
    const totalPrecomputedPct = totalTiles > 0
      ? Math.round((gradientDebugState.totalPrecomputed / totalTiles) * 100)
      : 0;

    const frameSummary = frameTotal > 0
      ? `${stats.framePrecomputed}/${frameTotal} precomputed (${framePrecomputedPct}%)`
      : 'No gradients this frame';
    const cumulativeSummary = totalTiles > 0
      ? `${gradientDebugState.totalPrecomputed}/${totalTiles} precomputed (${totalPrecomputedPct}%)`
      : 'No gradients sampled yet';

    element.innerHTML = `
      <strong>Gradient usage</strong>
      <div>Frame ${gradientDebugState.frameIndex}: ${frameSummary}</div>
      <div>Fallback tiles this frame: ${stats.frameFallback}</div>
      <div>Cumulative: ${cumulativeSummary}</div>
      <div>Cumulative fallback: ${gradientDebugState.totalFallback}</div>
    `;
    element.classList.toggle('debug-warning', stats.frameFallback > 0);
    element.style.display = 'block';
  }

  function getHillshadeDebugTiles(mapInstance, options = {}) {
    const debugApi = window.mapLibreHillshadeDebug;
    if (!mapInstance || !debugApi || typeof debugApi.getTiles !== 'function') {
      return [];
    }
    try {
      const tiles = debugApi.getTiles({ map: mapInstance, sourceId: TERRAIN_SOURCE_ID, ...options });
      return Array.isArray(tiles) ? tiles : [];
    } catch (error) {
      if (DEBUG) console.warn('Failed to query hillshade tiles from debug API', error);
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
        if (DEBUG) console.warn('Failed to access hillshade framebuffer attachment', error);
        return null;
      }
    }
    return attachment || null;
  }

  function getSourceCacheFromStyle(style, sourceId) {
    if (!style || !sourceId) {
      return null;
    }
    let cache = null;
    try {
      if (typeof style.getSourceCache === 'function') {
        cache = style.getSourceCache(sourceId);
      }
    } catch (error) {
      cache = null;
    }
    if (cache) {
      return cache;
    }
    const candidates = [style.sourceCaches, style._sourceCaches];
    for (const collection of candidates) {
      if (collection && typeof collection === 'object' && collection[sourceId]) {
        return collection[sourceId];
      }
    }
    return null;
  }

  function getTilesFromSourceCache(cache) {
    if (!cache) {
      return [];
    }
    const stores = [cache._tiles, cache.tiles];
    for (const store of stores) {
      if (!store) continue;
      if (Array.isArray(store)) {
        return store.filter(Boolean);
      }
      if (store instanceof Map) {
        return Array.from(store.values()).filter(Boolean);
      }
      if (typeof store === 'object') {
        return Object.keys(store).map(key => store[key]).filter(Boolean);
      }
    }
    return [];
  }

  function collectNativeHillshadeTextures(mapInstance) {
    const cache = new Map();

    if (mapInstance && mapInstance.style) {
      const sourceCache = getSourceCacheFromStyle(mapInstance.style, TERRAIN_SOURCE_ID);
      const tiles = getTilesFromSourceCache(sourceCache);
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
    }

    if (!cache.size) {
      const debugTiles = getHillshadeDebugTiles(mapInstance, { onlyPrepared: true });
      for (const tile of debugTiles) {
        const key = tile && tile.tileID ? tile.tileID.key : null;
        if (!key || tile.needsHillshadePrepare) {
          continue;
        }
        const texture = extractHillshadeColorAttachment(tile);
        if (texture) {
          cache.set(key, texture);
        }
      }
    }

    return cache.size > 0 ? cache : null;
  }

  // Global state variables
  let currentMode = ""; // "hillshade", "normal", "avalanche", "slope", "aspect", "snow", "shadow", or "daylight"
  let lastCustomMode = 'hillshade';
  const meshCache = new Map();
  let snowAltitude = 3000;
  let snowMaxSlope = 55; // in degrees
  let shadowSampleCount = 1;
  let shadowBlurRadius = 1.0;
  let shadowMaxDistance = 14000; // meters
  let shadowVisibilityThreshold = 0.02;
  let shadowEdgeSoftness = 0.01;
  let shadowMaxOpacity = 0.6;
  let shadowRayStepMultiplier = 1.0;
  const MAX_DAYLIGHT_SAMPLES = 16;
  const DAYLIGHT_SAMPLE_INTERVAL_MINUTES = 90;
  const DAYLIGHT_MIN_EFFECTIVE_ALTITUDE = 0.034906585; // ~2 degrees in radians
  const DAYLIGHT_MIN_SAMPLE_COUNT = 4;
  const SHADOW_BUFFER_MINUTES = 30;
  const DEFAULT_DAYLIGHT_BOUNDS = { min: 360, max: 1080 };
  let shadowTimeBounds = { min: 0, max: 1439 };
  let samplingDistance = 0.35;
  let shadowDateValue = null;
  let shadowTimeValue = null;

  const analysisPreparer = TerrainAnalysisPreparer.create();
  const EARTH_CIRCUMFERENCE_METERS = 40075016.68557849;
  const MIN_METERS_PER_PIXEL = 1e-6;

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

  function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    return clamp(value, 0, 1);
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

  function colorArrayToCss(color, fallback = DEFAULT_HILLSHADE_SETTINGS.highlightColor) {
    const source = Array.isArray(color) ? color : fallback;
    const components = source.slice(0, 3).map(component => {
      const numeric = Number(component);
      return clamp01(Number.isFinite(numeric) ? numeric : 0);
    });
    const [r, g, b] = components.map(component => Math.round(component * 255));
    return `rgb(${r}, ${g}, ${b})`;
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
    const opacity = getNativeHillshadeOpacity();
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
    if (!Number.isFinite(zoom)) {
      return samplingDistance;
    }
    const base = 0.35;
    const effectiveZoom = Math.min(Math.max(zoom, 0), DEM_MAX_ZOOM);
    const scaled = base * Math.pow(2, 14 - effectiveZoom);
    return clamp(scaled, 0.2, 3.0);
  }

  function updateSamplingDistanceForZoom() {
    if (!map) return;
    const zoom = map.getZoom();
    const newDistance = computeSamplingDistanceForZoom(zoom);
    if (!Number.isFinite(newDistance)) return;
    if (Math.abs(newDistance - samplingDistance) > 0.01) {
      samplingDistance = newDistance;
      analysisPreparer.invalidateAll();
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

  function generateNeighborOffsets(maxOffset) {
    const offsets = [];
    for (let dy = -maxOffset; dy <= maxOffset; dy++) {
      for (let dx = -maxOffset; dx <= maxOffset; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (Math.abs(dx) + Math.abs(dy) > maxOffset) continue;
        offsets.push({
          dx,
          dy,
          uniform: getUniformNameForOffset(dx, dy)
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
      triggerShadowRepaint();
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
      triggerShadowRepaint();
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

  function computeSunParameters(mapInstance) {
    const center = mapInstance.getCenter();
    const sunDate = getShadowDateTime();
    const sunPos = SunCalc.getPosition(sunDate, center.lat, center.lng);
    const azimuth = sunPos.azimuth;
    const altitude = Math.max(sunPos.altitude, -0.01);
    const dirX = -Math.sin(azimuth);
    const dirY = Math.cos(azimuth);
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
    const lowAltitudeFactor = altitudeDeg > 0 ? Math.max(0, 1 - altitudeDeg / 20) : 0;
    let warmIntensity = Math.max(sunriseIntensity, sunsetIntensity, lowAltitudeFactor);
    warmIntensity = Math.min(1, Math.pow(warmIntensity, 0.85));
    if (altitude <= 0) {
      warmIntensity = 0;
    }

    const isMorning = sunriseIntensity >= sunsetIntensity;
    const deepOrange = isMorning ? [1.0, 0.68, 0.30] : [1.0, 0.60, 0.24];
    const softYellow = [1.0, 0.82, 0.38];
    const altitudeBlend = Math.min(1, Math.max(0, altitudeDeg / 18));
    const warmColor = deepOrange.map((c, i) =>
      c * (1 - altitudeBlend) + softYellow[i] * altitudeBlend
    );

    return { dirX, dirY, altitude, warmColor, warmIntensity };
  }

  function createEmptyDaylightParameters() {
    return {
      sampleCount: 0,
      sunDirections: new Float32Array(MAX_DAYLIGHT_SAMPLES * 2),
      sunAltitudes: new Float32Array(MAX_DAYLIGHT_SAMPLES),
      sampleWeights: new Float32Array(MAX_DAYLIGHT_SAMPLES),
      sampleTimes: new Float32Array(MAX_DAYLIGHT_SAMPLES)
    };
  }

  function computeDaylightParameters(mapInstance) {
    if (!mapInstance) {
      return createEmptyDaylightParameters();
    }

    const center = mapInstance.getCenter();
    const baseDate = getShadowDateTime();
    const times = SunCalc.getTimes(baseDate, center.lat, center.lng);
    const sunriseDate = times.sunrise instanceof Date ? times.sunrise : null;
    const sunsetDate = times.sunset instanceof Date ? times.sunset : null;

    const fallback = createEmptyDaylightParameters();

    let sunriseMs = sunriseDate ? sunriseDate.getTime() : null;
    let sunsetMs = sunsetDate ? sunsetDate.getTime() : null;

    if (sunriseMs === null || sunsetMs === null || !Number.isFinite(sunriseMs) || !Number.isFinite(sunsetMs) || sunsetMs <= sunriseMs) {
      const midday = new Date(baseDate);
      midday.setHours(12, 0, 0, 0);
      const sunPos = SunCalc.getPosition(midday, center.lat, center.lng);
      const altitude = Math.max(sunPos.altitude, 0);
      if (altitude <= 0) {
        return fallback;
      }
      fallback.sampleCount = 1;
      fallback.sunDirections[0] = -Math.sin(sunPos.azimuth);
      fallback.sunDirections[1] = Math.cos(sunPos.azimuth);
      fallback.sunAltitudes[0] = altitude;
      fallback.sampleWeights[0] = 1;
      fallback.sampleTimes[0] = 0.5;
      return fallback;
    }

    const spanMs = Math.max(1, sunsetMs - sunriseMs);
    const spanMinutes = spanMs / 60000;
    const approxCount = Math.ceil(spanMinutes / DAYLIGHT_SAMPLE_INTERVAL_MINUTES) + 1;
    const rawSampleCount = Math.min(
      MAX_DAYLIGHT_SAMPLES,
      Math.max(DAYLIGHT_MIN_SAMPLE_COUNT, approxCount)
    );

    const params = createEmptyDaylightParameters();

    const candidateTimes = new Array(rawSampleCount);
    for (let i = 0; i < rawSampleCount; i++) {
      if (rawSampleCount === 1) {
        candidateTimes[i] = sunriseMs + spanMs * 0.5;
        continue;
      }
      const t = i / (rawSampleCount - 1);
      const eased = 0.5 - 0.5 * Math.cos(Math.PI * t);
      const clampedTime = sunriseMs + eased * spanMs;
      candidateTimes[i] = Math.min(Math.max(clampedTime, sunriseMs), sunsetMs);
    }

    const selectedTimes = [];
    const selectedAltitudes = [];
    const selectedDirections = [];
    const selectedNormalizedTimes = [];

    for (let i = 0; i < candidateTimes.length; i++) {
      const sampleDate = new Date(candidateTimes[i]);
      const sunPos = SunCalc.getPosition(sampleDate, center.lat, center.lng);
      const altitude = Math.max(sunPos.altitude, -0.05);
      if (altitude <= 0) {
        continue;
      }

      const normalized = spanMs > 0 ? (candidateTimes[i] - sunriseMs) / spanMs : 0.5;
      const clampedNormalized = Math.min(Math.max(normalized, 0), 1);
      const isEdgeSample = (i === 0 || i === candidateTimes.length - 1);
      const isFirstSelection = selectedTimes.length === 0;
      const hasFewSamples = selectedTimes.length < 2;

      if (!isEdgeSample && !isFirstSelection && !hasFewSamples && altitude < DAYLIGHT_MIN_EFFECTIVE_ALTITUDE) {
        continue;
      }

      selectedTimes.push(candidateTimes[i]);
      selectedAltitudes.push(altitude);
      selectedDirections.push(-Math.sin(sunPos.azimuth));
      selectedDirections.push(Math.cos(sunPos.azimuth));
      selectedNormalizedTimes.push(clampedNormalized);
    }

    if (!selectedTimes.length) {
      const midday = sunriseMs + spanMs * 0.5;
      const sunPos = SunCalc.getPosition(new Date(midday), center.lat, center.lng);
      if (sunPos.altitude <= 0) {
        return fallback;
      }
      selectedTimes.push(midday);
      selectedAltitudes.push(Math.max(sunPos.altitude, 0));
      selectedDirections.push(-Math.sin(sunPos.azimuth));
      selectedDirections.push(Math.cos(sunPos.azimuth));
      selectedNormalizedTimes.push(0.5);
    }

    const effectiveCount = Math.min(selectedTimes.length, MAX_DAYLIGHT_SAMPLES);
    params.sampleCount = effectiveCount;

    for (let i = 0; i < effectiveCount; i++) {
      params.sunDirections[i * 2] = selectedDirections[i * 2];
      params.sunDirections[i * 2 + 1] = selectedDirections[i * 2 + 1];
      params.sunAltitudes[i] = selectedAltitudes[i];
      params.sampleTimes[i] = selectedNormalizedTimes[i];
    }
    for (let i = effectiveCount; i < MAX_DAYLIGHT_SAMPLES; i++) {
      params.sunDirections[i * 2] = 0;
      params.sunDirections[i * 2 + 1] = 0;
      params.sunAltitudes[i] = 0;
      params.sampleTimes[i] = 0;
    }

    for (let i = 0; i < effectiveCount; i++) {
      const currentTime = selectedTimes[i];
      const prevTime = i === 0 ? sunriseMs : selectedTimes[i - 1];
      const nextTime = i === effectiveCount - 1 ? sunsetMs : selectedTimes[i + 1];
      let left = currentTime - prevTime;
      let right = nextTime - currentTime;
      if (i === 0) {
        left = Math.max(left, right);
      } else if (i === effectiveCount - 1) {
        right = Math.max(right, left);
      }
      const weightMs = Math.max(0, (left + right) * 0.5);
      params.sampleWeights[i] = spanMs > 0 ? weightMs / spanMs : 0;
    }
    for (let i = effectiveCount; i < MAX_DAYLIGHT_SAMPLES; i++) {
      params.sampleWeights[i] = 0;
    }

    return params;
  }

  let cachedTerrainInterface = null;

  function getTerrainInterface(mapInstance) {
    if (!mapInstance) {
      return cachedTerrainInterface && cachedTerrainInterface.tileManager
        ? cachedTerrainInterface
        : null;
    }

    const fromPublicAPI = mapInstance.terrain;
    if (fromPublicAPI && fromPublicAPI.tileManager) {
      cachedTerrainInterface = fromPublicAPI;
      return fromPublicAPI;
    }

    const painterTerrain = mapInstance.painter && mapInstance.painter.terrain;
    if (painterTerrain && painterTerrain.tileManager) {
      cachedTerrainInterface = painterTerrain;
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

    return cachedTerrainInterface && cachedTerrainInterface.tileManager
      ? cachedTerrainInterface
      : null;
  }

  function getTerrainTileManager(mapInstance) {
    const terrainInterface = getTerrainInterface(mapInstance);
    return terrainInterface ? terrainInterface.tileManager || null : null;
  }

  // Update UI button states and slider visibility based on current mode
  function updateButtons() {
    const isCustomActive = hillshadeMode === 'custom';
    const hillshadeDebugBtn = document.getElementById('hillshadeDebugBtn');
    if (hillshadeDebugBtn) {
      const debugAvailable = Boolean(HillshadeDebug && typeof HillshadeDebug.enable === 'function' && typeof HillshadeDebug.disable === 'function');
      hillshadeDebugBtn.disabled = !debugAvailable;
      hillshadeDebugBtn.classList.toggle('active', debugAvailable && isHillshadeDebugEnabled);
    }
    const hillShadeNativeBtn = document.getElementById('hillShadeNativeBtn');
    if (hillShadeNativeBtn) {
      hillShadeNativeBtn.classList.toggle('active', hillshadeMode === 'native');
    }
    const hillShadeCustomBtn = document.getElementById('hillShadeCustomBtn');
    if (hillShadeCustomBtn) {
      hillShadeCustomBtn.classList.toggle('active', isCustomActive && currentMode === "hillshade");
    }
    const normalBtn = document.getElementById('normalBtn');
    if (normalBtn) {
      normalBtn.classList.toggle('active', isCustomActive && currentMode === "normal");
    }
    const avalancheBtn = document.getElementById('avalancheBtn');
    if (avalancheBtn) {
      avalancheBtn.classList.toggle('active', isCustomActive && currentMode === "avalanche");
    }
    const slopeBtn = document.getElementById('slopeBtn');
    if (slopeBtn) {
      slopeBtn.classList.toggle('active', isCustomActive && currentMode === "slope");
    }
    const aspectBtn = document.getElementById('aspectBtn');
    if (aspectBtn) {
      aspectBtn.classList.toggle('active', isCustomActive && currentMode === "aspect");
    }
    const snowBtn = document.getElementById('snowBtn');
    if (snowBtn) {
      snowBtn.classList.toggle('active', isCustomActive && currentMode === "snow");
    }
    const shadowBtn = document.getElementById('shadowBtn');
    if (shadowBtn) {
      shadowBtn.classList.toggle('active', isCustomActive && currentMode === "shadow");
    }
    const daylightBtn = document.getElementById('daylightBtn');
    if (daylightBtn) {
      daylightBtn.classList.toggle('active', isCustomActive && currentMode === "daylight");
    }
    const snowSliderContainer = document.getElementById('snowSliderContainer');
    if (snowSliderContainer) {
      snowSliderContainer.style.display = (isCustomActive && currentMode === "snow") ? "block" : "none";
    }
    const shadowControls = document.getElementById('shadowControls');
    if (shadowControls) {
      shadowControls.style.display = (isCustomActive && (currentMode === "shadow" || currentMode === "daylight")) ? "flex" : "none";
    }
  }
  
  // Slider event listeners
  document.getElementById('snowAltitudeSlider').addEventListener('input', (e) => {
    snowAltitude = parseFloat(e.target.value);
    document.getElementById('snowAltitudeValue').textContent = e.target.value;
    if (map && currentMode === "snow") map.triggerRepaint();
  });
  document.getElementById('snowSlopeSlider').addEventListener('input', (e) => {
    snowMaxSlope = parseFloat(e.target.value);
    document.getElementById('snowSlopeValue').textContent = e.target.value;
    if (map && currentMode === "snow") map.triggerRepaint();
  });

  const triggerShadowRepaint = () => {
    if (currentMode === "shadow" || currentMode === "daylight") {
      analysisPreparer.invalidateAll();
    }
    if (map && (currentMode === "shadow" || currentMode === "daylight")) {
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

  function ensureCustomTerrainLayer(options = {}) {
    const { force = false } = options;
    if (!force && !canModifyStyle()) return false;
    if (map.getLayer('terrain-normal')) return true;
    terrainNormalLayer.frameCount = 0;
    map.addLayer(terrainNormalLayer);
    return true;
  }

  function removeCustomTerrainLayer(options = {}) {
    const { force = false } = options;
    if (!force && !canModifyStyle()) return false;
    if (map.getLayer('terrain-normal')) {
      map.removeLayer('terrain-normal');
      return true;
    }
    return false;
  }

  function ensureNativeHillshadeLayer(options = {}) {
    const { force = false } = options;
    if (!force && !canModifyStyle()) return false;
    if (map.getLayer(HILLSHADE_NATIVE_LAYER_ID)) return true;
    const layerDefinition = {
      id: HILLSHADE_NATIVE_LAYER_ID,
      type: 'hillshade',
      source: TERRAIN_SOURCE_ID,
      paint: {
        'hillshade-highlight-color': colorArrayToCss(hillshadePaintSettings.highlightColor, DEFAULT_HILLSHADE_SETTINGS.highlightColor),
        'hillshade-shadow-color': colorArrayToCss(hillshadePaintSettings.shadowColor, DEFAULT_HILLSHADE_SETTINGS.shadowColor),
        'hillshade-accent-color': colorArrayToCss(hillshadePaintSettings.accentColor, DEFAULT_HILLSHADE_SETTINGS.accentColor),
        'hillshade-exaggeration': Number.isFinite(hillshadePaintSettings.exaggeration)
          ? hillshadePaintSettings.exaggeration
          : DEFAULT_HILLSHADE_SETTINGS.exaggeration,
        'hillshade-illumination-direction': Number.isFinite(hillshadePaintSettings.illuminationDirection)
          ? hillshadePaintSettings.illuminationDirection
          : DEFAULT_HILLSHADE_SETTINGS.illuminationDirection,
        'hillshade-illumination-anchor': typeof hillshadePaintSettings.illuminationAnchor === 'string'
          ? hillshadePaintSettings.illuminationAnchor
          : DEFAULT_HILLSHADE_SETTINGS.illuminationAnchor
      }
    };
    map.addLayer(layerDefinition);
    nativeHillshadeOpacitySupported = null;
    if (typeof storedNativeHillshadeVisibility === 'string' && storedNativeHillshadeVisibility !== 'visible') {
      map.setLayoutProperty(HILLSHADE_NATIVE_LAYER_ID, 'visibility', storedNativeHillshadeVisibility);
    }
    updateHillshadePaintSettingsFromMap();
    if (HillshadeDebug && typeof HillshadeDebug.attachToMap === 'function') {
      HillshadeDebug.attachToMap(map, {
        layerId: HILLSHADE_NATIVE_LAYER_ID,
        sourceId: TERRAIN_SOURCE_ID
      });
    }
    return true;
  }

  function removeNativeHillshadeLayer(options = {}) {
    const { force = false, skipPaintUpdate = false } = options;
    if (!force && !canModifyStyle()) return false;
    if (map.getLayer(HILLSHADE_NATIVE_LAYER_ID)) {
      if (!skipPaintUpdate) {
        updateHillshadePaintSettingsFromMap();
      }
      map.removeLayer(HILLSHADE_NATIVE_LAYER_ID);
      return true;
    }
    return false;
  }

  function invokeWhenStyleReady(callback) {
    if (!map || typeof callback !== 'function') return;
    if (canModifyStyle()) {
      callback();
      return;
    }
    let executed = false;
    const runWhenReady = () => {
      if (executed || !map) return;
      if (!canModifyStyle()) {
        map.once('styledata', runWhenReady);
        map.once('idle', runWhenReady);
        return;
      }
      executed = true;
      callback();
    };
    map.once('styledata', runWhenReady);
    map.once('idle', runWhenReady);
  }

  function enableCustomHillshade(mode) {
    const nextMode = mode || lastCustomMode || 'hillshade';
    lastCustomMode = nextMode;
    currentMode = nextMode;
    hillshadeMode = 'custom';
    terrainNormalLayer.shaderMap.clear();
    analysisPreparer.invalidateAll();
    updateButtons();
    attachHillshadeDebugToMap();
    resetGradientDebugStats({ hide: false });
    invokeWhenStyleReady(() => {
      ensureNativeHillshadeLayer({ force: true });
      if (map.getLayer(HILLSHADE_NATIVE_LAYER_ID)) {
        const currentVisibility = map.getLayoutProperty(HILLSHADE_NATIVE_LAYER_ID, 'visibility');
        storedNativeHillshadeVisibility = typeof currentVisibility === 'string'
          ? currentVisibility
          : 'visible';
        const currentOpacity = getNativeHillshadeOpacity();
        const normalizedOpacity = Number.isFinite(currentOpacity)
          ? clamp01(currentOpacity)
          : DEFAULT_HILLSHADE_SETTINGS.opacity;
        storedNativeHillshadeOpacity = normalizedOpacity;
        hillshadePaintSettings.opacity = normalizedOpacity;
        const opacitySet = setNativeHillshadeOpacity(0);
        if (opacitySet) {
          map.setLayoutProperty(HILLSHADE_NATIVE_LAYER_ID, 'visibility', 'visible');
        } else {
          map.setLayoutProperty(HILLSHADE_NATIVE_LAYER_ID, 'visibility', 'none');
        }
      }
      ensureCustomTerrainLayer({ force: true });
      map.triggerRepaint();
    });
  }

  function disableCustomHillshade() {
    if (hillshadeMode === 'custom') {
      hillshadeMode = 'none';
    }
    currentMode = '';
    terrainNormalLayer.shaderMap.clear();
    analysisPreparer.invalidateAll();
    updateButtons();
    attachHillshadeDebugToMap();
    resetGradientDebugStats({ hide: true });
    invokeWhenStyleReady(() => {
      removeCustomTerrainLayer({ force: true });
      if (map.getLayer(HILLSHADE_NATIVE_LAYER_ID)) {
        map.setLayoutProperty(
          HILLSHADE_NATIVE_LAYER_ID,
          'visibility',
          typeof storedNativeHillshadeVisibility === 'string' ? storedNativeHillshadeVisibility : 'visible'
        );
        const restoreOpacity = Number.isFinite(storedNativeHillshadeOpacity)
          ? storedNativeHillshadeOpacity
          : DEFAULT_HILLSHADE_SETTINGS.opacity;
        const restored = setNativeHillshadeOpacity(restoreOpacity);
        if (!restored) {
          map.setLayoutProperty(
            HILLSHADE_NATIVE_LAYER_ID,
            'visibility',
            typeof storedNativeHillshadeVisibility === 'string' ? storedNativeHillshadeVisibility : 'visible'
          );
        }
        hillshadePaintSettings.opacity = clamp01(restoreOpacity);
        removeNativeHillshadeLayer({ force: true });
      }
      map.triggerRepaint();
    });
  }

  function setNativeHillshadeEnabled(enabled) {
    resetGradientDebugStats({ hide: true });
    if (enabled) {
      hillshadeMode = 'native';
      currentMode = '';
      invokeWhenStyleReady(() => {
        removeCustomTerrainLayer({ force: true });
        ensureNativeHillshadeLayer({ force: true });
        if (map.getLayer(HILLSHADE_NATIVE_LAYER_ID)) {
          map.setLayoutProperty(
            HILLSHADE_NATIVE_LAYER_ID,
            'visibility',
            typeof storedNativeHillshadeVisibility === 'string' ? storedNativeHillshadeVisibility : 'visible'
          );
          const restoreOpacity = Number.isFinite(storedNativeHillshadeOpacity)
            ? storedNativeHillshadeOpacity
            : DEFAULT_HILLSHADE_SETTINGS.opacity;
          const restored = setNativeHillshadeOpacity(restoreOpacity);
          if (!restored) {
            map.setLayoutProperty(
              HILLSHADE_NATIVE_LAYER_ID,
              'visibility',
              typeof storedNativeHillshadeVisibility === 'string' ? storedNativeHillshadeVisibility : 'visible'
            );
          }
          hillshadePaintSettings.opacity = clamp01(restoreOpacity);
          updateHillshadePaintSettingsFromMap();
        }
        map.triggerRepaint();
      });
    } else {
      if (hillshadeMode === 'native') {
        hillshadeMode = 'none';
      }
      invokeWhenStyleReady(() => {
        if (map.getLayer(HILLSHADE_NATIVE_LAYER_ID)) {
          const currentVisibility = map.getLayoutProperty(HILLSHADE_NATIVE_LAYER_ID, 'visibility');
          storedNativeHillshadeVisibility = typeof currentVisibility === 'string'
            ? currentVisibility
            : 'visible';
          const currentOpacity = getNativeHillshadeOpacity();
          if (Number.isFinite(currentOpacity)) {
            const normalized = clamp01(currentOpacity);
            storedNativeHillshadeOpacity = normalized;
            hillshadePaintSettings.opacity = normalized;
          }
        }
        removeNativeHillshadeLayer({ force: true });
        map.triggerRepaint();
      });
    }
    updateButtons();
    attachHillshadeDebugToMap();
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
    const meshBuffers = maplibregl.createTileMesh({ granularity: 128, generateBorders: false, extent: EXTENT }, '16bit');
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
    
    onAdd(mapInstance, gl) {
      this.map = mapInstance;
      this.gl = gl;
      this.frameCount = 0;
      analysisPreparer.initialize(gl);
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
      const neighborUniforms = NEIGHBOR_OFFSETS.map(offset => offset.uniform);

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
        'u_precomputedAnalysis',
        'u_usePrecomputedAnalysis',
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
        uniforms.push('u_snow_altitude', 'u_snow_maxSlope');
      }
      if (currentMode === "shadow" || currentMode === "daylight") {
        uniforms.push(
          'u_shadowSampleCount',
          'u_shadowBlurRadius',
          'u_shadowMaxDistance',
          'u_shadowVisibilityThreshold',
          'u_shadowEdgeSoftness',
          'u_shadowMaxOpacity',
          'u_shadowRayStepMultiplier'
        );
        if (currentMode === "shadow") {
          uniforms.push(
            'u_sunDirection',
            'u_sunAltitude',
            'u_sunWarmColor',
            'u_sunWarmIntensity'
          );
        } else {
          uniforms.push(
            'u_daylightSampleCount',
            'u_daylightSunDir[0]',
            'u_daylightSunAltitude[0]',
            'u_daylightSampleWeight[0]',
            'u_daylightSampleTime[0]'
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
  
    renderTiles(gl, shader, renderableTiles, terrainInterface, tileManager, terrainDataCache, textureCache, nativeGradientCache = null, sunParamsOverride = null, daylightParamsOverride = null) {
      if (!terrainInterface || !tileManager) return;
      let renderedCount = 0;
      let skippedCount = 0;

      const getNeighborTexture = (tileID, dx, dy, fallbackTexture) => {
        const key = getNeighborCacheKey(tileID, dx, dy);
        if (!key) return fallbackTexture;
        return textureCache.has(key) ? textureCache.get(key) : fallbackTexture;
      };

      const bindTexture = (texture, unit, uniformName, options = {}) => {
        const location = shader.locations[uniformName];
        if (location == null || !texture) return;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        const minFilter = options.minFilter || gl.LINEAR;
        const magFilter = options.magFilter || gl.LINEAR;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
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

      const sunParams = sunParamsOverride || (currentMode === "shadow" ? computeSunParameters(this.map) : null);
      const daylightParams = daylightParamsOverride || (currentMode === "daylight" ? computeDaylightParameters(this.map) : null);
      const gradientTextureUnit = NEIGHBOR_OFFSETS.length + 1;
      const analysisTextureUnit = gradientTextureUnit + 1;
      const hillshadeUniforms = currentMode === "hillshade"
        ? getHillshadeUniformsForCustomLayer(this.map)
        : null;

      let framePrecomputedCount = 0;
      let frameFallbackCount = 0;

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
          if (DEBUG) console.log(`Skipping tile ${tile.tileID.key}: source tile mismatch or overscaled`);
          skippedCount++;
          continue;
        }

        let terrainData = terrainDataCache.get(tile.tileID.key) || null;
        if (!terrainData && terrainInterface && terrainInterface.getTerrainData) {
          terrainData = terrainInterface.getTerrainData(tile.tileID);
        }

        if (!terrainData || !terrainData.texture) {
          if (DEBUG) console.log(`Skipping tile ${tile.tileID.key}: no terrain data or texture`);
          skippedCount++;
          continue;
        }

        if (terrainData.fallback) {
          if (DEBUG) console.log(`Skipping tile ${tile.tileID.key}: fallback tile`);
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

        if (terrainData.texture && shader.locations.u_image != null) {
          bindTexture(terrainData.texture, 0, 'u_image');
          NEIGHBOR_OFFSETS.forEach((neighbor, index) => {
            const location = shader.locations[neighbor.uniform];
            if (location == null) {
              return;
            }
            const texture = getNeighborTexture(
              tile.tileID,
              neighbor.dx,
              neighbor.dy,
              terrainData.texture
            );
            bindTexture(texture, index + 1, neighbor.uniform);
          });
        }

        const tileKey = tile.tileID ? tile.tileID.key : null;
        let gradientTexture = null;
        if (tileKey && nativeGradientCache && nativeGradientCache.has(tileKey)) {
          gradientTexture = nativeGradientCache.get(tileKey);
        }
        const hasGradient = !!gradientTexture;
        if (shader.locations.u_usePrecomputedGradient != null) {
          gl.uniform1i(shader.locations.u_usePrecomputedGradient, hasGradient ? 1 : 0);
        }
        if (hasGradient) {
          framePrecomputedCount++;
        } else {
          frameFallbackCount++;
        }
        if (hasGradient && gradientTexture) {
          bindTexture(gradientTexture, gradientTextureUnit, 'u_gradient', { minFilter: gl.NEAREST, magFilter: gl.NEAREST });
        } else if (shader.locations.u_gradient != null) {
          gl.activeTexture(gl.TEXTURE0 + gradientTextureUnit);
          gl.bindTexture(gl.TEXTURE_2D, null);
        }

        let analysisTexture = null;
        if (tileKey && (currentMode === "shadow" || currentMode === "daylight")) {
          analysisTexture = analysisPreparer.getTexture(tileKey);
        }
        if (shader.locations.u_usePrecomputedAnalysis != null) {
          gl.uniform1i(shader.locations.u_usePrecomputedAnalysis, analysisTexture ? 1 : 0);
        }
        if (analysisTexture && shader.locations.u_precomputedAnalysis != null) {
          bindTexture(analysisTexture, analysisTextureUnit, 'u_precomputedAnalysis');
        } else if (shader.locations.u_precomputedAnalysis != null) {
          gl.activeTexture(gl.TEXTURE0 + analysisTextureUnit);
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
        gl.uniform2f(shader.locations.u_dimension, tileSize, tileSize);
        gl.uniform1i(shader.locations.u_original_vertex_count, mesh.originalVertexCount);
        gl.uniform1f(shader.locations.u_terrain_exaggeration, 1.0);
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
        const metersPerPixel = computeMetersPerPixelForTile(canonical, tileSize);
        if (shader.locations.u_metersPerPixel != null) {
          gl.uniform1f(shader.locations.u_metersPerPixel, metersPerPixel);
        }
        if (shader.locations.u_samplingDistance != null) {
          gl.uniform1f(shader.locations.u_samplingDistance, samplingDistance);
        }

        if (currentMode === "snow" && shader.locations.u_snow_altitude != null) {
          gl.uniform1f(shader.locations.u_snow_altitude, snowAltitude);
          if (shader.locations.u_snow_maxSlope != null) {
            gl.uniform1f(shader.locations.u_snow_maxSlope, snowMaxSlope);
          }
        }
        if (currentMode === "shadow" && shader.locations.u_sunDirection != null) {
          if (sunParams) {
            gl.uniform2f(shader.locations.u_sunDirection, sunParams.dirX, sunParams.dirY);
            if (shader.locations.u_sunAltitude != null) {
              gl.uniform1f(shader.locations.u_sunAltitude, sunParams.altitude);
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
        } else if (currentMode === "daylight" && daylightParams) {
          if (shader.locations.u_daylightSampleCount != null) {
            gl.uniform1i(shader.locations.u_daylightSampleCount, daylightParams.sampleCount);
          }
          if (shader.locations['u_daylightSunDir[0]'] != null) {
            gl.uniform2fv(shader.locations['u_daylightSunDir[0]'], daylightParams.sunDirections);
          }
          if (shader.locations['u_daylightSunAltitude[0]'] != null) {
            gl.uniform1fv(shader.locations['u_daylightSunAltitude[0]'], daylightParams.sunAltitudes);
          }
          if (shader.locations['u_daylightSampleWeight[0]'] != null) {
            gl.uniform1fv(shader.locations['u_daylightSampleWeight[0]'], daylightParams.sampleWeights);
          }
          if (shader.locations['u_daylightSampleTime[0]'] != null) {
            gl.uniform1fv(shader.locations['u_daylightSampleTime[0]'], daylightParams.sampleTimes);
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

        gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, 0);
        renderedCount++;
      }

      updateGradientDebugPanel({
        framePrecomputed: framePrecomputedCount,
        frameFallback: frameFallbackCount,
        renderedCount
      });

      if (DEBUG && (renderedCount > 0 || skippedCount > 0)) {
        console.log(`Rendered ${renderedCount} tiles, skipped ${skippedCount} tiles`);
      }
    },

    render(gl, matrix) {
      // Increment frame counter
      this.frameCount++;
      
      // Skip the first few frames to ensure everything is initialized
      if (this.frameCount < 3) {
        this.map.triggerRepaint();
        return;
      }
      
      // Wait for tiles to stabilize after rapid movement
      const terrainInterface = getTerrainInterface(this.map);
      const tileManager = terrainInterface ? terrainInterface.tileManager : null;
      if (!tileManager) {
        if (DEBUG) console.warn("Tile manager not available; skipping render");
        this.map.triggerRepaint();
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
          if (DEBUG) console.error('Failed to update terrain tiles while terrain is flattened', error);
        }
      }

      if (tileManager.anyTilesAfterTime(Date.now() - 100)) {
        this.map.triggerRepaint();
        return;
      }

      const renderableTiles = tileManager.getRenderableTiles();

      // Don't render if we have no tiles
      if (renderableTiles.length === 0) {
        if (DEBUG) console.log("No renderable tiles available");
        if (hillshadeMode === 'custom' && currentMode) {
          updateGradientDebugPanel({ framePrecomputed: 0, frameFallback: 0, renderedCount: 0 });
        }
        this.map.triggerRepaint();
        return;
      }

      const terrainDataCache = new Map();
      const textureCache = new Map();
      for (const tile of renderableTiles) {
        const sourceTile = tileManager.getSourceTile(tile.tileID, true);
        if (!sourceTile || sourceTile.tileID.key !== tile.tileID.key) continue;
        const terrainData = terrainInterface && terrainInterface.getTerrainData
          ? terrainInterface.getTerrainData(tile.tileID)
          : null;
        if (!terrainData || !terrainData.texture || terrainData.fallback) continue;
        const cacheKey = getTileCacheKey(tile.tileID);
        terrainDataCache.set(tile.tileID.key, terrainData);
        textureCache.set(cacheKey, terrainData.texture);
      }

      updateSamplingDistanceForZoom();

      const nativeGradientCache = collectNativeHillshadeTextures(this.map);

      const sunParams = currentMode === "shadow" ? computeSunParameters(this.map) : null;
      const daylightParams = currentMode === "daylight" ? computeDaylightParameters(this.map) : null;

      if (currentMode === "shadow" || currentMode === "daylight") {
        const shadowSettings = {
          sampleCount: shadowSampleCount,
          blurRadius: shadowBlurRadius,
          maxDistance: shadowMaxDistance,
          visibilityThreshold: shadowVisibilityThreshold,
          edgeSoftness: shadowEdgeSoftness,
          maxOpacity: shadowMaxOpacity,
          rayStepMultiplier: shadowRayStepMultiplier
        };
        analysisPreparer.prepare({
          gl,
          mode: currentMode,
          renderableTiles,
          tileManager,
          terrainInterface,
          terrainDataCache,
          textureCache,
          neighborOffsets: NEIGHBOR_OFFSETS,
          samplingDistance,
          getGradientTexture: (tileKey) => {
            if (!nativeGradientCache || !tileKey) {
              return null;
            }
            return nativeGradientCache.get(tileKey) || null;
          },
          shadowSettings,
          sunParams,
          daylightParams
        });
      }

      const shader = this.getShader(gl, matrix.shaderData);
      if (!shader) return;
      gl.useProgram(shader.program);

      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.enable(gl.DEPTH_TEST);

      if (currentMode === "snow" || currentMode === "slope") {
        gl.depthFunc(gl.LESS);
        gl.colorMask(false, false, false, false);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        this.renderTiles(gl, shader, renderableTiles, terrainInterface, tileManager, terrainDataCache, textureCache, nativeGradientCache, sunParams, daylightParams);

        gl.colorMask(true, true, true, true);
        gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(
          gl.SRC_ALPHA,
          gl.ONE_MINUS_SRC_ALPHA,
          gl.ONE,
          gl.ONE_MINUS_SRC_ALPHA
        );
        this.renderTiles(gl, shader, renderableTiles, terrainInterface, tileManager, terrainDataCache, textureCache, nativeGradientCache, sunParams, daylightParams);
      } else {
        gl.depthFunc(gl.LEQUAL);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.BLEND);
        if (currentMode === "shadow" || currentMode === "daylight") {
          gl.blendFuncSeparate(
            gl.SRC_ALPHA,
            gl.ONE_MINUS_SRC_ALPHA,
            gl.ONE,
            gl.ONE_MINUS_SRC_ALPHA
          );
        } else {
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        }
        this.renderTiles(gl, shader, renderableTiles, terrainInterface, tileManager, terrainDataCache, textureCache, nativeGradientCache, sunParams, daylightParams);
      }

      gl.disable(gl.BLEND);
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
          tileSize: 512,
          maxzoom: 17,
          encoding: 'terrarium'
        }
      },
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#ffffff' } }
      ],
      terrain: { source: TERRAIN_SOURCE_ID, exaggeration: 1.0 }
    },
    zoom: 14,
    center: [7.73044, 46.09915],
    pitch: 45,
    hash: true,
    maxPitch: 65,
    maxZoom: 16,
    minZoom: 2,
    fadeDuration: 500
  });

  resetGradientDebugStats({ hide: true });

  if (HillshadeDebug && typeof HillshadeDebug.attachToMap === 'function') {
    HillshadeDebug.attachToMap(map, { sourceId: TERRAIN_SOURCE_ID, autoHookLayer: false });
  }

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
      return originalSetTerrain(specification);
    }
    if (!lastTerrainSpecification || !lastTerrainSpecification.source) {
      lastTerrainSpecification = { source: TERRAIN_SOURCE_ID, exaggeration: 1.0 };
    }
    isTerrainFlattened = true;
    const flattenedSpecification = {
      ...lastTerrainSpecification,
      exaggeration: TERRAIN_FLATTEN_EXAGGERATION
    };
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
    map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: 1.0 });
    lastTerrainSpecification = { source: TERRAIN_SOURCE_ID, exaggeration: 1.0 };
    isTerrainFlattened = false;
    const tileManager = getTerrainTileManager(map);
    if (tileManager && typeof tileManager.deltaZoom === 'number') {
      tileManager.deltaZoom = 0;
    }
    console.log("Terrain layer initialized");
    recomputeShadowTimeBounds();
    updateSamplingDistanceForZoom();
    attachHillshadeDebugToMap();
    if (hillshadeMode === 'native') {
      ensureNativeHillshadeLayer();
    } else if (hillshadeMode === 'custom' && currentMode) {
      ensureCustomTerrainLayer();
    }
    updateButtons();
  });

  initializeShadowDateTimeControls();

  map.on('moveend', () => {
    recomputeShadowTimeBounds();
  });

  map.on('zoomend', () => {
    updateSamplingDistanceForZoom();
    if (currentMode === "shadow" || currentMode === "daylight") {
      map.triggerRepaint();
    }
  });

  map.on('terrain', () => {
    const previousTerrain = cachedTerrainInterface;
    cachedTerrainInterface = null;
    const refreshedTerrain = getTerrainInterface(map);
    if (!refreshedTerrain && previousTerrain && previousTerrain.tileManager && isTerrainFlattened) {
      cachedTerrainInterface = previousTerrain;
    }
    analysisPreparer.invalidateAll();
    terrainNormalLayer.shaderMap.clear();
    if (map.getLayer('terrain-normal')) {
      terrainNormalLayer.frameCount = 0;
      map.triggerRepaint();
    }
  });
  
  map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }));
  map.addControl(new maplibregl.GlobeControl());
  map.addControl(new maplibregl.TerrainControl());
  
  // Button click event listeners to toggle rendering modes.
  const hillshadeDebugBtn = document.getElementById('hillshadeDebugBtn');
  if (hillshadeDebugBtn) {
    hillshadeDebugBtn.addEventListener('click', () => {
      if (!HillshadeDebug) {
        return;
      }
      setHillshadeDebugEnabled(!isHillshadeDebugEnabled);
    });
  }

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
      if (hillshadeMode === 'custom' && currentMode === 'hillshade') {
        disableCustomHillshade();
      } else {
        enableCustomHillshade('hillshade');
      }
    });
  }

  document.getElementById('normalBtn').addEventListener('click', () => {
    if (hillshadeMode === 'custom' && currentMode === "normal") {
      disableCustomHillshade();
    } else {
      enableCustomHillshade("normal");
    }
  });

  document.getElementById('avalancheBtn').addEventListener('click', () => {
    if (hillshadeMode === 'custom' && currentMode === "avalanche") {
      disableCustomHillshade();
    } else {
      enableCustomHillshade("avalanche");
    }
  });

  document.getElementById('slopeBtn').addEventListener('click', () => {
    if (hillshadeMode === 'custom' && currentMode === "slope") {
      disableCustomHillshade();
    } else {
      enableCustomHillshade("slope");
    }
  });

  document.getElementById('aspectBtn').addEventListener('click', () => {
    if (hillshadeMode === 'custom' && currentMode === "aspect") {
      disableCustomHillshade();
    } else {
      enableCustomHillshade("aspect");
    }
  });

  document.getElementById('snowBtn').addEventListener('click', () => {
    if (hillshadeMode === 'custom' && currentMode === "snow") {
      disableCustomHillshade();
    } else {
      enableCustomHillshade("snow");
    }
  });

  document.getElementById('shadowBtn').addEventListener('click', () => {
    if (hillshadeMode === 'custom' && currentMode === "shadow") {
      disableCustomHillshade();
    } else {
      enableCustomHillshade("shadow");
    }
  });

  const daylightBtnEl = document.getElementById('daylightBtn');
  if (daylightBtnEl) {
    daylightBtnEl.addEventListener('click', () => {
      if (hillshadeMode === 'custom' && currentMode === "daylight") {
        disableCustomHillshade();
      } else {
        enableCustomHillshade("daylight");
      }
    });
  }

  updateButtons();

  window.addEventListener('unload', () => { meshCache.clear(); });

})();
