/* h4-sunlight-engine.js */
(function () {
  const TWO_PI = Math.PI * 2;
  const DEG2RAD = Math.PI / 180;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function wrapAnglePositive(angle) {
    let result = angle % TWO_PI;
    if (result < 0) {
      result += TWO_PI;
    }
    return result;
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function makeSolarLUT(options) {
    const {
      lat,
      lon,
      date,
      minutesStep,
      azimuthCount,
      quantizationLevels,
      minElevation,
      maxElevation
    } = options;

    if (!date || typeof SunCalc === 'undefined' || typeof SunCalc.getPosition !== 'function') {
      return null;
    }

    const minutes = Math.max(1, Math.floor(minutesStep || 5));
    const azimuths = Math.max(1, azimuthCount || 32);
    const levels = Math.max(1, quantizationLevels || 32);

    const histogram = Array.from({ length: azimuths }, () => new Uint16Array(levels));

    const start = new Date(date.getTime());
    start.setHours(0, 0, 0, 0);
    const totalSteps = Math.ceil((24 * 60) / minutes);

    const elevationMin = minElevation;
    const elevationMax = maxElevation;
    const elevationRange = elevationMax - elevationMin;

    for (let step = 0; step < totalSteps; step++) {
      const sampleDate = new Date(start.getTime() + step * minutes * 60000);
      const position = SunCalc.getPosition(sampleDate, lat, lon);
      if (!position) continue;

      const altitude = position.altitude;
      if (!isFiniteNumber(altitude) || altitude <= elevationMin) {
        continue;
      }

      const altitudeClamped = clamp(altitude, elevationMin, elevationMax);
      const normalizedElevation = elevationRange > 0
        ? (altitudeClamped - elevationMin) / elevationRange
        : 0;
      const levelIndex = clamp(
        Math.floor(normalizedElevation * (levels - 1) + 0.5),
        0,
        levels - 1
      );

      // SunCalc azimuth is measured from south and positive westward.
      // Convert to 0..2pi from north, positive eastward.
      const azimuthNorthEast = wrapAnglePositive(position.azimuth + Math.PI);
      const azimuthIndex = clamp(
        Math.floor((azimuthNorthEast / TWO_PI) * azimuths),
        0,
        azimuths - 1
      );

      histogram[azimuthIndex][levelIndex] += 1;
    }

    const width = levels;
    const height = azimuths;
    const data = new Float32Array(width * height);
    let maxMinutes = 0;

    for (let az = 0; az < azimuths; az++) {
      const bins = histogram[az];
      let cumulative = 0;
      for (let level = levels - 1; level >= 0; level--) {
        cumulative += bins[level];
        const minutesAbove = cumulative * minutes;
        data[az * width + level] = minutesAbove;
        if (minutesAbove > maxMinutes) {
          maxMinutes = minutesAbove;
        }
      }
    }

    return {
      data,
      width,
      height,
      maxMinutes
    };
  }

  class H4SunlightEngine {
    constructor(options = {}) {
      this.azimuthCount = Math.max(1, options.azimuthCount || 32);
      this.quantizationLevels = Math.max(2, options.quantizationLevels || 64);
      this.angleMin = isFiniteNumber(options.angleMin) ? options.angleMin : (-2 * DEG2RAD);
      this.angleMax = isFiniteNumber(options.angleMax) ? options.angleMax : (90 * DEG2RAD);
      this.minutesStep = Math.max(1, options.minutesStep || 5);
      this.tileResources = new Map();
      this.azimuthAngles = new Float32Array(this.azimuthCount);
      for (let i = 0; i < this.azimuthCount; i++) {
        this.azimuthAngles[i] = (i / this.azimuthCount) * TWO_PI;
      }
      this.lutTexture = null;
      this.lutInfo = null;
      this.gl = null;
      this.quadVao = null;
      this.quadBuffer = null;
      this.horizonProgram = null;
      this.horizonUniforms = null;
      this.framebuffer = null;
      this.supported = true;
      this.neighborOffsets = [];
      this.maxNeighborOffset = 0;
    }

    initialize(gl, dependencies = {}) {
      if (!gl || typeof gl.createShader !== 'function') {
        this.supported = false;
        return false;
      }

      this.gl = gl;
      this.neighborOffsets = Array.isArray(dependencies.neighborOffsets)
        ? dependencies.neighborOffsets.slice()
        : [];
      this.maxNeighborOffset = isFiniteNumber(dependencies.maxNeighborOffset)
        ? dependencies.maxNeighborOffset
        : 0;

      if (typeof TerrainShaders === 'undefined' || !TerrainShaders.commonFunctions) {
        console.warn('H4SunlightEngine: TerrainShaders.commonFunctions unavailable.');
        this.supported = false;
        return false;
      }

      this.horizonProgram = this._createHorizonProgram(gl);
      if (!this.horizonProgram) {
        this.supported = false;
        return false;
      }

      this.horizonUniforms = {
        u_image: gl.getUniformLocation(this.horizonProgram, 'u_image'),
        u_direction: gl.getUniformLocation(this.horizonProgram, 'u_direction'),
        u_metersPerPixel: gl.getUniformLocation(this.horizonProgram, 'u_metersPerPixel'),
        u_maxDistance: gl.getUniformLocation(this.horizonProgram, 'u_maxDistance'),
        u_angleMin: gl.getUniformLocation(this.horizonProgram, 'u_angleMin'),
        u_angleMax: gl.getUniformLocation(this.horizonProgram, 'u_angleMax'),
        u_stepMultiplier: gl.getUniformLocation(this.horizonProgram, 'u_stepMultiplier'),
        u_dimension: gl.getUniformLocation(this.horizonProgram, 'u_dimension'),
        u_quantizationLevels: gl.getUniformLocation(this.horizonProgram, 'u_quantizationLevels')
      };

      this.horizonUniforms.neighbors = this.neighborOffsets.map(offset => ({
        name: offset.uniform,
        location: gl.getUniformLocation(this.horizonProgram, offset.uniform)
      }));

      this.framebuffer = gl.createFramebuffer();

      const quad = new Float32Array([
        -1, -1,
         1, -1,
        -1,  1,
         1,  1
      ]);
      this.quadBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
      this.quadVao = gl.createVertexArray();
      gl.bindVertexArray(this.quadVao);
      const positionLocation = 0;
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 8, 0);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      return true;
    }

    ensureHeliostatLUT(parameters) {
      if (!this.supported || !this.gl) {
        return null;
      }

      const { gl } = this;
      const lat = isFiniteNumber(parameters.lat) ? parameters.lat : 0;
      const lon = isFiniteNumber(parameters.lon) ? parameters.lon : 0;
      const date = parameters.date instanceof Date ? parameters.date : null;
      if (!date) {
        return this.lutInfo;
      }

      const minutesStep = Math.max(1, parameters.minutesStep || this.minutesStep);
      const keyParts = [
        minutesStep,
        lat.toFixed(4),
        lon.toFixed(4),
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate()
      ];
      const lutKey = keyParts.join('|');
      if (this.lutInfo && this.lutInfo.key === lutKey) {
        return this.lutInfo;
      }

      const lut = makeSolarLUT({
        lat,
        lon,
        date,
        minutesStep,
        azimuthCount: this.azimuthCount,
        quantizationLevels: this.quantizationLevels,
        minElevation: this.angleMin,
        maxElevation: this.angleMax
      });

      if (!lut) {
        return this.lutInfo;
      }

      if (!this.lutTexture) {
        this.lutTexture = gl.createTexture();
      }

      gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R32F,
        lut.width,
        lut.height,
        0,
        gl.RED,
        gl.FLOAT,
        lut.data
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);

      this.lutInfo = {
        texture: this.lutTexture,
        width: lut.width,
        height: lut.height,
        maxMinutes: Math.max(0, lut.maxMinutes),
        minutesStep,
        key: lutKey
      };

      return this.lutInfo;
    }

    ensureTileResources(options) {
      if (!this.supported || !this.gl) {
        return null;
      }

      const {
        tileKey,
        tileSize,
        baseTexture,
        neighborTextures = [],
        metersPerPixel,
        maxDistance,
        stepMultiplier
      } = options;

      if (!tileKey || !baseTexture || !isFiniteNumber(tileSize) || tileSize <= 0) {
        return null;
      }

      const meters = isFiniteNumber(metersPerPixel) ? Math.max(metersPerPixel, 1e-3) : 1;
      const maxDist = isFiniteNumber(maxDistance) ? Math.max(maxDistance, 0) : 0;
      const stepMul = isFiniteNumber(stepMultiplier) ? clamp(stepMultiplier, 0.25, 8.0) : 1.0;

      let entry = this.tileResources.get(tileKey);
      const needsRebuild = !entry
        || entry.tileSize !== tileSize
        || entry.maxDistance < maxDist - 1
        || Math.abs(entry.stepMultiplier - stepMul) > 1e-3
        || !entry.ready;

      if (!entry) {
        entry = {
          texture: null,
          tileSize,
          maxDistance: maxDist,
          stepMultiplier: stepMul,
          ready: false
        };
        this.tileResources.set(tileKey, entry);
      }

      if (!entry.texture) {
        entry.texture = this.gl.createTexture();
      }

      if (needsRebuild) {
        if (entry.texture) {
          this.gl.bindTexture(this.gl.TEXTURE_2D_ARRAY, entry.texture);
          this.gl.texImage3D(
            this.gl.TEXTURE_2D_ARRAY,
            0,
            this.gl.R8,
            tileSize,
            tileSize,
            this.azimuthCount,
            0,
            this.gl.RED,
            this.gl.UNSIGNED_BYTE,
            null
          );
          this.gl.texParameteri(this.gl.TEXTURE_2D_ARRAY, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
          this.gl.texParameteri(this.gl.TEXTURE_2D_ARRAY, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
          this.gl.texParameteri(this.gl.TEXTURE_2D_ARRAY, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
          this.gl.texParameteri(this.gl.TEXTURE_2D_ARRAY, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
          this.gl.bindTexture(this.gl.TEXTURE_2D_ARRAY, null);
        }
        entry.tileSize = tileSize;
        entry.maxDistance = maxDist;
        entry.stepMultiplier = stepMul;
        entry.ready = this._buildHorizon(entry, {
          baseTexture,
          neighborTextures,
          tileSize,
          meters,
          maxDist,
          stepMul
        });
      }

      return entry.ready ? entry : null;
    }

    collectGarbage(activeKeys) {
      if (!this.tileResources.size) return;
      const keep = new Set(Array.isArray(activeKeys) ? activeKeys : []);
      for (const [key, entry] of this.tileResources.entries()) {
        if (!keep.has(key)) {
          if (entry.texture && this.gl) {
            this.gl.deleteTexture(entry.texture);
          }
          this.tileResources.delete(key);
        }
      }
    }

    invalidateAll() {
      if (this.tileResources.size && this.gl) {
        for (const entry of this.tileResources.values()) {
          if (entry.texture) {
            this.gl.deleteTexture(entry.texture);
          }
        }
      }
      this.tileResources.clear();
      this.lutInfo = null;
    }

    destroy() {
      if (!this.gl) {
        return;
      }
      this.invalidateAll();
      if (this.lutTexture) {
        this.gl.deleteTexture(this.lutTexture);
        this.lutTexture = null;
      }
      if (this.framebuffer) {
        this.gl.deleteFramebuffer(this.framebuffer);
        this.framebuffer = null;
      }
      if (this.horizonProgram) {
        this.gl.deleteProgram(this.horizonProgram);
        this.horizonProgram = null;
      }
      if (this.quadBuffer) {
        this.gl.deleteBuffer(this.quadBuffer);
        this.quadBuffer = null;
      }
      if (this.quadVao) {
        this.gl.deleteVertexArray(this.quadVao);
        this.quadVao = null;
      }
      this.gl = null;
      this.supported = false;
    }

    _buildHorizon(entry, params) {
      const gl = this.gl;
      if (!gl || !this.horizonProgram) {
        return false;
      }

      const prevFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      const prevViewport = gl.getParameter(gl.VIEWPORT);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.useProgram(this.horizonProgram);
      gl.bindVertexArray(this.quadVao);
      gl.viewport(0, 0, entry.tileSize, entry.tileSize);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      if (this.horizonUniforms.u_dimension) {
        gl.uniform2f(this.horizonUniforms.u_dimension, entry.tileSize, entry.tileSize);
      }
      if (this.horizonUniforms.u_metersPerPixel) {
        gl.uniform1f(this.horizonUniforms.u_metersPerPixel, params.meters);
      }
      if (this.horizonUniforms.u_maxDistance) {
        gl.uniform1f(this.horizonUniforms.u_maxDistance, params.maxDist);
      }
      if (this.horizonUniforms.u_stepMultiplier) {
        gl.uniform1f(this.horizonUniforms.u_stepMultiplier, params.stepMul);
      }
      if (this.horizonUniforms.u_angleMin) {
        gl.uniform1f(this.horizonUniforms.u_angleMin, this.angleMin);
      }
      if (this.horizonUniforms.u_angleMax) {
        gl.uniform1f(this.horizonUniforms.u_angleMax, this.angleMax);
      }
      if (this.horizonUniforms.u_quantizationLevels) {
        gl.uniform1i(this.horizonUniforms.u_quantizationLevels, this.quantizationLevels);
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, params.baseTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (this.horizonUniforms.u_image) {
        gl.uniform1i(this.horizonUniforms.u_image, 0);
      }

      for (let i = 0; i < this.horizonUniforms.neighbors.length; i++) {
        const uniform = this.horizonUniforms.neighbors[i];
        if (!uniform || !uniform.location) continue;
        const texture = params.neighborTextures[i] || params.baseTexture;
        gl.activeTexture(gl.TEXTURE1 + i);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.uniform1i(uniform.location, 1 + i);
      }

      let success = true;
      for (let az = 0; az < this.azimuthCount; az++) {
        const angle = this.azimuthAngles[az];
        const dirX = Math.cos(angle);
        const dirY = Math.sin(angle);
        if (this.horizonUniforms.u_direction) {
          gl.uniform2f(this.horizonUniforms.u_direction, dirX, dirY);
        }

        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, entry.texture, 0, az);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
          console.warn('H4SunlightEngine: framebuffer incomplete for horizon layer', status);
          success = false;
          break;
        }
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFramebuffer);
      if (prevViewport && prevViewport.length === 4) {
        gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
      }
      gl.activeTexture(gl.TEXTURE0);

      return success;
    }

    _createShader(gl, type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('H4SunlightEngine shader error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    }

    _createProgram(gl, vertexSource, fragmentSource) {
      const vertexShader = this._createShader(gl, gl.VERTEX_SHADER, vertexSource);
      const fragmentShader = this._createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
      if (!vertexShader || !fragmentShader) {
        if (vertexShader) gl.deleteShader(vertexShader);
        if (fragmentShader) gl.deleteShader(fragmentShader);
        return null;
      }
      const program = gl.createProgram();
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('H4SunlightEngine program link error:', gl.getProgramInfoLog(program));
        gl.deleteProgram(program);
        return null;
      }
      return program;
    }

    _createHorizonProgram(gl) {
      const neighborBound = this.maxNeighborOffset || 0;
      const vertexSource = `#version 300 es\n`
        + `layout(location = 0) in vec2 a_pos;\n`
        + `out vec2 v_texCoord;\n`
        + `void main() {\n`
        + `  v_texCoord = a_pos * 0.5 + 0.5;\n`
        + `  gl_Position = vec4(a_pos, 0.0, 1.0);\n`
        + `}`;

      const fragmentSource = `#version 300 es\n`
        + `precision highp float;\n`
        + `precision highp int;\n`
        + `${TerrainShaders.commonFunctions}\n`
        + `uniform vec2 u_direction;\n`
        + `uniform float u_maxDistance;\n`
        + `uniform float u_angleMin;\n`
        + `uniform float u_angleMax;\n`
        + `uniform float u_stepMultiplier;\n`
        + `uniform int u_quantizationLevels;\n`
        + `in vec2 v_texCoord;\n`
        + `out vec4 oColor;\n`
        + `const int MAX_HORIZON_STEPS = 512;\n`
        + `const float HORIZON_NEIGHBOR_BOUND = ${neighborBound.toFixed(1)};\n`
        + `float computeMaxSlope(vec2 startPos, float baseElevation, vec2 direction) {\n`
        + `  if (u_maxDistance <= 0.0) {\n`
        + `    return tan(u_angleMin);\n`
        + `  }\n`
        + `  vec2 horizontalDir = normalize(direction);\n`
        + `  if (length(horizontalDir) < 1e-6) {\n`
        + `    return tan(u_angleMin);\n`
        + `  }\n`
        + `  float tileResolution = u_dimension.x;\n`
        + `  vec2 texelStep = horizontalDir / tileResolution;\n`
        + `  float stepMul = max(u_stepMultiplier, 0.25);\n`
        + `  vec2 baseTexelStep = texelStep / stepMul;\n`
        + `  float baseStep = u_metersPerPixel / stepMul;\n`
        + `  float maxSlope = tan(u_angleMin);\n`
        + `  vec2 samplePos = startPos;\n`
        + `  float traveled = 0.0;\n`
        + `  float stepFactor = 1.0;\n`
        + `  float minBound = -HORIZON_NEIGHBOR_BOUND;\n`
        + `  float maxBound = 1.0 + HORIZON_NEIGHBOR_BOUND;\n`
        + `  for (int i = 0; i < MAX_HORIZON_STEPS; ++i) {\n`
        + `    float nextDistance = traveled + baseStep * stepFactor;\n`
        + `    if (nextDistance > u_maxDistance) {\n`
        + `      break;\n`
        + `    }\n`
        + `    samplePos += baseTexelStep * stepFactor;\n`
        + `    if (samplePos.x < minBound || samplePos.x > maxBound || samplePos.y < minBound || samplePos.y > maxBound) {\n`
        + `      break;\n`
        + `    }\n`
        + `    traveled = nextDistance;\n`
        + `    if (traveled <= 0.0) {\n`
        + `      continue;\n`
        + `    }\n`
        + `    float sampleElevation = sampleElevationAdaptive(samplePos, traveled, u_metersPerPixel);\n`
        + `    float slope = (sampleElevation - baseElevation) / traveled;\n`
        + `    maxSlope = max(maxSlope, slope);\n`
        + `    float growth = computeAdaptiveStepGrowth(traveled);\n`
        + `    stepFactor = min(stepFactor * growth, 64.0);\n`
        + `  }\n`
        + `  return maxSlope;\n`
        + `}\n`
        + `void main() {\n`
        + `  float baseElevation = getElevationExtended(v_texCoord);\n`
        + `  float maxSlope = computeMaxSlope(v_texCoord, baseElevation, u_direction);\n`
        + `  float angle = atan(maxSlope);\n`
        + `  float normalized = (angle - u_angleMin) / (u_angleMax - u_angleMin);\n`
        + `  normalized = clamp(normalized, 0.0, 1.0);\n`
        + `  float qLevels = float(max(u_quantizationLevels, 2));\n`
        + `  float quantized = floor(normalized * (qLevels - 1.0) + 0.5);\n`
        + `  float stored = quantized / (qLevels - 1.0);\n`
        + `  oColor = vec4(stored, stored, stored, 1.0);\n`
        + `}`;

      return this._createProgram(gl, vertexSource, fragmentSource);
    }
  }

  window.H4SunlightEngine = H4SunlightEngine;
})();
