/* maplibre-hillshade-debug.js
 * Runtime instrumentation helpers to capture MapLibre's native hillshade
 * resources (buffers, framebuffers and DEM tile metadata).
 */
(function() {
  const globalKey = '__MapLibreHillshadeDebug';
  const existing = window[globalKey];
  if (existing && existing.__initialized) {
    return;
  }

  const DEFAULT_BUFFER_SAMPLE_LIMIT = 256;
  const DEFAULT_INDEX_SAMPLE_LIMIT = 512;
  const DEFAULT_HISTORY_LIMIT = 64;
  const DEFAULT_DRAW_HISTORY_LIMIT = 128;

  const debugState = {
    enabled: false,
    contexts: new Set(),
    targetLayerIds: new Set(),
    activeLayerId: null,
    layerStack: [],
    demSourceId: null,
    demEvents: [],
    demSnapshots: [],
    drawCalls: [],
    maps: new Set(),
    mapOptions: typeof WeakMap !== 'undefined' ? new WeakMap() : new Map(),
    lastAttachedMap: null,
    options: {
      bufferSampleLimit: DEFAULT_BUFFER_SAMPLE_LIMIT,
      indexSampleLimit: DEFAULT_INDEX_SAMPLE_LIMIT,
      demHistoryLimit: DEFAULT_HISTORY_LIMIT,
      drawHistoryLimit: DEFAULT_DRAW_HISTORY_LIMIT
    }
  };

  function shouldCapture() {
    return debugState.enabled && debugState.targetLayerIds.size > 0;
  }

  function installCanvasHook() {
    if (installCanvasHook.__installed) {
      return;
    }
    installCanvasHook.__installed = true;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, attrs) {
      const context = originalGetContext.call(this, type, attrs);
      if (!context) {
        return context;
      }
      const normalizedType = typeof type === 'string' ? type.toLowerCase() : '';
      if (normalizedType === 'webgl' || normalizedType === 'webgl2') {
        setupContext(context);
      }
      return context;
    };
  }

  function setupContext(gl) {
    if (!gl || gl.__hillshadeDebugWrapped) {
      return;
    }

    const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const ctxInfo = {
      gl,
      isWebGL2,
      nextBufferId: 1,
      nextProgramId: 1,
      nextTextureId: 1,
      nextFramebufferId: 1,
      buffers: new Map(),
      textures: new Map(),
      framebuffers: new Map(),
      programs: new Map(),
      boundBuffers: new Map(),
      boundTextures: new Map(),
      currentFramebuffer: null,
      currentProgram: null,
      currentVertexArray: null,
      defaultVertexArray: Symbol('defaultVertexArray'),
      vertexArrays: new Map()
    };

    debugState.contexts.add(ctxInfo);
    wrapBufferMethods(ctxInfo);
    wrapProgramMethods(ctxInfo);
    wrapTextureMethods(ctxInfo);
    wrapFramebufferMethods(ctxInfo);
    wrapVertexArrayMethods(ctxInfo);
    wrapDrawCalls(ctxInfo);

    gl.__hillshadeDebugWrapped = true;
  }

  function getBufferDebugInfo(ctxInfo, buffer) {
    if (!buffer) return null;
    const info = ctxInfo.buffers.get(buffer);
    if (!info) return null;
    return {
      id: info.id,
      target: info.target,
      usage: info.usage,
      byteLength: info.byteLength,
      type: info.type,
      sample: info.sample,
      length: info.length
    };
  }

  function getIndexDebugInfo(ctxInfo, buffer) {
    const info = getBufferDebugInfo(ctxInfo, buffer);
    if (!info) return null;
    return info;
  }

  function ensureVertexArrayInfo(ctxInfo, vao) {
    const key = vao || ctxInfo.defaultVertexArray;
    if (!ctxInfo.vertexArrays.has(key)) {
      ctxInfo.vertexArrays.set(key, {
        elementArrayBuffer: null,
        attributes: new Map(),
        enabledAttributes: new Set()
      });
    }
    return ctxInfo.vertexArrays.get(key);
  }

  function captureTypedArraySample(array, limit) {
    if (!array || typeof array.length !== 'number') {
      return null;
    }
    const sampleCount = Math.min(limit, array.length);
    const sample = Array.from(array.subarray ? array.subarray(0, sampleCount) : Array.prototype.slice.call(array, 0, sampleCount));
    return {
      length: array.length,
      sample,
      constructor: array.constructor ? array.constructor.name : typeof array
    };
  }

  function captureArrayBufferSample(buffer, limit) {
    if (!(buffer instanceof ArrayBuffer)) {
      return null;
    }
    return captureTypedArraySample(new Uint8Array(buffer), limit);
  }

  function wrapBufferMethods(ctxInfo) {
    const gl = ctxInfo.gl;
    const originalCreateBuffer = gl.createBuffer.bind(gl);
    gl.createBuffer = function() {
      const buffer = originalCreateBuffer();
      if (buffer) {
        buffer.__hillshadeDebugId = `buffer_${ctxInfo.nextBufferId++}`;
        ctxInfo.buffers.set(buffer, {
          id: buffer.__hillshadeDebugId,
          target: null,
          usage: null,
          byteLength: 0,
          type: null,
          sample: null,
          length: 0
        });
      }
      return buffer;
    };

    const originalDeleteBuffer = gl.deleteBuffer.bind(gl);
    gl.deleteBuffer = function(buffer) {
      ctxInfo.buffers.delete(buffer);
      return originalDeleteBuffer(buffer);
    };

    const originalBindBuffer = gl.bindBuffer.bind(gl);
    gl.bindBuffer = function(target, buffer) {
      ctxInfo.boundBuffers.set(target, buffer || null);
      const result = originalBindBuffer(target, buffer);
      const info = buffer ? ctxInfo.buffers.get(buffer) : null;
      if (info) {
        info.target = target;
      }
      const vaoInfo = ensureVertexArrayInfo(ctxInfo, ctxInfo.currentVertexArray);
      if (target === gl.ELEMENT_ARRAY_BUFFER) {
        vaoInfo.elementArrayBuffer = buffer || null;
      }
      return result;
    };

    const originalBufferData = gl.bufferData.bind(gl);
    gl.bufferData = function(target, data, usage) {
      const buffer = ctxInfo.boundBuffers.get(target) || null;
      if (buffer) {
        const info = ctxInfo.buffers.get(buffer);
        if (info) {
          info.usage = usage;
          if (typeof data === 'number') {
            info.byteLength = data;
            info.length = data;
            info.sample = null;
            info.type = 'size';
          } else if (ArrayBuffer.isView(data)) {
            info.byteLength = data.byteLength;
            info.length = data.length;
            info.type = data.constructor ? data.constructor.name : 'typed-array';
            const limit = target === gl.ELEMENT_ARRAY_BUFFER
              ? debugState.options.indexSampleLimit
              : debugState.options.bufferSampleLimit;
            info.sample = captureTypedArraySample(data, limit);
          } else if (data instanceof ArrayBuffer) {
            info.byteLength = data.byteLength;
            info.length = data.byteLength;
            info.type = 'ArrayBuffer';
            info.sample = captureArrayBufferSample(data, debugState.options.bufferSampleLimit);
          } else {
            info.byteLength = 0;
            info.length = 0;
            info.type = typeof data;
            info.sample = null;
          }
        }
      }
      return originalBufferData(target, data, usage);
    };

    const originalBufferSubData = gl.bufferSubData.bind(gl);
    gl.bufferSubData = function(target, offset, data) {
      const buffer = ctxInfo.boundBuffers.get(target) || null;
      if (buffer) {
        const info = ctxInfo.buffers.get(buffer);
        if (info && ArrayBuffer.isView(data)) {
          const limit = target === gl.ELEMENT_ARRAY_BUFFER
            ? debugState.options.indexSampleLimit
            : debugState.options.bufferSampleLimit;
          info.sample = captureTypedArraySample(data, limit);
        }
      }
      return originalBufferSubData(target, offset, data);
    };
  }

  function wrapProgramMethods(ctxInfo) {
    const gl = ctxInfo.gl;
    const originalCreateProgram = gl.createProgram.bind(gl);
    gl.createProgram = function() {
      const program = originalCreateProgram();
      if (program) {
        program.__hillshadeDebugId = `program_${ctxInfo.nextProgramId++}`;
      }
      return program;
    };

    const originalUseProgram = gl.useProgram.bind(gl);
    gl.useProgram = function(program) {
      ctxInfo.currentProgram = program || null;
      return originalUseProgram(program);
    };
  }

  function wrapTextureMethods(ctxInfo) {
    const gl = ctxInfo.gl;
    const originalCreateTexture = gl.createTexture.bind(gl);
    gl.createTexture = function() {
      const texture = originalCreateTexture();
      if (texture) {
        texture.__hillshadeDebugId = `texture_${ctxInfo.nextTextureId++}`;
        ctxInfo.textures.set(texture, {
          id: texture.__hillshadeDebugId,
          parameters: {},
          width: null,
          height: null,
          internalFormat: null,
          type: null
        });
      }
      return texture;
    };

    const originalDeleteTexture = gl.deleteTexture.bind(gl);
    gl.deleteTexture = function(texture) {
      ctxInfo.textures.delete(texture);
      return originalDeleteTexture(texture);
    };

    const originalTexImage2D = gl.texImage2D.bind(gl);
    gl.texImage2D = function(...args) {
      const target = args[0];
      const internalFormat = args[2];
      let width = null;
      let height = null;
      let format = null;
      let type = null;
      let pixels = null;

      if (args.length >= 9) {
        width = args[3];
        height = args[4];
        format = args[6];
        type = args[7];
        pixels = args[8];
      } else if (args.length === 6) {
        format = args[3];
        type = args[4];
        pixels = args[5];
        if (pixels && typeof pixels.width === 'number') {
          width = pixels.width;
        }
        if (pixels && typeof pixels.height === 'number') {
          height = pixels.height;
        }
      }

      const texture = ctxInfo.boundTextures ? ctxInfo.boundTextures.get(target) : null;
      const info = texture ? ctxInfo.textures.get(texture) : null;
      if (info) {
        if (typeof width === 'number') {
          info.width = width;
        }
        if (typeof height === 'number') {
          info.height = height;
        }
        info.internalFormat = internalFormat;
        info.type = type;
        info.format = format;
        if (ArrayBuffer.isView(pixels)) {
          info.sample = captureTypedArraySample(pixels, debugState.options.bufferSampleLimit);
        } else if (pixels instanceof ArrayBuffer) {
          info.sample = captureArrayBufferSample(pixels, debugState.options.bufferSampleLimit);
        }
      }
      return originalTexImage2D.apply(gl, args);
    };

    const originalBindTexture = gl.bindTexture.bind(gl);
    gl.bindTexture = function(target, texture) {
      ctxInfo.boundTextures.set(target, texture || null);
      return originalBindTexture(target, texture);
    };
  }

  function wrapFramebufferMethods(ctxInfo) {
    const gl = ctxInfo.gl;
    const originalCreateFramebuffer = gl.createFramebuffer.bind(gl);
    gl.createFramebuffer = function() {
      const framebuffer = originalCreateFramebuffer();
      if (framebuffer) {
        framebuffer.__hillshadeDebugId = `framebuffer_${ctxInfo.nextFramebufferId++}`;
        ctxInfo.framebuffers.set(framebuffer, {
          id: framebuffer.__hillshadeDebugId,
          attachments: {}
        });
      }
      return framebuffer;
    };

    const originalDeleteFramebuffer = gl.deleteFramebuffer.bind(gl);
    gl.deleteFramebuffer = function(framebuffer) {
      ctxInfo.framebuffers.delete(framebuffer);
      return originalDeleteFramebuffer(framebuffer);
    };

    const originalBindFramebuffer = gl.bindFramebuffer.bind(gl);
    gl.bindFramebuffer = function(target, framebuffer) {
      if (target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER) {
        ctxInfo.currentFramebuffer = framebuffer || null;
      }
      return originalBindFramebuffer(target, framebuffer);
    };

    const originalFramebufferTexture2D = gl.framebufferTexture2D.bind(gl);
    gl.framebufferTexture2D = function(target, attachment, textarget, texture, level) {
      if ((target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER) && ctxInfo.currentFramebuffer) {
        const info = ctxInfo.framebuffers.get(ctxInfo.currentFramebuffer);
        if (info) {
          info.attachments[attachment] = {
            texture: texture && ctxInfo.textures.get(texture)
              ? ctxInfo.textures.get(texture).id
              : null,
            textarget,
            level
          };
        }
      }
      return originalFramebufferTexture2D(target, attachment, textarget, texture, level);
    };
  }

  function wrapVertexArrayMethods(ctxInfo) {
    const gl = ctxInfo.gl;
    if (!ctxInfo.isWebGL2) {
      return;
    }

    const originalCreateVertexArray = gl.createVertexArray.bind(gl);
    gl.createVertexArray = function() {
      const vao = originalCreateVertexArray();
      if (vao) {
        vao.__hillshadeDebugId = `vao_${ctxInfo.vertexArrays.size + 1}`;
        ensureVertexArrayInfo(ctxInfo, vao);
      }
      return vao;
    };

    const originalDeleteVertexArray = gl.deleteVertexArray.bind(gl);
    gl.deleteVertexArray = function(vao) {
      ctxInfo.vertexArrays.delete(vao);
      return originalDeleteVertexArray(vao);
    };

    const originalBindVertexArray = gl.bindVertexArray.bind(gl);
    gl.bindVertexArray = function(vao) {
      ctxInfo.currentVertexArray = vao || null;
      return originalBindVertexArray(vao);
    };
  }

  function wrapDrawCalls(ctxInfo) {
    const gl = ctxInfo.gl;
    const originalEnableVertexAttribArray = gl.enableVertexAttribArray.bind(gl);
    gl.enableVertexAttribArray = function(index) {
      const vaoInfo = ensureVertexArrayInfo(ctxInfo, ctxInfo.currentVertexArray);
      vaoInfo.enabledAttributes.add(index);
      return originalEnableVertexAttribArray(index);
    };

    const originalDisableVertexAttribArray = gl.disableVertexAttribArray.bind(gl);
    gl.disableVertexAttribArray = function(index) {
      const vaoInfo = ensureVertexArrayInfo(ctxInfo, ctxInfo.currentVertexArray);
      vaoInfo.enabledAttributes.delete(index);
      return originalDisableVertexAttribArray(index);
    };

    const originalVertexAttribPointer = gl.vertexAttribPointer.bind(gl);
    gl.vertexAttribPointer = function(index, size, type, normalized, stride, offset) {
      const boundBuffer = ctxInfo.boundBuffers.get(gl.ARRAY_BUFFER) || null;
      const vaoInfo = ensureVertexArrayInfo(ctxInfo, ctxInfo.currentVertexArray);
      vaoInfo.attributes.set(index, {
        index,
        size,
        type,
        normalized,
        stride,
        offset,
        buffer: boundBuffer
      });
      return originalVertexAttribPointer(index, size, type, normalized, stride, offset);
    };

    const originalDrawElements = gl.drawElements.bind(gl);
    gl.drawElements = function(mode, count, type, offset) {
      if (shouldCapture()) {
        captureDrawCall(ctxInfo, {
          mode,
          count,
          type,
          offset,
          kind: 'drawElements'
        });
      }
      return originalDrawElements(mode, count, type, offset);
    };

    const originalDrawArrays = gl.drawArrays.bind(gl);
    gl.drawArrays = function(mode, first, count) {
      if (shouldCapture()) {
        captureDrawCall(ctxInfo, {
          mode,
          count,
          first,
          kind: 'drawArrays'
        });
      }
      return originalDrawArrays(mode, first, count);
    };
  }

  function getProgramDebugInfo(ctxInfo, program) {
    if (!program) return null;
    if (!ctxInfo.programs.has(program)) {
      const gl = ctxInfo.gl;
      const uniforms = [];
      const attributes = [];
      const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) || 0;
      for (let i = 0; i < uniformCount; i++) {
        const info = gl.getActiveUniform(program, i);
        if (info) {
          uniforms.push(info.name);
        }
      }
      const attribCount = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) || 0;
      for (let i = 0; i < attribCount; i++) {
        const info = gl.getActiveAttrib(program, i);
        if (info) {
          attributes.push(info.name);
        }
      }
      ctxInfo.programs.set(program, {
        id: program.__hillshadeDebugId || `program_${ctxInfo.nextProgramId++}`,
        uniforms,
        attributes
      });
    }
    return ctxInfo.programs.get(program);
  }

  function captureDrawCall(ctxInfo, drawParams) {
    const layerId = debugState.activeLayerId;
    if (!layerId || !debugState.targetLayerIds.has(layerId)) {
      return;
    }

    const vaoInfo = ensureVertexArrayInfo(ctxInfo, ctxInfo.currentVertexArray);
    const attributeDetails = [];
    vaoInfo.attributes.forEach((attr, index) => {
      if (!vaoInfo.enabledAttributes.has(index)) return;
      attributeDetails.push({
        index,
        size: attr.size,
        type: attr.type,
        normalized: attr.normalized,
        stride: attr.stride,
        offset: attr.offset,
        buffer: getBufferDebugInfo(ctxInfo, attr.buffer)
      });
    });

    const indexBufferInfo = vaoInfo.elementArrayBuffer
      ? getIndexDebugInfo(ctxInfo, vaoInfo.elementArrayBuffer)
      : null;

    const programInfo = getProgramDebugInfo(ctxInfo, ctxInfo.currentProgram);
    const framebufferInfo = ctxInfo.currentFramebuffer
      ? ctxInfo.framebuffers.get(ctxInfo.currentFramebuffer)
      : { id: 'default-framebuffer', attachments: {} };

    const record = {
      timestamp: performance.now(),
      layerId,
      draw: drawParams,
      program: programInfo,
      attributes: attributeDetails,
      indexBuffer: indexBufferInfo,
      framebuffer: framebufferInfo
    };

    debugState.drawCalls.push(record);
    if (debugState.drawCalls.length > debugState.options.drawHistoryLimit) {
      debugState.drawCalls.splice(0, debugState.drawCalls.length - debugState.options.drawHistoryLimit);
    }
  }

  function withLayerScope(layerId, fn) {
    debugState.layerStack.push(layerId);
    debugState.activeLayerId = layerId;
    try {
      return fn();
    } finally {
      debugState.layerStack.pop();
      debugState.activeLayerId = debugState.layerStack.length > 0
        ? debugState.layerStack[debugState.layerStack.length - 1]
        : null;
    }
  }

  function hookLayerRender(map, layerId) {
    if (!map || !map.style || !layerId) {
      return false;
    }
    const styleLayer = map.style._layers && map.style._layers[layerId];
    if (!styleLayer || typeof styleLayer.render !== 'function') {
      return false;
    }
    if (styleLayer.__hillshadeDebugPatched) {
      return true;
    }
    const originalRender = styleLayer.render.bind(styleLayer);
    styleLayer.render = function(...args) {
      return withLayerScope(layerId, () => originalRender(...args));
    };
    styleLayer.__hillshadeDebugPatched = true;
    return true;
  }

  function snapshotTerrainTiles(map, sourceId) {
    if (!map || !map.style || !sourceId) {
      return [];
    }
    const style = map.style;
    const sourceCaches = style.sourceCaches || style._sourceCaches || {};
    const cache = sourceCaches[sourceId] || (typeof style.getSourceCache === 'function' ? style.getSourceCache(sourceId) : null);
    if (!cache) {
      return [];
    }
    const tiles = cache._tiles || cache.tiles || {};
    const results = [];
    const tileKeys = Array.isArray(tiles) ? tiles : Object.keys(tiles);
    if (Array.isArray(tileKeys)) {
      tileKeys.forEach((key) => {
        const tile = Array.isArray(tiles) ? tiles[key] : tiles[key];
        if (!tile) return;
        results.push(extractTileDebugInfo(tile));
      });
    } else if (typeof tiles === 'object') {
      Object.keys(tiles).forEach((key) => {
        const tile = tiles[key];
        if (!tile) return;
        results.push(extractTileDebugInfo(tile));
      });
    }
    return results;
  }

  function rememberMap(map, options = {}) {
    if (!map) {
      return;
    }
    debugState.maps.add(map);
    debugState.lastAttachedMap = map;
    const store = debugState.mapOptions;
    if (store && typeof store.set === 'function') {
      const existing = (typeof store.get === 'function' ? store.get(map) : null) || {};
      if (options.layerId) {
        existing.layerId = options.layerId;
      }
      if (options.sourceId) {
        existing.sourceId = options.sourceId;
      }
      store.set(map, existing);
    }
  }

  function getStoredMapOptions(map) {
    if (!map) {
      return {};
    }
    const store = debugState.mapOptions;
    if (store && typeof store.get === 'function') {
      return store.get(map) || {};
    }
    return {};
  }

  function resolveMapCandidate(mapCandidate) {
    if (mapCandidate) {
      return mapCandidate;
    }
    if (debugState.lastAttachedMap) {
      return debugState.lastAttachedMap;
    }
    for (const candidate of debugState.maps) {
      return candidate;
    }
    return null;
  }

  function getTiles(options = {}) {
    const resolvedMap = resolveMapCandidate(options.map || options.mapInstance);
    if (!resolvedMap || !resolvedMap.style) {
      return [];
    }

    const storedOptions = getStoredMapOptions(resolvedMap);
    const resolvedSourceId = options.sourceId || options.source || storedOptions.sourceId || debugState.demSourceId;
    if (!resolvedSourceId) {
      return [];
    }

    const style = resolvedMap.style;
    let cache = null;
    try {
      const sourceCaches = style.sourceCaches || style._sourceCaches || {};
      cache = sourceCaches[resolvedSourceId] || (typeof style.getSourceCache === 'function' ? style.getSourceCache(resolvedSourceId) : null);
    } catch (error) {
      cache = null;
    }

    if (!cache) {
      return [];
    }

    const tiles = cache._tiles || cache.tiles || {};
    const results = [];
    const onlyRenderable = Boolean(options.onlyRenderable);
    const onlyPrepared = Boolean(options.onlyPrepared);

    const pushTile = (tile) => {
      if (!tile) return;
      if (onlyRenderable) {
        let renderable = false;
        try {
          renderable = typeof tile.isRenderable === 'function' ? tile.isRenderable(false) : tile.state === 'loaded' || tile.state === 'reloading';
        } catch (error) {
          renderable = false;
        }
        if (!renderable) {
          return;
        }
      }
      if (onlyPrepared) {
        if (!tile.fbo || !tile.fbo.colorAttachment || tile.needsHillshadePrepare) {
          return;
        }
      }
      results.push(tile);
    };

    if (Array.isArray(tiles)) {
      tiles.forEach(tile => pushTile(tile));
    } else if (tiles && typeof tiles === 'object') {
      Object.keys(tiles).forEach((key) => {
        pushTile(tiles[key]);
      });
    }

    return results;
  }

  function extractTileDebugInfo(tile) {
    const tileID = tile && tile.tileID;
    const canonical = tileID && tileID.canonical;
    const dem = tile && tile.dem;
    const demInfo = dem ? extractDemInfo(dem) : null;
    return {
      key: tileID && tileID.key ? tileID.key : null,
      canonical: canonical ? {
        z: canonical.z,
        x: canonical.x,
        y: canonical.y
      } : null,
      wrap: tileID ? tileID.wrap : null,
      state: tile ? tile.state : null,
      needsHillshadePrepare: tile ? tile.needsHillshadePrepare : null,
      neighboringTiles: tile && tile.neighboringTiles ? {...tile.neighboringTiles} : null,
      demTexture: tile && tile.demTexture ? true : false,
      demInfo
    };
  }

  function extractDemInfo(dem) {
    const info = {};
    const numericProps = ['stride', 'border', 'width', 'height', 'dim', 'tileSize', 'exaggeration', 'scale'];
    numericProps.forEach((prop) => {
      if (prop in dem && Number.isFinite(Number(dem[prop]))) {
        info[prop] = Number(dem[prop]);
      }
    });
    ['uid', 'encoding'].forEach((prop) => {
      if (prop in dem) {
        info[prop] = dem[prop];
      }
    });
    if (dem && typeof dem.get === 'function' && Number.isFinite(info.dim)) {
      info.borderSamples = sampleDemBorders(dem, info.dim);
    } else if (dem && ArrayBuffer.isView(dem.data)) {
      const array = dem.data;
      info.dataSample = captureTypedArraySample(array, debugState.options.indexSampleLimit);
    }
    if (dem && typeof dem.getBorderStatus === 'function') {
      const status = dem.getBorderStatus();
      info.borderStatus = status;
      const neighborKeys = [];
      for (const key in status) {
        if (Object.prototype.hasOwnProperty.call(status, key) && status[key] === 'neighbor') {
          neighborKeys.push(key);
        }
      }
      info.backfilledNeighbors = neighborKeys;
      info.hasNeighborBackfill = neighborKeys.length > 0;
    }
    return info;
  }

  function sampleDemBorders(dem, dim) {
    try {
      const size = Number(dim);
      if (!Number.isFinite(size) || size <= 0 || size > 2048) {
        return null;
      }
      const samples = {
        top: [],
        bottom: [],
        left: [],
        right: []
      };
      const maxSamples = 8;
      const step = Math.max(1, Math.floor(size / maxSamples));
      for (let i = 0; i < size; i += step) {
        samples.top.push(safelySampleDem(dem, i, 0));
        samples.bottom.push(safelySampleDem(dem, i, size - 1));
        samples.left.push(safelySampleDem(dem, 0, i));
        samples.right.push(safelySampleDem(dem, size - 1, i));
      }
      return samples;
    } catch (error) {
      console.warn('Failed to sample DEM border', error);
      return null;
    }
  }

  function safelySampleDem(dem, x, y) {
    try {
      if (typeof dem.get === 'function') {
        return dem.get(x, y);
      }
      if (ArrayBuffer.isView(dem.data)) {
        const index = y * (dem.stride || dem.width || 0) + x;
        if (index >= 0 && index < dem.data.length) {
          return dem.data[index];
        }
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function recordDemSnapshot(map) {
    if (!debugState.demSourceId) {
      return;
    }
    const snapshot = snapshotTerrainTiles(map, debugState.demSourceId);
    debugState.demSnapshots.push({
      timestamp: performance.now(),
      tiles: snapshot
    });
    if (debugState.demSnapshots.length > debugState.options.demHistoryLimit) {
      debugState.demSnapshots.splice(0, debugState.demSnapshots.length - debugState.options.demHistoryLimit);
    }
  }

  function watchTerrainSource(map, sourceId) {
    if (!map || !sourceId) {
      return;
    }
    debugState.demSourceId = sourceId;
    rememberMap(map, {sourceId});
    if (map.__hillshadeDemWatcherInstalled) {
      return;
    }
    map.on('sourcedata', (event) => {
      if (!debugState.enabled) {
        return;
      }
      if (!event || event.sourceId !== debugState.demSourceId) {
        return;
      }
      const entry = {
        timestamp: performance.now(),
        dataType: event.dataType,
        sourceId: event.sourceId,
        tileId: event.tile && event.tile.tileID ? event.tile.tileID.key : null,
        coord: event.coord ? { z: event.coord.z, x: event.coord.x, y: event.coord.y } : null,
        isSourceLoaded: event.isSourceLoaded || false
      };
      debugState.demEvents.push(entry);
      if (debugState.demEvents.length > debugState.options.demHistoryLimit) {
        debugState.demEvents.splice(0, debugState.demEvents.length - debugState.options.demHistoryLimit);
      }
      recordDemSnapshot(map);
    });
    map.__hillshadeDemWatcherInstalled = true;
  }

  function enable(options = {}) {
    Object.assign(debugState.options, options);
    debugState.enabled = true;
  }

  function disable() {
    debugState.enabled = false;
  }

  function setLayerTargets(layerIds) {
    debugState.targetLayerIds = new Set(Array.isArray(layerIds) ? layerIds.filter(Boolean) : []);
  }

  function addLayerTarget(layerId) {
    if (layerId) {
      debugState.targetLayerIds.add(layerId);
    }
  }

  function removeLayerTarget(layerId) {
    debugState.targetLayerIds.delete(layerId);
  }

  function getDrawCalls() {
    return debugState.drawCalls.slice();
  }

  function getDemEvents() {
    return debugState.demEvents.slice();
  }

  function getDemSnapshots() {
    return debugState.demSnapshots.slice();
  }

  function readTexture(gl, texture, width, height, options = {}) {
    if (!gl || !texture || typeof gl.createFramebuffer !== 'function') {
      return null;
    }
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const readWidth = Number(width) || 0;
    const readHeight = Number(height) || 0;
    const pixelCount = readWidth * readHeight * 4;
    const limit = options.sampleLimit || 1024;
    const pixels = new Uint8Array(pixelCount);
    gl.readPixels(0, 0, readWidth, readHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    return captureTypedArraySample(pixels, limit);
  }

  function attachToMap(map, { layerId, sourceId, autoHookLayer = true } = {}) {
    if (!map) {
      return;
    }
    rememberMap(map, {layerId, sourceId});
    if (sourceId) {
      watchTerrainSource(map, sourceId);
    }
    if (layerId) {
      addLayerTarget(layerId);
      if (autoHookLayer) {
        if (!hookLayerRender(map, layerId)) {
          map.once('styledata', () => {
            hookLayerRender(map, layerId);
          });
        }
      }
    }
  }

  const api = {
    __initialized: true,
    install: installCanvasHook,
    enable,
    disable,
    attachToMap,
    hookLayerRender,
    watchTerrainSource,
    addLayerTarget,
    removeLayerTarget,
    setLayerTargets,
    getTiles,
    getDrawCalls,
    getDemEvents,
    getDemSnapshots,
    readTexture,
    snapshotTerrainTiles,
    extractTileDebugInfo
  };

  window[globalKey] = api;
})();
