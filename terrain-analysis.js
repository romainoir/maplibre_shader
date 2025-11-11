/* terrain-analysis.js */
(function() {
  const DEBUG = false;
  const HillshadeDebug = window.__MapLibreHillshadeDebug || null;
  const hillshadeDebugEnabled = (() => {
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
  let lastTerrainSpecification = { source: TERRAIN_SOURCE_ID, exaggeration: 1.0 };
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
  let currentMode = ""; // "hillshade", "normal", "avalanche", "slope", "aspect", "snow", "shadow", or "daylight"
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
  let shadowMaxOpacity = 0.6;
  let shadowRayStepMultiplier = 1.0;
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

  const gradientParameters = {
    baseDistance: 0.35,
    minDistance: MIN_GRADIENT_DISTANCE,
    maxDistance: 3.0
  };
  let samplingDistance = gradientParameters.baseDistance;
  let isSamplingDistanceManual = false;
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

  const gradientPreparer = TerrainGradientPreparer.create();
  const EARTH_CIRCUMFERENCE_METERS = 40075016.68557849;
  const MIN_METERS_PER_PIXEL = 1e-6;

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
    const scaled = baseDistance * Math.pow(2, GRADIENT_ZOOM_PIVOT - effectiveZoom);
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
      if (map && (currentMode === "shadow" || currentMode === "daylight")) map.triggerRepaint();
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
      if (map && (currentMode === "shadow" || currentMode === "daylight")) map.triggerRepaint();
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
    refreshDebugPanel();
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
      if (map && currentMode === "snow") map.triggerRepaint();
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
        return `custom/${currentMode || 'idle'}`;
      }
      if (hillshadeMode === 'native') {
        return 'native hillshade';
      }
      return hillshadeMode || 'none';
    })();

    lines.push(`Mode: ${modeLabel}`);

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

  const triggerShadowRepaint = () => {
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

  function ensureCustomTerrainLayer() {
    if (!canModifyStyle()) return;
    if (map.getLayer('terrain-normal')) return;
    terrainNormalLayer.frameCount = 0;
    map.addLayer(terrainNormalLayer);
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
    map.addLayer(layerDefinition);
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

  function enableCustomHillshade(mode) {
    const styleReady = canModifyStyle();
    const nextMode = mode || lastCustomMode || 'hillshade';
    lastCustomMode = nextMode;
    currentMode = nextMode;
    hillshadeMode = 'custom';
    if (styleReady) {
      removeNativeHillshadeLayer();
      ensureCustomTerrainLayer();
    }
    terrainNormalLayer.shaderMap.clear();
    updateButtons();
    if (styleReady && map) {
      map.triggerRepaint();
    }
  }

  function disableCustomHillshade() {
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
  }

  function setNativeHillshadeEnabled(enabled) {
    const styleReady = canModifyStyle();
    if (enabled) {
      if (styleReady) {
        removeCustomTerrainLayer();
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
    
    onAdd(mapInstance, gl) {
      this.map = mapInstance;
      this.gl = gl;
      this.frameCount = 0;
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
  
    renderTiles(gl, shader, renderableTiles, terrainInterface, tileManager, terrainDataCache, textureCache, nativeGradientCache = null, debugMetrics = null) {
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

        let neighborTextures = null;
        if (terrainData.texture && shader.locations.u_image != null) {
          bindTexture(terrainData.texture, 0, 'u_image');
          if (currentMode === "shadow" || currentMode === "daylight") {
            neighborTextures = [];
            NEIGHBOR_OFFSETS.forEach((neighbor, index) => {
              const texture = getNeighborTexture(
                tile.tileID,
                neighbor.dx,
                neighbor.dy,
                terrainData.texture
              );
              neighborTextures.push(texture);
              bindTexture(texture, index + 1, neighbor.uniform);
            });
          }
        } else if (currentMode === "shadow" || currentMode === "daylight") {
          neighborTextures = [];
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
        const metersPerPixel = computeMetersPerPixelForTile(canonical, tileSize);
        if (shader.locations.u_metersPerPixel != null) {
          gl.uniform1f(shader.locations.u_metersPerPixel, metersPerPixel);
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

        gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, 0);
        renderedCount++;
        if (debugMetrics) {
          debugMetrics.drawnTiles = (debugMetrics.drawnTiles || 0) + 1;
        }
      }

      if (DEBUG && (renderedCount > 0 || skippedCount > 0)) {
        console.log(`Rendered ${renderedCount} tiles, skipped ${skippedCount} tiles`);
      }
      if (debugMetrics) {
        debugMetrics.skippedTiles = (debugMetrics.skippedTiles || 0) + skippedCount;
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
        publishRenderDebugInfo({
          debugMetrics: { totalTiles: 0, drawnTiles: 0, skippedTiles: 0, passes: 0 },
          renderableTileCount: 0,
          terrainDataCount: 0,
          textureCacheCount: 0,
          nativeGradientTiles: 0,
          samplingDistance,
          isSamplingDistanceManual,
          neighborSamplingActive: currentMode === "shadow" || currentMode === "daylight",
          hillshadeMode,
          currentMode,
          gradientDebug: typeof gradientPreparer.getDebugInfo === 'function' ? gradientPreparer.getDebugInfo() : null
        });
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

      gradientPreparer.prepare({
        gl,
        renderableTiles,
        tileManager,
        terrainInterface,
        terrainDataCache,
        textureCache,
        neighborOffsets: NEIGHBOR_OFFSETS,
        samplingDistance
      });

      const shader = this.getShader(gl, matrix.shaderData);
      if (!shader) return;
      gl.useProgram(shader.program);

      const debugMetrics = {
        totalTiles: renderableTiles.length,
        drawnTiles: 0,
        skippedTiles: 0,
        passes: 0
      };

      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.enable(gl.DEPTH_TEST);

      if (currentMode === "snow" || currentMode === "slope") {
        gl.depthFunc(gl.LESS);
        gl.colorMask(false, false, false, false);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        this.renderTiles(gl, shader, renderableTiles, terrainInterface, tileManager, terrainDataCache, textureCache, nativeGradientCache, debugMetrics);

        gl.colorMask(true, true, true, true);
        gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(
          gl.SRC_ALPHA,
          gl.ONE_MINUS_SRC_ALPHA,
          gl.ONE,
          gl.ONE_MINUS_SRC_ALPHA
        );
        this.renderTiles(gl, shader, renderableTiles, terrainInterface, tileManager, terrainDataCache, textureCache, nativeGradientCache, debugMetrics);
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
        this.renderTiles(gl, shader, renderableTiles, terrainInterface, tileManager, terrainDataCache, textureCache, nativeGradientCache, debugMetrics);
      }

      gl.disable(gl.BLEND);

      const gradientDebug = typeof gradientPreparer.getDebugInfo === 'function'
        ? gradientPreparer.getDebugInfo()
        : null;
      publishRenderDebugInfo({
        debugMetrics,
        renderableTileCount: renderableTiles.length,
        terrainDataCount: terrainDataCache.size,
        textureCacheCount: textureCache.size,
        nativeGradientTiles: nativeGradientCache ? nativeGradientCache.size : 0,
        samplingDistance,
        isSamplingDistanceManual,
        neighborSamplingActive: currentMode === "shadow" || currentMode === "daylight",
        hillshadeMode,
        currentMode,
        gradientDebug
      });
    }
  };
  
  // Map setup and initialization.
  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
      sources: {
        swisstopo: {
          type: 'raster',
          tileSize: 256,
          tiles: ['https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg'],
          attribution: '© Swisstopo',
          maxzoom: 19
        },
        [TERRAIN_SOURCE_ID]: {
          type: 'raster-dem',
          tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'],
          tileSize: 512,
          maxzoom: 17,
          encoding: 'terrarium'
        }
      },
      layers: [
        { id: 'swisstopo', type: 'raster', source: 'swisstopo', paint: {'raster-opacity': 1.0} }
      ],
      terrain: { source: TERRAIN_SOURCE_ID, exaggeration: 1.0 },
      background: { paint: { "background-color": "#ffffff" } }
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

  map.on('render', () => {
    refreshDebugPanel();
  });

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
    if (HillshadeDebug && typeof HillshadeDebug.attachToMap === 'function') {
      HillshadeDebug.attachToMap(map, {
        layerId: hillshadeMode === 'native' ? HILLSHADE_NATIVE_LAYER_ID : null,
        sourceId: TERRAIN_SOURCE_ID
      });
    }
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
    gradientPreparer.invalidateAll();
    terrainNormalLayer.shaderMap.clear();
    if (sunlightEngine && typeof sunlightEngine.invalidateAll === 'function') {
      sunlightEngine.invalidateAll();
    }
    if (map.getLayer('terrain-normal')) {
      terrainNormalLayer.frameCount = 0;
      map.triggerRepaint();
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

  window.addEventListener('unload', () => {
    meshCache.clear();
    if (sunlightEngine && typeof sunlightEngine.destroy === 'function') {
      sunlightEngine.destroy();
    }
  });

})();
