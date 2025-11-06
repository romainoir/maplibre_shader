/* terrain-gradient-preparer.js */
const TerrainGradientPreparer = (function() {
  class GradientPreparer {
    constructor() {
      this.gl = null;
      this.program = null;
      this.uniforms = null;
      this.attributes = null;
      this.quadVbo = null;
      this.quadIbo = null;
      this.supported = true;
      this.tileStates = new Map();
      this.invalidateVersion = 0;
      this.previousFramebuffer = null;
      this.previousViewport = null;
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

      const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
      if (!isWebGL2) {
        console.warn('TerrainGradientPreparer requires WebGL2 for float framebuffers. Falling back to runtime gradients.');
        this.supported = false;
        return;
      }
      const ext = gl.getExtension('EXT_color_buffer_float');
      if (!ext) {
        console.warn('TerrainGradientPreparer missing EXT_color_buffer_float; precomputed gradients disabled.');
        this.supported = false;
        return;
      }
      this.supported = true;

      const vertexSource = `#version 300 es\n`
        + `precision highp float;\n`
        + `in vec2 a_pos;\n`
        + `out vec2 v_texCoord;\n`
        + `void main() {\n`
        + `  v_texCoord = 0.5 * (a_pos + 1.0);\n`
        + `  gl_Position = vec4(a_pos, 0.0, 1.0);\n`
        + `}`;

      const fragmentSource = `#version 300 es\n`
        + `precision highp float;\n`
        + `precision highp int;\n`
        + `in vec2 v_texCoord;\n`
        + `out vec4 fragColor;\n`
        + `uniform sampler2D u_image;\n`
        + `uniform sampler2D u_image_left;\n`
        + `uniform sampler2D u_image_right;\n`
        + `uniform sampler2D u_image_top;\n`
        + `uniform sampler2D u_image_bottom;\n`
        + `uniform sampler2D u_image_topLeft;\n`
        + `uniform sampler2D u_image_topRight;\n`
        + `uniform sampler2D u_image_bottomLeft;\n`
        + `uniform sampler2D u_image_bottomRight;\n`
        + `uniform vec4 u_terrain_unpack;\n`
        + `uniform vec2 u_dimension;\n`
        + `uniform float u_zoom;\n`
        + `uniform float u_samplingDistance;\n`
        + `float getElevationFromTexture(sampler2D tex, vec2 pos) {\n`
        + `  vec4 data = texture(tex, pos) * 255.0;\n`
        + `  return (data.r * u_terrain_unpack[0]\n`
        + `        + data.g * u_terrain_unpack[1]\n`
        + `        + data.b * u_terrain_unpack[2])\n`
        + `        - u_terrain_unpack[3];\n`
        + `}\n`
        + `vec2 clampTexCoord(vec2 pos) {\n`
        + `  float border = 0.5 / u_dimension.x;\n`
        + `  return clamp(pos, vec2(border), vec2(1.0 - border));\n`
        + `}\n`
        + `float getElevationExtended(vec2 pos) {\n`
        + `  vec2 tilePos = pos;\n`
        + `  vec2 offset = vec2(0.0);\n`
        + `  for (int i = 0; i < 2; i++) {\n`
        + `    if (tilePos.x < 0.0 && offset.x > -1.5) {\n`
        + `      tilePos.x += 1.0;\n`
        + `      offset.x -= 1.0;\n`
        + `    }\n`
        + `    if (tilePos.x > 1.0 && offset.x < 1.5) {\n`
        + `      tilePos.x -= 1.0;\n`
        + `      offset.x += 1.0;\n`
        + `    }\n`
        + `    if (tilePos.y < 0.0 && offset.y > -1.5) {\n`
        + `      tilePos.y += 1.0;\n`
        + `      offset.y -= 1.0;\n`
        + `    }\n`
        + `    if (tilePos.y > 1.0 && offset.y < 1.5) {\n`
        + `      tilePos.y -= 1.0;\n`
        + `      offset.y += 1.0;\n`
        + `    }\n`
        + `  }\n`
        + `  offset = clamp(offset, vec2(-1.0), vec2(1.0));\n`
        + `  tilePos = clampTexCoord(tilePos);\n`
        + `  if (offset.x == -1.0 && offset.y == -1.0) return getElevationFromTexture(u_image_topLeft, tilePos);\n`
        + `  if (offset.x == 1.0 && offset.y == -1.0) return getElevationFromTexture(u_image_topRight, tilePos);\n`
        + `  if (offset.x == -1.0 && offset.y == 1.0) return getElevationFromTexture(u_image_bottomLeft, tilePos);\n`
        + `  if (offset.x == 1.0 && offset.y == 1.0) return getElevationFromTexture(u_image_bottomRight, tilePos);\n`
        + `  if (offset.x == -1.0) return getElevationFromTexture(u_image_left, tilePos);\n`
        + `  if (offset.x == 1.0) return getElevationFromTexture(u_image_right, tilePos);\n`
        + `  if (offset.y == -1.0) return getElevationFromTexture(u_image_top, tilePos);\n`
        + `  if (offset.y == 1.0) return getElevationFromTexture(u_image_bottom, tilePos);\n`
        + `  return getElevationFromTexture(u_image, tilePos);\n`
        + `}\n`
        + `void main() {\n`
        + `  float sampleDist = max(u_samplingDistance, 0.0001);\n`
        + `  float metersPerPixel = 1.5 * pow(2.0, 16.0 - u_zoom);\n`
        + `  float metersPerTile = metersPerPixel * u_dimension.x;\n`
        + `  float delta = sampleDist / metersPerTile;\n`
        + `  vec2 d = vec2(delta, delta);\n`
        + `  float tl = getElevationExtended(v_texCoord - d);\n`
        + `  float tm = getElevationExtended(v_texCoord + vec2(0.0, -delta));\n`
        + `  float tr = getElevationExtended(v_texCoord + vec2(delta, -delta));\n`
        + `  float ml = getElevationExtended(v_texCoord + vec2(-delta, 0.0));\n`
        + `  float mr = getElevationExtended(v_texCoord + vec2(delta, 0.0));\n`
        + `  float bl = getElevationExtended(v_texCoord + vec2(-delta, delta));\n`
        + `  float bm = getElevationExtended(v_texCoord + vec2(0.0, delta));\n`
        + `  float br = getElevationExtended(v_texCoord + vec2(delta, delta));\n`
        + `  float gx = (-tl + tr - 2.0 * ml + 2.0 * mr - bl + br) / (8.0 * sampleDist);\n`
        + `  float gy = (-tl - 2.0 * tm - tr + bl + 2.0 * bm + br) / (8.0 * sampleDist);\n`
        + `  fragColor = vec4(gx, gy, 0.0, 1.0);\n`
        + `}`;

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
        u_image_left: gl.getUniformLocation(this.program, 'u_image_left'),
        u_image_right: gl.getUniformLocation(this.program, 'u_image_right'),
        u_image_top: gl.getUniformLocation(this.program, 'u_image_top'),
        u_image_bottom: gl.getUniformLocation(this.program, 'u_image_bottom'),
        u_image_topLeft: gl.getUniformLocation(this.program, 'u_image_topLeft'),
        u_image_topRight: gl.getUniformLocation(this.program, 'u_image_topRight'),
        u_image_bottomLeft: gl.getUniformLocation(this.program, 'u_image_bottomLeft'),
        u_image_bottomRight: gl.getUniformLocation(this.program, 'u_image_bottomRight'),
        u_terrain_unpack: gl.getUniformLocation(this.program, 'u_terrain_unpack'),
        u_dimension: gl.getUniformLocation(this.program, 'u_dimension'),
        u_zoom: gl.getUniformLocation(this.program, 'u_zoom'),
        u_samplingDistance: gl.getUniformLocation(this.program, 'u_samplingDistance')
      };

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

      if (!gl || !renderableTiles || renderableTiles.length === 0) return;

      this.initialize(gl);
      if (!this.supported || !this.program) return;

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

        const needsUpdate = !state.texture || state.size !== tileSize || state.samplingDistance !== samplingDistance || state.version !== this.invalidateVersion || state.demUid !== demUid;

        if (!needsUpdate) continue;

        this.ensureTileResources(gl, state, tileSize);
        gl.viewport(0, 0, tileSize, tileSize);

        this.bindInputTexture(gl, 0, terrainData.texture, this.uniforms.u_image);

        const canonical = tile.tileID.canonical;
        const neighborTextures = neighborOffsets.map(offset => {
          const nx = canonical.x + offset.dx;
          const ny = canonical.y + offset.dy;
          const key = `${canonical.z}/${nx}/${ny}`;
          return textureCache.get(key) || terrainData.texture;
        });

        this.bindInputTexture(gl, 1, neighborTextures[0], this.uniforms.u_image_left);
        this.bindInputTexture(gl, 2, neighborTextures[1], this.uniforms.u_image_right);
        this.bindInputTexture(gl, 3, neighborTextures[2], this.uniforms.u_image_top);
        this.bindInputTexture(gl, 4, neighborTextures[3], this.uniforms.u_image_bottom);
        this.bindInputTexture(gl, 5, neighborTextures[4], this.uniforms.u_image_topLeft);
        this.bindInputTexture(gl, 6, neighborTextures[5], this.uniforms.u_image_topRight);
        this.bindInputTexture(gl, 7, neighborTextures[6], this.uniforms.u_image_bottomLeft);
        this.bindInputTexture(gl, 8, neighborTextures[7], this.uniforms.u_image_bottomRight);

        gl.uniform4f(this.uniforms.u_terrain_unpack, rgbaFactors.r, rgbaFactors.g, rgbaFactors.b, rgbaFactors.base);
        gl.uniform2f(this.uniforms.u_dimension, tileSize, tileSize);
        gl.uniform1f(this.uniforms.u_zoom, canonical.z);
        gl.uniform1f(this.uniforms.u_samplingDistance, samplingDistance);

        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);

        state.version = this.invalidateVersion;
        state.samplingDistance = samplingDistance;
        state.demUid = demUid;
        state.size = tileSize;
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
      return new GradientPreparer();
    }
  };
})();
