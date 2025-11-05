/* terrain-analysis.js */
(function() {
  const DEBUG = true;
  const EXTENT = 8192;
  const TILE_SIZE = 512;
  const DEM_MAX_ZOOM = 16; // native DEM max zoom
  
  // Global state variables
  let currentMode = ""; // "normal", "avalanche", "slope", "aspect", "snow", or "shadow"
  const meshCache = new Map();
  let snowAltitude = 3000;
  let snowMaxSlope = 55; // in degrees
  let shadowSampleCount = 5;
  let shadowBlurRadius = 1.5;
  let shadowMaxDistance = 800; // meters
  let shadowVisibilityThreshold = 0.02;
  let shadowEdgeSoftness = 0.16;
  let shadowMaxOpacity = 0.72;
  let shadowRayStepMultiplier = 1.0;
  let samplingDistance = 0.5;
  let shadowDateValue = null;
  let shadowTimeValue = null;
  let map;

  function getShadowDateTime() {
    const now = new Date();
    const dateStr = shadowDateValue || now.toISOString().slice(0, 10);
    const timeStr = shadowTimeValue || now.toISOString().slice(11, 16);
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

    const setDateFromSlider = (dayIndex) => {
      const baseDate = new Date(currentYear, 0, 1);
      baseDate.setDate(baseDate.getDate() + Number(dayIndex));
      const isoDate = `${baseDate.getFullYear()}-${String(baseDate.getMonth() + 1).padStart(2, '0')}-${String(baseDate.getDate()).padStart(2, '0')}`;
      shadowDateValue = isoDate;
      if (dateValue) dateValue.textContent = isoDate;
      if (map && currentMode === "shadow") map.triggerRepaint();
    };

    const setTimeFromSlider = (totalMinutes) => {
      const minutes = Math.max(0, Math.min(1439, Number(totalMinutes)));
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      const isoTime = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
      shadowTimeValue = isoTime;
      if (timeValue) timeValue.textContent = isoTime;
      if (map && currentMode === "shadow") map.triggerRepaint();
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
      timeSlider.max = 1439;
      const roundedMinutes = Math.round(defaultMinutes / 15) * 15;
      timeSlider.value = Math.min(1439, roundedMinutes);
      setTimeFromSlider(Number(timeSlider.value));
      timeSlider.addEventListener('input', (e) => {
        setTimeFromSlider(e.target.value);
      });
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
    return { dirX, dirY, altitude };
  }

  function getTerrainTileManager(mapInstance) {
    if (!mapInstance || !mapInstance.terrain) return null;
    const terrain = mapInstance.terrain;
    return terrain.tileManager || null;
  }

  // Update UI button states and slider visibility based on current mode
  function updateButtons() {
    document.getElementById('normalBtn').classList.toggle('active', currentMode === "normal");
    document.getElementById('avalancheBtn').classList.toggle('active', currentMode === "avalanche");
    document.getElementById('slopeBtn').classList.toggle('active', currentMode === "slope");
    document.getElementById('aspectBtn').classList.toggle('active', currentMode === "aspect");
    document.getElementById('snowBtn').classList.toggle('active', currentMode === "snow");
    document.getElementById('shadowBtn').classList.toggle('active', currentMode === "shadow");
    document.getElementById('snowSliderContainer').style.display = (currentMode === "snow") ? "block" : "none";
    document.getElementById('shadowControls').style.display = (currentMode === "shadow") ? "flex" : "none";
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
    if (map && currentMode === "shadow") {
      map.triggerRepaint();
    }
  };

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

  const samplingDistanceSlider = document.getElementById('samplingDistanceSlider');
  const samplingDistanceValue = document.getElementById('samplingDistanceValue');
  if (samplingDistanceSlider && samplingDistanceValue) {
    samplingDistanceValue.textContent = samplingDistance.toFixed(2);
    samplingDistanceSlider.addEventListener('input', (e) => {
      samplingDistance = Math.max(0.05, parseFloat(e.target.value));
      samplingDistanceValue.textContent = samplingDistance.toFixed(2);
      if (map) {
        map.triggerRepaint();
      }
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
      const uniforms = [
        'u_matrix',
        'u_projection_matrix',
        'u_projection_clipping_plane',
        'u_projection_transition',
        'u_projection_tile_mercator_coords',
        'u_projection_fallback_matrix',
        'u_image',
        'u_image_left',
        'u_image_right',
        'u_image_top',
        'u_image_bottom',
        'u_image_topLeft',
        'u_image_topRight',
        'u_image_bottomLeft',
        'u_image_bottomRight',
        'u_dimension',
        'u_original_vertex_count',
        'u_terrain_unpack',
        'u_terrain_exaggeration',
        'u_zoom',
        'u_latrange',
        'u_lightDir',
        'u_shadowsEnabled',
        'u_samplingDistance'
      ];
      if (currentMode === "snow") {
        uniforms.push('u_snow_altitude', 'u_snow_maxSlope');
      }
      if (currentMode === "shadow") {
        uniforms.push(
          'u_sunDirection',
          'u_sunAltitude',
          'u_shadowSampleCount',
          'u_shadowBlurRadius',
          'u_shadowMaxDistance',
          'u_shadowVisibilityThreshold',
          'u_shadowEdgeSoftness',
          'u_shadowMaxOpacity',
          'u_shadowRayStepMultiplier'
        );
      }
      const locations = {};
      uniforms.forEach(u => { locations[u] = gl.getUniformLocation(program, u); });
      const attributes = { a_pos: gl.getAttribLocation(program, 'a_pos') };
      const result = { program, locations, attributes };
      this.shaderMap.set(variantName, result);
      return result;
    },
  
    renderTiles(gl, shader, renderableTiles, tileManager) {
      if (!tileManager) return;
      const bindTexture = (texture, unit, uniformName) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.uniform1i(shader.locations[uniformName], unit);
      };
  
      // Keep track of successfully rendered tiles for debugging
      let renderedCount = 0;
      let skippedCount = 0;

      const terrainDataCache = new Map();
      const textureCache = new Map();

      for (const tile of renderableTiles) {
        const sourceTile = tileManager.getSourceTile(tile.tileID, true);
        if (!sourceTile || sourceTile.tileID.key !== tile.tileID.key) continue;
        const terrainData = this.map.terrain.getTerrainData(tile.tileID);
        if (!terrainData || !terrainData.texture || terrainData.fallback) continue;
        const canonical = tile.tileID.canonical;
        const cacheKey = `${canonical.z}/${canonical.x}/${canonical.y}`;
        terrainDataCache.set(tile.tileID.key, terrainData);
        textureCache.set(cacheKey, terrainData.texture);
      }

      const neighborOffsets = [
        { uniform: 'u_image_left', dx: -1, dy: 0 },
        { uniform: 'u_image_right', dx: 1, dy: 0 },
        { uniform: 'u_image_top', dx: 0, dy: -1 },
        { uniform: 'u_image_bottom', dx: 0, dy: 1 },
        { uniform: 'u_image_topLeft', dx: -1, dy: -1 },
        { uniform: 'u_image_topRight', dx: 1, dy: -1 },
        { uniform: 'u_image_bottomLeft', dx: -1, dy: 1 },
        { uniform: 'u_image_bottomRight', dx: 1, dy: 1 }
      ];

      const getNeighborTexture = (z, x, y, dx, dy, fallbackTexture) => {
        const nx = x + dx;
        const ny = y + dy;
        const key = `${z}/${nx}/${ny}`;
        if (textureCache.has(key)) return textureCache.get(key);
        return fallbackTexture;
      };

      const sunParams = currentMode === "shadow" ? computeSunParameters(this.map) : null;

      for (const tile of renderableTiles) {
        // Get the source tile to ensure we have the right tile for this position
        const sourceTile = tileManager.getSourceTile(tile.tileID, true);

        // Skip if no source tile or if it's a different tile (overscaled)
        if (!sourceTile || sourceTile.tileID.key !== tile.tileID.key) {
          if (DEBUG) console.log(`Skipping tile ${tile.tileID.key}: source tile mismatch or overscaled`);
          skippedCount++;
          continue;
        }
        
        // Get terrain data for the exact tile
        const terrainData = terrainDataCache.get(tile.tileID.key) || this.map.terrain.getTerrainData(tile.tileID);

        // Skip if no terrain data or texture
        if (!terrainData || !terrainData.texture) {
          if (DEBUG) console.log(`Skipping tile ${tile.tileID.key}: no terrain data or texture`);
          skippedCount++;
          continue;
        }
        
        // Skip fallback tiles as they might not align properly
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
        
        // Only bind texture if it exists
        if (terrainData.texture) {
          bindTexture(terrainData.texture, 0, 'u_image');
          if (currentMode === "shadow") {
            const canonical = tile.tileID.canonical;
            neighborOffsets.forEach((neighbor, index) => {
              const texture = getNeighborTexture(
                canonical.z,
                canonical.x,
                canonical.y,
                neighbor.dx,
                neighbor.dy,
                terrainData.texture
              );
              bindTexture(texture, index + 1, neighbor.uniform);
            });
          }
        }

        const projectionData = this.map.transform.getProjectionData({
          overscaledTileID: tile.tileID,
          applyGlobeMatrix: true
        });
        
        gl.uniform4f(shader.locations.u_projection_tile_mercator_coords,
          ...projectionData.tileMercatorCoords);
        gl.uniform4f(shader.locations.u_projection_clipping_plane, ...projectionData.clippingPlane);
        gl.uniform1f(shader.locations.u_projection_transition, projectionData.projectionTransition);
        gl.uniformMatrix4fv(shader.locations.u_projection_matrix, false, projectionData.mainMatrix);
        gl.uniformMatrix4fv(shader.locations.u_projection_fallback_matrix, false, projectionData.fallbackMatrix);
        gl.uniform2f(shader.locations.u_dimension, TILE_SIZE, TILE_SIZE);
        gl.uniform1i(shader.locations.u_original_vertex_count, mesh.originalVertexCount);
        gl.uniform1f(shader.locations.u_terrain_exaggeration, 1.0);
        const rgbaFactors = {
            r: 256.0,
            g: 1.0,
            b: 1.0 / 256.0,
            base: 32768.0
        };
        gl.uniform4f(
            shader.locations.u_terrain_unpack,
            rgbaFactors.r,
            rgbaFactors.g,
            rgbaFactors.b,
            rgbaFactors.base
        );
        gl.uniform2f(shader.locations.u_latrange, 47.0, 45.0);
        gl.uniform1f(shader.locations.u_zoom, tile.tileID.canonical.z);
        if (shader.locations.u_samplingDistance) {
          gl.uniform1f(shader.locations.u_samplingDistance, samplingDistance);
        }

        if (currentMode === "snow" && shader.locations.u_snow_altitude) {
          gl.uniform1f(shader.locations.u_snow_altitude, snowAltitude);
          gl.uniform1f(shader.locations.u_snow_maxSlope, snowMaxSlope);
        }
        if (currentMode === "shadow" && shader.locations.u_sunDirection) {
          if (sunParams) {
            gl.uniform2f(shader.locations.u_sunDirection, sunParams.dirX, sunParams.dirY);
            if (shader.locations.u_sunAltitude) {
              gl.uniform1f(shader.locations.u_sunAltitude, sunParams.altitude);
            }
          }
          if (shader.locations.u_shadowSampleCount) {
            gl.uniform1i(shader.locations.u_shadowSampleCount, shadowSampleCount);
          }
          if (shader.locations.u_shadowBlurRadius) {
            gl.uniform1f(shader.locations.u_shadowBlurRadius, shadowBlurRadius);
          }
          if (shader.locations.u_shadowMaxDistance) {
            gl.uniform1f(shader.locations.u_shadowMaxDistance, shadowMaxDistance);
          }
          if (shader.locations.u_shadowVisibilityThreshold) {
            gl.uniform1f(shader.locations.u_shadowVisibilityThreshold, shadowVisibilityThreshold);
          }
          if (shader.locations.u_shadowEdgeSoftness) {
            gl.uniform1f(shader.locations.u_shadowEdgeSoftness, shadowEdgeSoftness);
          }
          if (shader.locations.u_shadowMaxOpacity) {
            gl.uniform1f(shader.locations.u_shadowMaxOpacity, shadowMaxOpacity);
          }
          if (shader.locations.u_shadowRayStepMultiplier) {
            gl.uniform1f(shader.locations.u_shadowRayStepMultiplier, shadowRayStepMultiplier);
          }
        }

        gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, 0);
        renderedCount++;
      }
      
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
      const tileManager = getTerrainTileManager(this.map);
      if (!tileManager) {
        if (DEBUG) console.warn("Tile manager not available; skipping render");
        this.map.triggerRepaint();
        return;
      }

      if (tileManager.anyTilesAfterTime(Date.now() - 100)) {
        this.map.triggerRepaint();
        return;
      }

      const shader = this.getShader(gl, matrix.shaderData);
      if (!shader) return;
      gl.useProgram(shader.program);

      const renderableTiles = tileManager.getRenderableTiles();

      // Don't render if we have no tiles
      if (renderableTiles.length === 0) {
        if (DEBUG) console.log("No renderable tiles available");
        this.map.triggerRepaint();
        return;
      }
      
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.enable(gl.DEPTH_TEST);
      
      if (currentMode === "snow" || currentMode === "slope") {
        gl.depthFunc(gl.LESS);
        gl.colorMask(false, false, false, false);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        this.renderTiles(gl, shader, renderableTiles, tileManager);

        gl.colorMask(true, true, true, true);
        gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(
          gl.SRC_ALPHA,
          gl.ONE_MINUS_SRC_ALPHA,
          gl.ONE,
          gl.ONE_MINUS_SRC_ALPHA
        );
        this.renderTiles(gl, shader, renderableTiles, tileManager);
      } else {
        gl.depthFunc(gl.LEQUAL);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.BLEND);
        if (currentMode === "shadow") {
          gl.blendFuncSeparate(
            gl.SRC_ALPHA,
            gl.ONE_MINUS_SRC_ALPHA,
            gl.ONE,
            gl.ONE_MINUS_SRC_ALPHA
          );
        } else {
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        }
        this.renderTiles(gl, shader, renderableTiles, tileManager);
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
        swisstopo: {
          type: 'raster',
          tileSize: 256,
          tiles: ['https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg'],
          attribution: '© Swisstopo',
          maxzoom: 19
        },
        terrain: {
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
      terrain: { source: 'terrain', exaggeration: 1.0 },
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
  
  map.on('load', () => {
    console.log("Map loaded");
    map.setTerrain({ source: 'terrain', exaggeration: 1.0 });
    const tileManager = getTerrainTileManager(map);
    if (tileManager && typeof tileManager.deltaZoom === 'number') {
      tileManager.deltaZoom = 0;
    }
    console.log("Terrain layer initialized");
  });

  initializeShadowDateTimeControls();
  
  map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }));
  map.addControl(new maplibregl.GlobeControl());
  map.addControl(new maplibregl.TerrainControl());
  
  // Button click event listeners to toggle rendering modes.
  document.getElementById('normalBtn').addEventListener('click', () => { 
    currentMode = currentMode === "normal" ? "" : "normal";
    if (currentMode === "normal") {
      if (!map.getLayer("terrain-normal")) {
        terrainNormalLayer.frameCount = 0; // Reset frame counter
        map.addLayer(terrainNormalLayer);
      }
    } else {
      if (map.getLayer("terrain-normal")) map.removeLayer("terrain-normal");
    }
    terrainNormalLayer.shaderMap.clear();
    updateButtons();
    map.triggerRepaint();
  });
  
  document.getElementById('avalancheBtn').addEventListener('click', () => { 
    currentMode = currentMode === "avalanche" ? "" : "avalanche";
    if (currentMode === "avalanche") {
      if (!map.getLayer("terrain-normal")) {
        terrainNormalLayer.frameCount = 0; // Reset frame counter
        map.addLayer(terrainNormalLayer);
      }
    } else {
      if (map.getLayer("terrain-normal")) map.removeLayer("terrain-normal");
    }
    terrainNormalLayer.shaderMap.clear();
    updateButtons();
    map.triggerRepaint();
  });
  
  document.getElementById('slopeBtn').addEventListener('click', () => { 
    currentMode = currentMode === "slope" ? "" : "slope";
    if (currentMode === "slope") {
      if (!map.getLayer("terrain-normal")) {
        terrainNormalLayer.frameCount = 0; // Reset frame counter
        map.addLayer(terrainNormalLayer);
      }
    } else {
      if (map.getLayer("terrain-normal")) map.removeLayer("terrain-normal");
    }
    terrainNormalLayer.shaderMap.clear();
    updateButtons();
    map.triggerRepaint();
  });
  
  document.getElementById('aspectBtn').addEventListener('click', () => { 
    currentMode = currentMode === "aspect" ? "" : "aspect";
    if (currentMode === "aspect") {
      if (!map.getLayer("terrain-normal")) {
        terrainNormalLayer.frameCount = 0; // Reset frame counter
        map.addLayer(terrainNormalLayer);
      }
    } else {
      if (map.getLayer("terrain-normal")) map.removeLayer("terrain-normal");
    }
    terrainNormalLayer.shaderMap.clear();
    updateButtons();
    map.triggerRepaint();
  });
  
  document.getElementById('snowBtn').addEventListener('click', () => { 
    currentMode = currentMode === "snow" ? "" : "snow";
    if (currentMode === "snow") {
      if (!map.getLayer("terrain-normal")) {
        terrainNormalLayer.frameCount = 0; // Reset frame counter
        map.addLayer(terrainNormalLayer);
      }
    } else {
      if (map.getLayer("terrain-normal")) map.removeLayer("terrain-normal");
    }
    terrainNormalLayer.shaderMap.clear();
    updateButtons();
    map.triggerRepaint();
  });
  
  document.getElementById('shadowBtn').addEventListener('click', () => { 
    currentMode = currentMode === "shadow" ? "" : "shadow";
    if (currentMode === "shadow") {
      if (!map.getLayer("terrain-normal")) {
        terrainNormalLayer.frameCount = 0; // Reset frame counter
        map.addLayer(terrainNormalLayer);
      }
    } else {
      if (map.getLayer("terrain-normal")) map.removeLayer("terrain-normal");
    }
    terrainNormalLayer.shaderMap.clear();
    updateButtons();
    map.triggerRepaint();
  });
  
  window.addEventListener('unload', () => { meshCache.clear(); });

})();
