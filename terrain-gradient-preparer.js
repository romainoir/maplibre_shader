/* terrain-gradient-preparer.js */
const TerrainGradientPreparer = (function() {
  const GRADIENT_MAX_NEIGHBOR_OFFSET = 2;
  const EARTH_CIRCUMFERENCE_METERS = 40075016.68557849;
  const MIN_METERS_PER_PIXEL = 1e-6;
  const GRADIENT_NEIGHBOR_NAME_OVERRIDES = {
    '-1,0': 'u_image_left',
    '1,0': 'u_image_right',
    '0,-1': 'u_image_top',
    '0,1': 'u_image_bottom',
    '-1,-1': 'u_image_topLeft',
    '1,-1': 'u_image_topRight',
    '-1,1': 'u_image_bottomLeft',
    '1,1': 'u_image_bottomRight'
  };

  function gradientFormatOffsetPart(value) {
    if (value === 0) {
      return '0';
    }
    const prefix = value < 0 ? 'm' : 'p';
    return `${prefix}${Math.abs(value)}`;
  }

  function gradientUniformNameForOffset(dx, dy) {
    const key = `${dx},${dy}`;
    if (GRADIENT_NEIGHBOR_NAME_OVERRIDES[key]) {
      return GRADIENT_NEIGHBOR_NAME_OVERRIDES[key];
    }
    return `u_image_${gradientFormatOffsetPart(dx)}_${gradientFormatOffsetPart(dy)}`;
  }

  function gradientBuildNeighborOffsets(maxOffset) {
    const offsets = [];
    for (let dy = -maxOffset; dy <= maxOffset; dy++) {
      for (let dx = -maxOffset; dx <= maxOffset; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (Math.abs(dx) + Math.abs(dy) > maxOffset) continue;
        offsets.push({ dx, dy, uniform: gradientUniformNameForOffset(dx, dy) });
      }
    }
    return offsets;
  }

  const GRADIENT_NEIGHBOR_OFFSETS = gradientBuildNeighborOffsets(GRADIENT_MAX_NEIGHBOR_OFFSET);
  const GRADIENT_NEIGHBOR_UNIFORM_DECLARATIONS = GRADIENT_NEIGHBOR_OFFSETS
    .map(({ uniform }) => `uniform sampler2D ${uniform};`)
    .join('\n');
  const GRADIENT_NEIGHBOR_UNIFORM_BLOCK = GRADIENT_NEIGHBOR_UNIFORM_DECLARATIONS
    ? `${GRADIENT_NEIGHBOR_UNIFORM_DECLARATIONS}\n`
    : '';
  const GRADIENT_NEIGHBOR_FETCH_CASES = GRADIENT_NEIGHBOR_OFFSETS
    .map(({ dx, dy, uniform }) => `  if (offset == ivec2(${dx}, ${dy})) return getElevationFromTexture(${uniform}, tilePos);`)
    .join('\n');
  const GRADIENT_NEIGHBOR_FETCH_BLOCK = GRADIENT_NEIGHBOR_FETCH_CASES
    ? `\n${GRADIENT_NEIGHBOR_FETCH_CASES}\n`
    : '';

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

  class GradientPreparer {
    constructor() {
      this.gl = null;
      this.program = null;
      this.uniforms = null;
      this.attributes = null;
      this.quadVbo = null;
      this.quadIbo = null;
      this.supported = true;
      this.unsupportedReason = null;
      this.tileStates = new Map();
      this.invalidateVersion = 0;
      this.previousFramebuffer = null;
      this.previousViewport = null;
      this.neighborCount = GRADIENT_NEIGHBOR_OFFSETS.length;
      this.maxNeighborOffset = GRADIENT_MAX_NEIGHBOR_OFFSET;
      this.lastFrameInfo = {
        supported: true,
        requestedTiles: 0,
        preparedTiles: 0,
        reusedTiles: 0,
        discardedTiles: 0,
        activeTiles: 0,
        cachedTiles: 0,
        samplingDistance: null,
        neighborMatches: 0,
        neighborFallbacks: 0,
        neighborCount: GRADIENT_NEIGHBOR_OFFSETS.length,
        maxNeighborOffset: GRADIENT_MAX_NEIGHBOR_OFFSET,
        unsupportedReason: null,
        timestamp: null
      };
    }

    createShader(gl, type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Gradient shader compile error:', gl.getShaderInfoLog(shader));
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
        console.error('Gradient program link error:', gl.getProgramInfoLog(program));
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
      if (this.gl === gl && this.program) {
        return;
      }
      this.dispose(gl);
      this.gl = gl;
      this.unsupportedReason = null;

      const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
      if (!isWebGL2) {
        console.warn('TerrainGradientPreparer requires WebGL2 for float framebuffers. Falling back to runtime gradients.');
        this.supported = false;
        this.unsupportedReason = 'WebGL2 context required';
        return;
      }
      const ext = gl.getExtension('EXT_color_buffer_float');
      if (!ext) {
        console.warn('TerrainGradientPreparer missing EXT_color_buffer_float; precomputed gradients disabled.');
        this.supported = false;
        this.unsupportedReason = 'EXT_color_buffer_float missing';
        return;
      }
      this.supported = true;
      this.unsupportedReason = null;

      const vertexSource = `#version 300 es\n`
        + `precision highp float;\n`
        + `in vec2 a_pos;\n`
        + `out vec2 v_texCoord;\n`
        + `void main() {\n`
        + `  v_texCoord = 0.5 * (a_pos + 1.0);\n`
        + `  gl_Position = vec4(a_pos, 0.0, 1.0);\n`
        + `}`;

      const fragmentSource = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_image;
${GRADIENT_NEIGHBOR_UNIFORM_BLOCK}uniform vec4 u_terrain_unpack;
uniform vec2 u_dimension;
uniform float u_zoom;
uniform float u_samplingDistance;
uniform float u_metersPerPixel;
float getElevationFromTexture(sampler2D tex, vec2 pos) {
  vec4 data = texture(tex, pos) * 255.0;
  return (data.r * u_terrain_unpack[0]
        + data.g * u_terrain_unpack[1]
        + data.b * u_terrain_unpack[2])
        - u_terrain_unpack[3];
}
vec2 clampTexCoord(vec2 pos) {
  float border = 0.5 / u_dimension.x;
  return clamp(pos, vec2(border), vec2(1.0 - border));
}
float getElevationExtended(vec2 pos) {
  vec2 tilePos = pos;
  ivec2 offset = ivec2(0);
  const int MAX_OFFSET = ${GRADIENT_MAX_NEIGHBOR_OFFSET};
  for (int i = 0; i < ${GRADIENT_MAX_NEIGHBOR_OFFSET * 4}; ++i) {
    bool adjusted = false;
    if (tilePos.x < 0.0) {
      int nextOffsetX = offset.x - 1;
      if (nextOffsetX >= -MAX_OFFSET && abs(nextOffsetX) + abs(offset.y) <= MAX_OFFSET) {
        tilePos.x += 1.0;
        offset.x = nextOffsetX;
        adjusted = true;
      }
    } else if (tilePos.x > 1.0) {
      int nextOffsetX = offset.x + 1;
      if (nextOffsetX <= MAX_OFFSET && abs(nextOffsetX) + abs(offset.y) <= MAX_OFFSET) {
        tilePos.x -= 1.0;
        offset.x = nextOffsetX;
        adjusted = true;
      }
    }
    if (tilePos.y < 0.0) {
      int nextOffsetY = offset.y - 1;
      if (nextOffsetY >= -MAX_OFFSET && abs(offset.x) + abs(nextOffsetY) <= MAX_OFFSET) {
        tilePos.y += 1.0;
        offset.y = nextOffsetY;
        adjusted = true;
      }
    } else if (tilePos.y > 1.0) {
      int nextOffsetY = offset.y + 1;
      if (nextOffsetY <= MAX_OFFSET && abs(offset.x) + abs(nextOffsetY) <= MAX_OFFSET) {
        tilePos.y -= 1.0;
        offset.y = nextOffsetY;
        adjusted = true;
      }
    }
    if (!adjusted) {
      break;
    }
  }
  offset.x = clamp(offset.x, -MAX_OFFSET, MAX_OFFSET);
  offset.y = clamp(offset.y, -MAX_OFFSET, MAX_OFFSET);
  tilePos = clampTexCoord(tilePos);
${GRADIENT_NEIGHBOR_FETCH_BLOCK}  return getElevationFromTexture(u_image, tilePos);
}
void main() {
  float sampleDist = max(u_samplingDistance, 0.0001);
  float metersPerPixel = max(u_metersPerPixel, 0.0001);
  float metersPerTile = metersPerPixel * u_dimension.x;
  float delta = sampleDist / metersPerTile;
  float denom = 2.0 * sampleDist;
  vec2 dx = vec2(delta, 0.0);
  vec2 dy = vec2(0.0, delta);
  float left = getElevationExtended(v_texCoord - dx);
  float right = getElevationExtended(v_texCoord + dx);
  float top = getElevationExtended(v_texCoord - dy);
  float bottom = getElevationExtended(v_texCoord + dy);
  float gx = (right - left) / denom;
  float gy = (bottom - top) / denom;
  fragColor = vec4(gx, gy, 0.0, 1.0);
}`;

      this.program = this.createProgram(gl, vertexSource, fragmentSource);
      if (!this.program) {
        this.supported = false;
        return;
      }

      this.attributes = {
        a_pos: gl.getAttribLocation(this.program, 'a_pos')
      };
      this.uniforms = {
        u_image: gl.getUniformLocation(this.program, 'u_image'),
        u_terrain_unpack: gl.getUniformLocation(this.program, 'u_terrain_unpack'),
        u_dimension: gl.getUniformLocation(this.program, 'u_dimension'),
        u_zoom: gl.getUniformLocation(this.program, 'u_zoom'),
        u_samplingDistance: gl.getUniformLocation(this.program, 'u_samplingDistance'),
        u_metersPerPixel: gl.getUniformLocation(this.program, 'u_metersPerPixel')
      };
      GRADIENT_NEIGHBOR_OFFSETS.forEach(({ uniform }) => {
        this.uniforms[uniform] = gl.getUniformLocation(this.program, uniform);
      });

      const quadVertices = new Float32Array([
        -1.0, -1.0,
         1.0, -1.0,
         1.0,  1.0,
        -1.0,  1.0
      ]);
      const quadIndices = new Uint16Array([0, 1, 2, 0, 2, 3]);

      this.quadVbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
      gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);

      this.quadIbo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIbo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIndices, gl.STATIC_DRAW);

      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    }

    dispose(gl) {
      if (!gl) return;
      if (this.program) {
        gl.deleteProgram(this.program);
        this.program = null;
      }
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
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, size, size, 0, gl.RGBA, gl.HALF_FLOAT, null);

      if (!state.framebuffer) {
        state.framebuffer = gl.createFramebuffer();
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, state.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, state.texture, 0);
    }

    bindInputTexture(gl, unit, texture, location) {
      if (!texture || location === null) return;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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

    restoreFramebuffer(gl, prevFramebuffer) {
      if (prevFramebuffer) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, prevFramebuffer);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
    }

    prepare(options) {
      const {
        gl,
        renderableTiles,
        tileManager,
        terrainInterface,
        terrainDataCache,
        textureCache,
        neighborOffsets,
        samplingDistance
      } = options;

      const requestedTiles = Array.isArray(renderableTiles) ? renderableTiles.length : 0;

      if (!gl || !renderableTiles || requestedTiles === 0) {
        this.lastFrameInfo = {
          supported: this.supported,
          requestedTiles,
          preparedTiles: 0,
          reusedTiles: 0,
          discardedTiles: 0,
          activeTiles: 0,
          cachedTiles: this.tileStates.size,
          samplingDistance: samplingDistance || null,
          neighborMatches: 0,
          neighborFallbacks: 0,
          neighborCount: this.neighborCount,
          maxNeighborOffset: this.maxNeighborOffset,
          unsupportedReason: this.unsupportedReason,
          timestamp: Date.now()
        };
        return;
      }

      this.initialize(gl);
      if (!this.supported || !this.program) {
        this.lastFrameInfo = {
          supported: false,
          requestedTiles,
          preparedTiles: 0,
          reusedTiles: 0,
          discardedTiles: 0,
          activeTiles: 0,
          cachedTiles: this.tileStates.size,
          samplingDistance: samplingDistance || null,
          neighborMatches: 0,
          neighborFallbacks: 0,
          neighborCount: this.neighborCount,
          maxNeighborOffset: this.maxNeighborOffset,
          unsupportedReason: this.unsupportedReason,
          timestamp: Date.now()
        };
        return;
      }

      const frameInfo = {
        supported: true,
        requestedTiles,
        preparedTiles: 0,
        reusedTiles: 0,
        discardedTiles: 0,
        activeTiles: 0,
        cachedTiles: this.tileStates.size,
        samplingDistance: samplingDistance || null,
        neighborMatches: 0,
        neighborFallbacks: 0,
        neighborCount: this.neighborCount,
        maxNeighborOffset: this.maxNeighborOffset,
        unsupportedReason: null,
        timestamp: Date.now()
      };

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

      gl.useProgram(this.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
      gl.enableVertexAttribArray(this.attributes.a_pos);
      gl.vertexAttribPointer(this.attributes.a_pos, 2, gl.FLOAT, false, 8, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIbo);

      for (const tile of renderableTiles) {
        const sourceTile = tileManager.getSourceTile(tile.tileID, true);
        if (!sourceTile || sourceTile.tileID.key !== tile.tileID.key) continue;
        const tileKey = tile.tileID.key;
        activeKeys.add(tileKey);

        const terrainData = terrainDataCache.get(tile.tileID.key) || (terrainInterface && terrainInterface.getTerrainData ? terrainInterface.getTerrainData(tile.tileID) : null);
        if (!terrainData || !terrainData.texture || terrainData.fallback) continue;

        const dem = sourceTile.dem;
        const tileSize = dem && dem.dim ? dem.dim : (terrainInterface && terrainInterface.tileManager && terrainInterface.tileManager.tileSize ? terrainInterface.tileManager.tileSize : 512);
        const demUid = dem && typeof dem.uid !== 'undefined' ? dem.uid : null;

        let state = this.tileStates.get(tileKey);
        if (!state) {
          state = { texture: null, framebuffer: null, version: -1, samplingDistance: null, demUid: null, size: null };
          this.tileStates.set(tileKey, state);
        }

        const hillshadePending = !!(sourceTile && sourceTile.needsHillshadePrepare);
        let needsUpdate = !state.texture
          || state.size !== tileSize
          || state.samplingDistance !== samplingDistance
          || state.version !== this.invalidateVersion
          || state.demUid !== demUid;

        if (!needsUpdate && hillshadePending) {
          needsUpdate = true;
        }

        if (!needsUpdate) {
          frameInfo.reusedTiles++;
          continue;
        }

        frameInfo.preparedTiles++;
        this.ensureTileResources(gl, state, tileSize);
        gl.viewport(0, 0, tileSize, tileSize);

        const canonical = tile.tileID.canonical;

        const neighborTextures = neighborOffsets.map(offset => {
          const neighborKey = this.getNeighborCacheKey(tile.tileID, offset);
          if (!neighborKey) {
            frameInfo.neighborFallbacks++;
            return terrainData.texture;
          }
          const texture = textureCache.get(neighborKey);
          if (!texture) {
            frameInfo.neighborFallbacks++;
            return terrainData.texture;
          }
          frameInfo.neighborMatches++;
          return texture;
        });

        this.bindInputTexture(gl, 0, terrainData.texture, this.uniforms.u_image);

        neighborOffsets.forEach((offset, index) => {
          const location = this.uniforms[offset.uniform] || null;
          this.bindInputTexture(gl, index + 1, neighborTextures[index], location);
        });

        gl.uniform4f(this.uniforms.u_terrain_unpack, rgbaFactors.r, rgbaFactors.g, rgbaFactors.b, rgbaFactors.base);
        gl.uniform2f(this.uniforms.u_dimension, tileSize, tileSize);
        gl.uniform1f(this.uniforms.u_zoom, canonical.z);
        if (this.uniforms.u_metersPerPixel !== null) {
          const metersPerPixel = computeMetersPerPixelForTile(canonical, tileSize);
          gl.uniform1f(this.uniforms.u_metersPerPixel, metersPerPixel);
        }
        gl.uniform1f(this.uniforms.u_samplingDistance, samplingDistance);

        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);

        state.version = this.invalidateVersion;
        state.samplingDistance = samplingDistance;
        state.demUid = demUid;
        state.size = tileSize;

        if (sourceTile) {
          sourceTile.needsHillshadePrepare = false;
        }
      }

      gl.disableVertexAttribArray(this.attributes.a_pos);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
      gl.useProgram(null);
      gl.activeTexture(gl.TEXTURE0);

      if (blendEnabled) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
      if (depthEnabled) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
      if (cullEnabled) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);

      this.restoreFramebuffer(gl, prevFramebuffer);
      if (prevViewport) {
        gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
      }

      let discardedTiles = 0;
      for (const [key, state] of this.tileStates.entries()) {
        if (!activeKeys.has(key)) {
          if (state.texture) gl.deleteTexture(state.texture);
          if (state.framebuffer) gl.deleteFramebuffer(state.framebuffer);
          this.tileStates.delete(key);
          discardedTiles++;
        }
      }
      frameInfo.discardedTiles = discardedTiles;
      frameInfo.activeTiles = activeKeys.size;
      frameInfo.cachedTiles = this.tileStates.size;
      frameInfo.unsupportedReason = this.unsupportedReason;
      this.lastFrameInfo = frameInfo;
    }

    getDebugInfo() {
      return {
        supported: this.supported,
        unsupportedReason: this.unsupportedReason,
        tileStateCount: this.tileStates.size,
        invalidateVersion: this.invalidateVersion,
        neighborCount: this.neighborCount,
        maxNeighborOffset: this.maxNeighborOffset,
        lastFrameInfo: this.lastFrameInfo
      };
    }
  }

  return {
    create() {
      return new GradientPreparer();
    }
  };
})();
