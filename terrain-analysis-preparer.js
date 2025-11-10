/* terrain-analysis-preparer.js */
const TerrainAnalysisPreparer = (function() {
  const ANALYSIS_MAX_NEIGHBOR_OFFSET = 2;
  const DAYLIGHT_SAMPLE_CAP = 16;
  const EARTH_CIRCUMFERENCE_METERS = 40075016.68557849;
  const MIN_METERS_PER_PIXEL = 1e-6;
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
    if (value === 0) return '0';
    const prefix = value < 0 ? 'm' : 'p';
    return `${prefix}${Math.abs(value)}`;
  }

  function uniformNameForOffset(dx, dy) {
    const key = `${dx},${dy}`;
    if (NEIGHBOR_NAME_OVERRIDES[key]) {
      return NEIGHBOR_NAME_OVERRIDES[key];
    }
    return `u_image_${formatOffsetPart(dx)}_${formatOffsetPart(dy)}`;
  }

  function buildNeighborOffsets(maxOffset) {
    const offsets = [];
    for (let dy = -maxOffset; dy <= maxOffset; dy++) {
      for (let dx = -maxOffset; dx <= maxOffset; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (Math.abs(dx) + Math.abs(dy) > maxOffset) continue;
        offsets.push({ dx, dy, uniform: uniformNameForOffset(dx, dy) });
      }
    }
    return offsets;
  }

  const NEIGHBOR_OFFSETS = buildNeighborOffsets(ANALYSIS_MAX_NEIGHBOR_OFFSET);
  const NEIGHBOR_UNIFORM_DECLARATIONS = NEIGHBOR_OFFSETS
    .map(({ uniform }) => `uniform sampler2D ${uniform};`)
    .join('\n');
  const NEIGHBOR_UNIFORM_BLOCK = NEIGHBOR_UNIFORM_DECLARATIONS
    ? `${NEIGHBOR_UNIFORM_DECLARATIONS}\n`
    : '';
  const NEIGHBOR_FETCH_CASES = NEIGHBOR_OFFSETS
    .map(({ dx, dy, uniform }) => `  if (offset == ivec2(${dx}, ${dy})) return getElevationFromTexture(${uniform}, tilePos);`)
    .join('\n');
  const NEIGHBOR_FETCH_BLOCK = NEIGHBOR_FETCH_CASES
    ? `\n${NEIGHBOR_FETCH_CASES}\n`
    : '';

  function detectFloatFramebufferFormat(gl) {
    const candidates = [
      { internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT },
      { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT }
    ];

    const framebuffer = gl.createFramebuffer();
    const texture = gl.createTexture();
    if (!framebuffer || !texture) {
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      if (texture) gl.deleteTexture(texture);
      return null;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    let selected = null;
    for (const candidate of candidates) {
      try {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          candidate.internalFormat,
          1,
          1,
          0,
          candidate.format,
          candidate.type,
          null
        );
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          texture,
          0
        );
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status === gl.FRAMEBUFFER_COMPLETE) {
          selected = candidate;
          break;
        }
      } catch (error) {
        selected = null;
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    return selected;
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

  function buildShadowFragmentShader() {
    return `#version 300 es
precision highp float;
precision highp int;
${TerrainShaders.commonFunctions}
uniform vec2  u_sunDirection;
uniform float u_sunAltitude;
uniform vec3  u_sunWarmColor;
uniform float u_sunWarmIntensity;
uniform int   u_shadowSampleCount;
uniform float u_shadowBlurRadius;
uniform float u_shadowMaxDistance;
uniform float u_shadowVisibilityThreshold;
uniform float u_shadowEdgeSoftness;
uniform float u_shadowMaxOpacity;
uniform float u_shadowRayStepMultiplier;
in  highp vec2 v_texCoord;
out vec4 fragColor;

const int MAX_SHADOW_STEPS = 512;
const int MAX_SHADOW_SAMPLES = 64;

float traceShadowRay(vec2 startPos, float currentElevation, vec2 texelStep, float metersPerPixel, float sunSlope) {
  if (u_shadowMaxDistance <= 0.0) {
    return 1.0;
  }
  float threshold = max(u_shadowVisibilityThreshold, 0.0);
  float softness = max(u_shadowEdgeSoftness, 0.0);
  float stepMultiplier = max(u_shadowRayStepMultiplier, 0.1);
  vec2 baseTexelStep = texelStep / stepMultiplier;
  float baseStepDistance = metersPerPixel / stepMultiplier;
  float maxSlope = -1e6;
  vec2 samplePos = startPos;
  float minBound = -${ANALYSIS_MAX_NEIGHBOR_OFFSET}.0;
  float maxBound = 1.0 + ${ANALYSIS_MAX_NEIGHBOR_OFFSET}.0;
  float stepFactor = 1.0;
  float traveled = 0.0;
  for (int i = 0; i < MAX_SHADOW_STEPS; ++i) {
    float nextDistance = traveled + baseStepDistance * stepFactor;
    if (nextDistance > u_shadowMaxDistance) {
      break;
    }
    samplePos += baseTexelStep * stepFactor;
    if (samplePos.x < minBound || samplePos.x > maxBound || samplePos.y < minBound || samplePos.y > maxBound) {
      break;
    }
    traveled = nextDistance;
    if (traveled <= 0.0) {
      continue;
    }
    float sampleElevation = sampleElevationAdaptive(samplePos, traveled, metersPerPixel);
    float slope = (sampleElevation - currentElevation) / traveled;
    maxSlope = max(maxSlope, slope);
    if (maxSlope >= sunSlope - threshold) {
      float visibilityNow = sunSlope - maxSlope;
      if (softness <= 0.0001) {
        return visibilityNow > threshold ? 1.0 : 0.0;
      }
      return smoothstep(threshold, threshold + softness, visibilityNow);
    }
    float growth = computeAdaptiveStepGrowth(traveled);
    stepFactor = min(stepFactor * growth, 64.0);
  }
  float visibility = sunSlope - maxSlope;
  if (softness <= 0.0001) {
    return visibility > threshold ? 1.0 : 0.0;
  }
  return smoothstep(threshold, threshold + softness, visibility);
}

float computeSunVisibility(vec2 pos, float currentElevation) {
  if (u_sunAltitude <= 0.0) {
    return 0.0;
  }

  vec2 horizontalDir = normalize(u_sunDirection);
  if (length(horizontalDir) < 1e-5) {
    return 1.0;
  }

  float tileResolution = u_dimension.x;
  vec2 texelStep = horizontalDir / tileResolution;
  float metersPerPixel = max(u_metersPerPixel, 0.0001);
  float clampedAltitude = clamp(u_sunAltitude, -1.55334306, 1.55334306);
  float sunSlope = tan(clampedAltitude);

  vec2 perpendicular = vec2(-horizontalDir.y, horizontalDir.x);
  int sampleCount = clamp(u_shadowSampleCount, 1, MAX_SHADOW_SAMPLES);
  float radius = max(u_shadowBlurRadius, 0.0);
  if (radius <= 0.0) {
    sampleCount = 1;
  }
  float visibility = 0.0;
  float weightSum = 0.0;
  for (int i = 0; i < MAX_SHADOW_SAMPLES; ++i) {
    if (i >= sampleCount) {
      break;
    }
    float idx = float(i) - 0.5 * float(sampleCount - 1);
    float normalized = (sampleCount == 1) ? 0.0 : idx / float(sampleCount - 1);
    float offsetAmount = (sampleCount == 1 || radius <= 0.0) ? 0.0 : normalized * radius;
    vec2 offsetPos = pos + perpendicular * (offsetAmount / tileResolution);
    float sigma = max(radius * 0.5, 0.0001);
    float weight = (radius <= 0.0 || sampleCount == 1) ? 1.0 : exp(-0.5 * pow(offsetAmount / sigma, 2.0));
    visibility += weight * traceShadowRay(offsetPos, currentElevation, texelStep, metersPerPixel, sunSlope);
    weightSum += weight;
  }
  if (weightSum > 0.0) {
    visibility /= weightSum;
  }
  return visibility;
}

void main(){
  vec2 uv = clampTexCoord(v_texCoord);
  float elevation = getElevationExtended(uv);
  float visibility = computeSunVisibility(uv, elevation);
  vec2 grad = computeSobelGradient(uv);
  vec3 normal = normalize(vec3(-grad, 1.0));
  float cosAltitude = cos(u_sunAltitude);
  vec3 sunDir = normalize(vec3(u_sunDirection * cosAltitude, sin(u_sunAltitude)));
  float lambert = max(dot(normal, sunDir), 0.0);
  float selfShadow = 1.0 - lambert;
  float castShadow = 1.0 - visibility;
  float combinedShadow = clamp(castShadow + (1.0 - castShadow) * selfShadow, 0.0, 1.0);
  float maxOpacity = clamp(u_shadowMaxOpacity, 0.0, 1.0);
  float shadowIntensity = clamp(combinedShadow * maxOpacity, 0.0, 1.0);
  float baseBrightness = mix(1.0, 0.25, shadowIntensity);
  float warmMix = clamp(u_sunWarmIntensity, 0.0, 1.0) * shadowIntensity;
  vec3 warmTint = mix(vec3(1.0), clamp(u_sunWarmColor, 0.0, 1.0), warmMix);
  vec3 finalColor = baseBrightness * warmTint;
  fragColor = vec4(finalColor, 1.0);
}`;
  }

  function buildDaylightFragmentShader() {
    return `#version 300 es
precision highp float;
precision highp int;
${TerrainShaders.commonFunctions}
uniform int   u_daylightSampleCount;
uniform vec2  u_daylightSunDir[${DAYLIGHT_SAMPLE_CAP}];
uniform float u_daylightSunAltitude[${DAYLIGHT_SAMPLE_CAP}];
uniform float u_daylightSampleWeight[${DAYLIGHT_SAMPLE_CAP}];
uniform float u_daylightSampleTime[${DAYLIGHT_SAMPLE_CAP}];
uniform int   u_shadowSampleCount;
uniform float u_shadowBlurRadius;
uniform float u_shadowMaxDistance;
uniform float u_shadowVisibilityThreshold;
uniform float u_shadowEdgeSoftness;
uniform float u_shadowRayStepMultiplier;
in  highp vec2 v_texCoord;
out vec4 fragColor;

const int MAX_DAYLIGHT_STEPS = 320;
const int MAX_DAYLIGHT_KERNEL_SAMPLES = 32;
const int MAX_DAYLIGHT_SAMPLES = ${DAYLIGHT_SAMPLE_CAP};

float traceDaylightRay(vec2 startPos, float currentElevation, vec2 texelStep, float metersPerPixel, float sunSlope) {
  if (u_shadowMaxDistance <= 0.0) {
    return 1.0;
  }
  float threshold = max(u_shadowVisibilityThreshold, 0.0);
  float softness = max(u_shadowEdgeSoftness, 0.0);
  float stepMultiplier = max(u_shadowRayStepMultiplier, 0.1);
  vec2 baseTexelStep = texelStep / stepMultiplier;
  float baseStepDistance = metersPerPixel / stepMultiplier;
  float maxSlope = -1e6;
  vec2 samplePos = startPos;
  float minBound = -${ANALYSIS_MAX_NEIGHBOR_OFFSET}.0;
  float maxBound = 1.0 + ${ANALYSIS_MAX_NEIGHBOR_OFFSET}.0;
  float stepFactor = 1.0;
  float traveled = 0.0;
  for (int i = 0; i < MAX_DAYLIGHT_STEPS; ++i) {
    float nextDistance = traveled + baseStepDistance * stepFactor;
    if (nextDistance > u_shadowMaxDistance) {
      break;
    }
    samplePos += baseTexelStep * stepFactor;
    if (samplePos.x < minBound || samplePos.x > maxBound || samplePos.y < minBound || samplePos.y > maxBound) {
      break;
    }
    traveled = nextDistance;
    if (traveled <= 0.0) {
      continue;
    }
    float sampleElevation = sampleElevationAdaptive(samplePos, traveled, metersPerPixel);
    float slope = (sampleElevation - currentElevation) / traveled;
    maxSlope = max(maxSlope, slope);
    if (maxSlope >= sunSlope - threshold) {
      float visibilityNow = sunSlope - maxSlope;
      if (softness <= 0.0001) {
        return visibilityNow > threshold ? 1.0 : 0.0;
      }
      return smoothstep(threshold, threshold + softness, visibilityNow);
    }
    float growth = computeAdaptiveStepGrowth(traveled);
    stepFactor = min(stepFactor * growth, 64.0);
  }
  float visibility = sunSlope - maxSlope;
  if (softness <= 0.0001) {
    return visibility > threshold ? 1.0 : 0.0;
  }
  return smoothstep(threshold, threshold + softness, visibility);
}

float computeDaylightVisibility(vec2 pos, float currentElevation, vec2 horizontalDir, float sunAltitude) {
  if (sunAltitude <= 0.0) {
    return 0.0;
  }

  vec2 dir = normalize(horizontalDir);
  if (length(dir) < 1e-5) {
    return 1.0;
  }

  float tileResolution = u_dimension.x;
  vec2 texelStep = dir / tileResolution;
  float metersPerPixel = max(u_metersPerPixel, 0.0001);
  float clampedAltitude = clamp(sunAltitude, -1.55334306, 1.55334306);
  float sunSlope = tan(clampedAltitude);

  vec2 perpendicular = vec2(-dir.y, dir.x);
  int sampleCount = clamp(u_shadowSampleCount, 1, MAX_DAYLIGHT_KERNEL_SAMPLES);
  float radius = max(u_shadowBlurRadius, 0.0);
  if (radius <= 0.0) {
    sampleCount = 1;
  }
  float visibility = 0.0;
  float weightSum = 0.0;
  for (int i = 0; i < MAX_DAYLIGHT_KERNEL_SAMPLES; ++i) {
    if (i >= sampleCount) {
      break;
    }
    float idx = float(i) - 0.5 * float(sampleCount - 1);
    float normalized = (sampleCount == 1) ? 0.0 : idx / float(sampleCount - 1);
    float offsetAmount = (sampleCount == 1 || radius <= 0.0) ? 0.0 : normalized * radius;
    vec2 offsetPos = pos + perpendicular * (offsetAmount / tileResolution);
    float sigma = max(radius * 0.5, 0.0001);
    float weight = (radius <= 0.0 || sampleCount == 1) ? 1.0 : exp(-0.5 * pow(offsetAmount / sigma, 2.0));
    visibility += weight * traceDaylightRay(offsetPos, currentElevation, texelStep, metersPerPixel, sunSlope);
    weightSum += weight;
  }
  if (weightSum > 0.0) {
    visibility /= weightSum;
  }
  return visibility;
}

vec3 getSunExposureColor(float durationRatio, float sunriseRatio) {
  vec3 cold = vec3(0.1, 0.2, 0.7);
  vec3 warm = vec3(0.94, 0.35, 0.2);
  vec3 base = mix(cold, warm, clamp(durationRatio, 0.0, 1.0));
  float brightness = mix(0.45, 1.0, clamp(1.0 - sunriseRatio, 0.0, 1.0));
  return clamp(base * brightness, 0.0, 1.0);
}

void main() {
  vec2 uv = clampTexCoord(v_texCoord);
  float elevation = getElevationExtended(uv);
  float totalWeight = 0.0;
  float litWeight = 0.0;
  float firstLitTime = -1.0;
  for (int i = 0; i < MAX_DAYLIGHT_SAMPLES; ++i) {
    if (i >= u_daylightSampleCount) {
      break;
    }
    float weight = max(u_daylightSampleWeight[i], 0.0);
    if (weight <= 0.0) {
      continue;
    }
    float altitude = u_daylightSunAltitude[i];
    if (altitude <= 0.0) {
      continue;
    }
    vec2 sunDir = u_daylightSunDir[i];
    float visibility = computeDaylightVisibility(uv, elevation, sunDir, altitude);
    totalWeight += weight;
    litWeight += weight * visibility;
    if (firstLitTime < 0.0 && visibility > 0.5) {
      firstLitTime = clamp(u_daylightSampleTime[i], 0.0, 1.0);
    }
  }
  float durationRatio = totalWeight > 0.0 ? clamp(litWeight / max(totalWeight, 1e-4), 0.0, 1.0) : 0.0;
  float sunriseRatio = firstLitTime >= 0.0 ? firstLitTime : 1.0;
  vec3 color = getSunExposureColor(durationRatio, sunriseRatio);
  fragColor = vec4(color, 0.85);
}`;
  }

  class AnalysisPreparer {
    constructor() {
      this.gl = null;
      this.programs = new Map();
      this.quadVbo = null;
      this.quadIbo = null;
      this.supported = true;
      this.textureInternalFormat = null;
      this.textureFormat = null;
      this.textureType = null;
      this.tileStates = new Map();
      this.invalidateVersion = 0;
    }

    createShader(gl, type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Analysis shader compile error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    }

    createProgram(gl, vertexSource, fragmentSource) {
      const vertexShader = this.createShader(gl, gl.VERTEX_SHADER, vertexSource);
      if (!vertexShader) return null;
      const fragmentShader = this.createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
      if (!fragmentShader) {
        gl.deleteShader(vertexShader);
        return null;
      }
      const program = gl.createProgram();
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Analysis program link error:', gl.getProgramInfoLog(program));
        gl.deleteProgram(program);
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
        return null;
      }
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      return program;
    }

    initialize(gl) {
      if (this.gl === gl && this.quadVbo && this.quadIbo) {
        return;
      }
      this.dispose(gl);
      this.gl = gl;

      const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
      if (!isWebGL2) {
        console.warn('TerrainAnalysisPreparer requires WebGL2.');
        this.supported = false;
        return;
      }
      const ext = gl.getExtension('EXT_color_buffer_float');
      if (!ext) {
        console.warn('TerrainAnalysisPreparer missing EXT_color_buffer_float; analysis precompute disabled.');
        this.supported = false;
        return;
      }
      const floatFormat = detectFloatFramebufferFormat(gl);
      if (!floatFormat) {
        console.warn('TerrainAnalysisPreparer could not determine a compatible float framebuffer format.');
        this.supported = false;
        return;
      }
      this.supported = true;
      this.textureInternalFormat = floatFormat.internalFormat;
      this.textureFormat = floatFormat.format;
      this.textureType = floatFormat.type;

      const vertexSource = `#version 300 es\n`
        + `precision highp float;\n`
        + `in vec2 a_pos;\n`
        + `out vec2 v_texCoord;\n`
        + `void main() {\n`
        + `  v_texCoord = 0.5 * (a_pos + 1.0);\n`
        + `  gl_Position = vec4(a_pos, 0.0, 1.0);\n`
        + `}`;

      this.quadVbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1.0, -1.0,
         1.0, -1.0,
         1.0,  1.0,
        -1.0,  1.0
      ]), gl.STATIC_DRAW);

      this.quadIbo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIbo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);

      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

      this.vertexSource = vertexSource;
    }

    dispose(gl) {
      if (!gl) return;
      this.programs.forEach(programInfo => {
        if (programInfo && programInfo.program) {
          gl.deleteProgram(programInfo.program);
        }
      });
      this.programs.clear();
      if (this.quadVbo) {
        gl.deleteBuffer(this.quadVbo);
        this.quadVbo = null;
      }
      if (this.quadIbo) {
        gl.deleteBuffer(this.quadIbo);
        this.quadIbo = null;
      }
      for (const state of this.tileStates.values()) {
        if (state.texture) gl.deleteTexture(state.texture);
        if (state.framebuffer) gl.deleteFramebuffer(state.framebuffer);
      }
      this.tileStates.clear();
    }

    invalidateAll() {
      this.invalidateVersion++;
    }

    getProgram(gl, mode) {
      if (!mode) return null;
      if (this.programs.has(mode)) {
        return this.programs.get(mode);
      }

      const fragmentSource = mode === 'shadow'
        ? buildShadowFragmentShader()
        : buildDaylightFragmentShader();
      const program = this.createProgram(gl, this.vertexSource, fragmentSource);
      if (!program) {
        return null;
      }

      const neighborUniforms = NEIGHBOR_OFFSETS.map(offset => offset.uniform);
      const uniformNames = [
        'u_image',
        ...neighborUniforms,
        'u_gradient',
        'u_usePrecomputedGradient',
        'u_terrain_unpack',
        'u_dimension',
        'u_zoom',
        'u_samplingDistance',
        'u_metersPerPixel',
        'u_latrange'
      ];
      if (mode === 'shadow') {
        uniformNames.push(
          'u_sunDirection',
          'u_sunAltitude',
          'u_sunWarmColor',
          'u_sunWarmIntensity',
          'u_shadowSampleCount',
          'u_shadowBlurRadius',
          'u_shadowMaxDistance',
          'u_shadowVisibilityThreshold',
          'u_shadowEdgeSoftness',
          'u_shadowMaxOpacity',
          'u_shadowRayStepMultiplier'
        );
      } else {
        uniformNames.push(
          'u_daylightSampleCount',
          'u_daylightSunDir[0]',
          'u_daylightSunAltitude[0]',
          'u_daylightSampleWeight[0]',
          'u_daylightSampleTime[0]',
          'u_shadowSampleCount',
          'u_shadowBlurRadius',
          'u_shadowMaxDistance',
          'u_shadowVisibilityThreshold',
          'u_shadowEdgeSoftness',
          'u_shadowRayStepMultiplier'
        );
      }

      const uniforms = {};
      uniformNames.forEach(name => {
        uniforms[name] = gl.getUniformLocation(program, name);
      });
      const attributes = {
        a_pos: gl.getAttribLocation(program, 'a_pos')
      };
      const info = { program, uniforms, attributes };
      this.programs.set(mode, info);
      return info;
    }

    getTexture(tileKey) {
      const state = this.tileStates.get(tileKey);
      return state && state.texture ? state.texture : null;
    }

    ensureTileResources(gl, state, size) {
      if (!state.texture) {
        state.texture = gl.createTexture();
      }
      gl.bindTexture(gl.TEXTURE_2D, state.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const internalFormat = this.textureInternalFormat || gl.RGBA16F;
      const format = this.textureFormat || gl.RGBA;
      const type = this.textureType || gl.HALF_FLOAT;
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, size, size, 0, format, type, null);

      if (!state.framebuffer) {
        state.framebuffer = gl.createFramebuffer();
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, state.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, state.texture, 0);
    }

    bindInputTexture(gl, unit, texture, location, filter = null) {
      if (!texture || location === null) return;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      const minFilter = filter || gl.LINEAR;
      const magFilter = filter || gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(location, unit);
    }

    getNeighborCacheKey(tileID, offset) {
      if (!tileID || !tileID.canonical) return null;
      const canonical = tileID.canonical;
      const dim = Math.pow(2, canonical.z);

      let nx = canonical.x + offset.dx;
      let ny = canonical.y + offset.dy;
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

    prepare(options) {
      const {
        gl,
        mode,
        renderableTiles,
        tileManager,
        terrainInterface,
        terrainDataCache,
        textureCache,
        neighborOffsets,
        samplingDistance,
        getGradientTexture,
        shadowSettings = {},
        sunParams = null,
        daylightParams = null
      } = options;

      if (!gl || !mode || !renderableTiles || renderableTiles.length === 0) {
        return;
      }

      this.initialize(gl);
      if (!this.supported) {
        return;
      }

      const programInfo = this.getProgram(gl, mode);
      if (!programInfo) {
        return;
      }

      const activeKeys = new Set();
      const rgbaFactors = { r: 256.0, g: 1.0, b: 1.0 / 256.0, base: 32768.0 };
      const prevFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      const prevViewport = gl.getParameter(gl.VIEWPORT);
      const blendEnabled = gl.isEnabled(gl.BLEND);
      const depthEnabled = gl.isEnabled(gl.DEPTH_TEST);
      const cullEnabled = gl.isEnabled(gl.CULL_FACE);

      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);

      gl.useProgram(programInfo.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
      gl.enableVertexAttribArray(programInfo.attributes.a_pos);
      gl.vertexAttribPointer(programInfo.attributes.a_pos, 2, gl.FLOAT, false, 8, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIbo);

      const gradientTextureUnit = neighborOffsets.length + 1;

      for (const tile of renderableTiles) {
        const sourceTile = tileManager.getSourceTile(tile.tileID, true);
        if (!sourceTile) continue;
        const tileKey = tile.tileID.key;
        activeKeys.add(tileKey);

        const terrainData = terrainDataCache.get(tile.tileID.key) || (terrainInterface && terrainInterface.getTerrainData ? terrainInterface.getTerrainData(tile.tileID) : null);
        if (!terrainData || !terrainData.texture) continue;

        const dem = sourceTile.dem;
        const tileSize = dem && dem.dim ? dem.dim : (terrainInterface && terrainInterface.tileManager && terrainInterface.tileManager.tileSize ? terrainInterface.tileManager.tileSize : 512);
        const demUid = dem && typeof dem.uid !== 'undefined' ? dem.uid : null;
        const canonical = tile.tileID.canonical;

        const stateKey = tileKey;
        let state = this.tileStates.get(stateKey);
        if (!state) {
          state = { texture: null, framebuffer: null, signature: null, size: null };
          this.tileStates.set(stateKey, state);
        }

        const parameterSignature = (() => {
          if (mode === 'shadow') {
            const warm = sunParams && sunParams.warmColor ? sunParams.warmColor : [0, 0, 0];
            return [
              samplingDistance,
              shadowSettings.sampleCount,
              shadowSettings.blurRadius,
              shadowSettings.maxDistance,
              shadowSettings.visibilityThreshold,
              shadowSettings.edgeSoftness,
              shadowSettings.maxOpacity,
              shadowSettings.rayStepMultiplier,
              sunParams ? sunParams.dirX : 0,
              sunParams ? sunParams.dirY : 0,
              sunParams ? sunParams.altitude : 0,
              warm[0], warm[1], warm[2],
              sunParams ? sunParams.warmIntensity : 0,
              demUid,
              tileSize,
              terrainData && terrainData.fallback ? 1 : 0,
              this.invalidateVersion
            ].map(v => Number(v || 0).toFixed(6)).join(',');
          }
          const params = daylightParams || {};
          const weightSig = params.sampleWeights ? Array.from(params.sampleWeights.slice(0, params.sampleCount)).map(v => Number(v || 0).toFixed(6)).join('|') : '';
          const timeSig = params.sampleTimes ? Array.from(params.sampleTimes.slice(0, params.sampleCount)).map(v => Number(v || 0).toFixed(6)).join('|') : '';
          const dirSig = params.sunDirections ? Array.from(params.sunDirections.slice(0, params.sampleCount * 2)).map(v => Number(v || 0).toFixed(6)).join('|') : '';
          const altSig = params.sunAltitudes ? Array.from(params.sunAltitudes.slice(0, params.sampleCount)).map(v => Number(v || 0).toFixed(6)).join('|') : '';
          return [
            samplingDistance,
            shadowSettings.sampleCount,
            shadowSettings.blurRadius,
            shadowSettings.maxDistance,
            shadowSettings.visibilityThreshold,
            shadowSettings.edgeSoftness,
            shadowSettings.rayStepMultiplier,
            params.sampleCount || 0,
            dirSig,
            altSig,
            weightSig,
            timeSig,
            demUid,
            tileSize,
            terrainData && terrainData.fallback ? 1 : 0,
            this.invalidateVersion
          ].join('::');
        })();

        const needsUpdate = !state.texture
          || state.size !== tileSize
          || state.signature !== parameterSignature;

        if (!needsUpdate) {
          continue;
        }

        this.ensureTileResources(gl, state, tileSize);
        gl.viewport(0, 0, tileSize, tileSize);

        const neighborTextures = neighborOffsets.map(offset => {
          const neighborKey = this.getNeighborCacheKey(tile.tileID, offset);
          if (!neighborKey) {
            return terrainData.texture;
          }
          const texture = textureCache.get(neighborKey);
          if (!texture) {
            return terrainData.texture;
          }
          return texture;
        });

        this.bindInputTexture(gl, 0, terrainData.texture, programInfo.uniforms.u_image);
        neighborOffsets.forEach((offset, index) => {
          const location = programInfo.uniforms[offset.uniform] || null;
          this.bindInputTexture(gl, index + 1, neighborTextures[index], location);
        });

        const gradientTexture = typeof getGradientTexture === 'function'
          ? getGradientTexture(tile.tileID.key)
          : null;
        if (programInfo.uniforms.u_gradient) {
          if (gradientTexture) {
            this.bindInputTexture(gl, gradientTextureUnit, gradientTexture, programInfo.uniforms.u_gradient, gl.NEAREST);
            if (programInfo.uniforms.u_usePrecomputedGradient != null) {
              gl.uniform1i(programInfo.uniforms.u_usePrecomputedGradient, 1);
            }
          } else {
            gl.activeTexture(gl.TEXTURE0 + gradientTextureUnit);
            gl.bindTexture(gl.TEXTURE_2D, null);
            if (programInfo.uniforms.u_usePrecomputedGradient != null) {
              gl.uniform1i(programInfo.uniforms.u_usePrecomputedGradient, 0);
            }
          }
        }

        if (programInfo.uniforms.u_terrain_unpack) {
          gl.uniform4f(programInfo.uniforms.u_terrain_unpack, rgbaFactors.r, rgbaFactors.g, rgbaFactors.b, rgbaFactors.base);
        }
        if (programInfo.uniforms.u_dimension) {
          gl.uniform2f(programInfo.uniforms.u_dimension, tileSize, tileSize);
        }
        if (programInfo.uniforms.u_zoom) {
          gl.uniform1f(programInfo.uniforms.u_zoom, canonical.z);
        }
        if (programInfo.uniforms.u_samplingDistance) {
          gl.uniform1f(programInfo.uniforms.u_samplingDistance, samplingDistance);
        }
        if (programInfo.uniforms.u_metersPerPixel) {
          const metersPerPixel = computeMetersPerPixelForTile(canonical, tileSize);
          gl.uniform1f(programInfo.uniforms.u_metersPerPixel, metersPerPixel);
        }
        if (programInfo.uniforms.u_latrange) {
          gl.uniform2f(programInfo.uniforms.u_latrange, 0.0, 0.0);
        }

        if (mode === 'shadow') {
          if (programInfo.uniforms.u_sunDirection && sunParams) {
            gl.uniform2f(programInfo.uniforms.u_sunDirection, sunParams.dirX || 0, sunParams.dirY || 0);
          }
          if (programInfo.uniforms.u_sunAltitude && sunParams) {
            gl.uniform1f(programInfo.uniforms.u_sunAltitude, sunParams.altitude || 0);
          }
          if (programInfo.uniforms.u_sunWarmColor && sunParams && sunParams.warmColor) {
            gl.uniform3f(
              programInfo.uniforms.u_sunWarmColor,
              sunParams.warmColor[0] || 0,
              sunParams.warmColor[1] || 0,
              sunParams.warmColor[2] || 0
            );
          }
          if (programInfo.uniforms.u_sunWarmIntensity && sunParams) {
            gl.uniform1f(programInfo.uniforms.u_sunWarmIntensity, sunParams.warmIntensity || 0);
          }
        } else if (mode === 'daylight' && daylightParams) {
          if (programInfo.uniforms['u_daylightSampleCount']) {
            gl.uniform1i(programInfo.uniforms['u_daylightSampleCount'], daylightParams.sampleCount || 0);
          }
          if (programInfo.uniforms['u_daylightSunDir[0]']) {
            gl.uniform2fv(programInfo.uniforms['u_daylightSunDir[0]'], daylightParams.sunDirections || new Float32Array(DAYLIGHT_SAMPLE_CAP * 2));
          }
          if (programInfo.uniforms['u_daylightSunAltitude[0]']) {
            gl.uniform1fv(programInfo.uniforms['u_daylightSunAltitude[0]'], daylightParams.sunAltitudes || new Float32Array(DAYLIGHT_SAMPLE_CAP));
          }
          if (programInfo.uniforms['u_daylightSampleWeight[0]']) {
            gl.uniform1fv(programInfo.uniforms['u_daylightSampleWeight[0]'], daylightParams.sampleWeights || new Float32Array(DAYLIGHT_SAMPLE_CAP));
          }
          if (programInfo.uniforms['u_daylightSampleTime[0]']) {
            gl.uniform1fv(programInfo.uniforms['u_daylightSampleTime[0]'], daylightParams.sampleTimes || new Float32Array(DAYLIGHT_SAMPLE_CAP));
          }
        }

        if (programInfo.uniforms.u_shadowSampleCount != null) {
          gl.uniform1i(programInfo.uniforms.u_shadowSampleCount, Math.floor(shadowSettings.sampleCount || 1));
        }
        if (programInfo.uniforms.u_shadowBlurRadius != null) {
          gl.uniform1f(programInfo.uniforms.u_shadowBlurRadius, shadowSettings.blurRadius || 0);
        }
        if (programInfo.uniforms.u_shadowMaxDistance != null) {
          gl.uniform1f(programInfo.uniforms.u_shadowMaxDistance, shadowSettings.maxDistance || 0);
        }
        if (programInfo.uniforms.u_shadowVisibilityThreshold != null) {
          gl.uniform1f(programInfo.uniforms.u_shadowVisibilityThreshold, shadowSettings.visibilityThreshold || 0);
        }
        if (programInfo.uniforms.u_shadowEdgeSoftness != null) {
          gl.uniform1f(programInfo.uniforms.u_shadowEdgeSoftness, shadowSettings.edgeSoftness || 0);
        }
        if (programInfo.uniforms.u_shadowMaxOpacity != null) {
          gl.uniform1f(programInfo.uniforms.u_shadowMaxOpacity, shadowSettings.maxOpacity || 0);
        }
        if (programInfo.uniforms.u_shadowRayStepMultiplier != null) {
          gl.uniform1f(programInfo.uniforms.u_shadowRayStepMultiplier, shadowSettings.rayStepMultiplier || 1);
        }

        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);

        state.size = tileSize;
        state.signature = parameterSignature;
      }

      gl.disableVertexAttribArray(programInfo.attributes.a_pos);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
      gl.useProgram(null);
      gl.activeTexture(gl.TEXTURE0);

      if (blendEnabled) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
      if (depthEnabled) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
      if (cullEnabled) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);

      if (prevFramebuffer) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, prevFramebuffer);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      if (prevViewport) {
        gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
      }

      for (const [key, state] of this.tileStates.entries()) {
        if (!activeKeys.has(key)) {
          if (state.texture) gl.deleteTexture(state.texture);
          if (state.framebuffer) gl.deleteFramebuffer(state.framebuffer);
          this.tileStates.delete(key);
        }
      }
    }
  }

  return {
    create() {
      return new AnalysisPreparer();
    }
  };
})();
