/* terrain-shaders.js */
const SHADER_MAX_NEIGHBOR_OFFSET = 2;
const SHADER_NEIGHBOR_NAME_OVERRIDES = {
  '-1,0': 'u_image_left',
  '1,0': 'u_image_right',
  '0,-1': 'u_image_top',
  '0,1': 'u_image_bottom',
  '-1,-1': 'u_image_topLeft',
  '1,-1': 'u_image_topRight',
  '-1,1': 'u_image_bottomLeft',
  '1,1': 'u_image_bottomRight'
};

function shaderFormatOffsetPart(value) {
  if (value === 0) {
    return '0';
  }
  const prefix = value < 0 ? 'm' : 'p';
  return `${prefix}${Math.abs(value)}`;
}

function shaderUniformNameForOffset(dx, dy) {
  const key = `${dx},${dy}`;
  if (SHADER_NEIGHBOR_NAME_OVERRIDES[key]) {
    return SHADER_NEIGHBOR_NAME_OVERRIDES[key];
  }
  return `u_image_${shaderFormatOffsetPart(dx)}_${shaderFormatOffsetPart(dy)}`;
}

function shaderMetersUniformNameForOffset(dx, dy) {
  const base = shaderUniformNameForOffset(dx, dy);
  return base.replace('u_image', 'u_metersPerPixel');
}

function shaderBuildNeighborOffsets(maxOffset) {
  const offsets = [];
  for (let dy = -maxOffset; dy <= maxOffset; dy++) {
    for (let dx = -maxOffset; dx <= maxOffset; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (Math.abs(dx) + Math.abs(dy) > maxOffset) continue;
      offsets.push({
        dx,
        dy,
        uniform: shaderUniformNameForOffset(dx, dy),
        metersUniform: shaderMetersUniformNameForOffset(dx, dy)
      });
    }
  }
  return offsets;
}

const SHADER_NEIGHBOR_OFFSETS = shaderBuildNeighborOffsets(SHADER_MAX_NEIGHBOR_OFFSET);
const SHADER_NEIGHBOR_UNIFORM_DECLARATIONS = SHADER_NEIGHBOR_OFFSETS
  .map(({ uniform }) => `    uniform sampler2D ${uniform};`)
  .join('\n');
const SHADER_NEIGHBOR_UNIFORM_BLOCK = SHADER_NEIGHBOR_UNIFORM_DECLARATIONS
  ? `${SHADER_NEIGHBOR_UNIFORM_DECLARATIONS}\n`
  : '';
const SHADER_NEIGHBOR_METERS_DECLARATIONS = SHADER_NEIGHBOR_OFFSETS
  .map(({ metersUniform }) => `    uniform float ${metersUniform};`)
  .join('\n');
const SHADER_NEIGHBOR_METERS_UNIFORM_BLOCK = SHADER_NEIGHBOR_METERS_DECLARATIONS
  ? `${SHADER_NEIGHBOR_METERS_DECLARATIONS}\n`
  : '';
const SHADER_NEIGHBOR_FETCH_CASES = SHADER_NEIGHBOR_OFFSETS
  .map(({ dx, dy, uniform }) => `      if (offset == ivec2(${dx}, ${dy})) {\n        return getElevationFromTexture(${uniform}, tilePos);\n      }`)
  .join('\n');
const SHADER_NEIGHBOR_FETCH_BLOCK = SHADER_NEIGHBOR_FETCH_CASES
  ? `\n${SHADER_NEIGHBOR_FETCH_CASES}\n`
  : '';
const SHADER_NEIGHBOR_FETCH_CASES_LOD = SHADER_NEIGHBOR_OFFSETS
  .map(({ dx, dy, uniform }) => `      if (offset == ivec2(${dx}, ${dy})) {\n        return getElevationFromTextureLod(${uniform}, tilePos, lod);\n      }`)
  .join('\n');
const SHADER_NEIGHBOR_FETCH_BLOCK_LOD = SHADER_NEIGHBOR_FETCH_CASES_LOD
  ? `\n${SHADER_NEIGHBOR_FETCH_CASES_LOD}\n`
  : '';
const SHADER_NEIGHBOR_METERS_CASES = SHADER_NEIGHBOR_OFFSETS
  .map(({ dx, dy, metersUniform }) => `      if (offset == ivec2(${dx}, ${dy})) {\n        return max(${metersUniform}, 0.0);\n      }`)
  .join('\n');
const SHADER_NEIGHBOR_METERS_BLOCK = SHADER_NEIGHBOR_METERS_CASES
  ? `\n${SHADER_NEIGHBOR_METERS_CASES}\n`
  : '';

const TerrainShaders = {
  // Common GLSL functions shared among the fragment shaders.
  commonFunctions: `
    precision highp float;
    precision highp int;
    uniform sampler2D u_image;
    uniform sampler2D u_hillshade_gradient;
    ${SHADER_NEIGHBOR_UNIFORM_BLOCK}
    uniform vec4 u_terrain_unpack;
    uniform vec2 u_dimension;
    uniform float u_zoom;
    uniform float u_metersPerPixel;
${SHADER_NEIGHBOR_METERS_UNIFORM_BLOCK}    uniform vec2 u_latrange;
    uniform float u_hillshade_gradient_available;

    vec3 srgbToLinear(vec3 color) {
      vec3 srgb = clamp(color, 0.0, 1.0);
      vec3 lo = srgb / 12.92;
      vec3 hi = pow((srgb + 0.055) / 1.055, vec3(2.4));
      return mix(lo, hi, step(vec3(0.04045), srgb));
    }

    vec4 srgbToLinear(vec4 color) {
      return vec4(srgbToLinear(color.rgb), color.a);
    }

    vec3 linearToSrgb(vec3 color) {
      vec3 linear = max(color, vec3(0.0));
      vec3 lo = linear * 12.92;
      vec3 hi = 1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055;
      return mix(lo, hi, step(vec3(0.0031308), linear));
    }

    vec4 linearToSrgb(vec4 color) {
      return vec4(linearToSrgb(color.rgb), color.a);
    }

    float getElevationFromTexture(sampler2D tex, vec2 pos) {
      vec3 data = texture(tex, pos).rgb * 255.0;
      // Terrarium encoding: elevation = (R * 256 + G + B / 256) - 32768
      return dot(data, vec3(256.0, 1.0, 1.0 / 256.0)) - 32768.0;
    }

    float getElevationFromTextureLod(sampler2D tex, vec2 pos, float lod) {
      vec3 data = textureLod(tex, pos, lod).rgb * 255.0;
      return dot(data, vec3(256.0, 1.0, 1.0 / 256.0)) - 32768.0;
    }

    float reflectCoord(float coord, float minBound, float maxBound) {
      float span = max(maxBound - minBound, 0.0);
      if (span <= 0.0) {
        return minBound;
      }
      float twoSpan = span * 2.0;
      float offset = coord - minBound;
      float wrapped = mod(offset, twoSpan);
      if (wrapped < 0.0) {
        wrapped += twoSpan;
      }
      float reflected = wrapped <= span ? wrapped : (twoSpan - wrapped);
      return minBound + reflected;
    }

    vec2 clampTexCoord(vec2 pos) {
      float borderX = 0.5 / u_dimension.x;
      float borderY = 0.5 / u_dimension.y;
      float minX = borderX;
      float maxX = 1.0 - borderX;
      float minY = borderY;
      float maxY = 1.0 - borderY;
      return vec2(
        reflectCoord(pos.x, minX, maxX),
        reflectCoord(pos.y, minY, maxY)
      );
    }

    vec2 resolveNeighborCoords(vec2 pos, out ivec2 offset) {
      vec2 tilePos = pos;
      offset = ivec2(0);
      const int MAX_OFFSET = ${SHADER_MAX_NEIGHBOR_OFFSET};
      for (int i = 0; i < ${SHADER_MAX_NEIGHBOR_OFFSET * 4}; ++i) {
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
      return clampTexCoord(tilePos);
    }

    float fetchElevationForOffset(ivec2 offset, vec2 tilePos) {
      if (offset == ivec2(0, 0)) {
        return getElevationFromTexture(u_image, tilePos);
      }${SHADER_NEIGHBOR_FETCH_BLOCK}      return getElevationFromTexture(u_image, tilePos);
    }

    float fetchElevationForOffsetLod(ivec2 offset, vec2 tilePos, float lod) {
      if (offset == ivec2(0, 0)) {
        return getElevationFromTextureLod(u_image, tilePos, lod);
      }${SHADER_NEIGHBOR_FETCH_BLOCK_LOD}      return getElevationFromTextureLod(u_image, tilePos, lod);
    }

    float getMetersPerPixelForOffset(ivec2 offset) {
      if (offset == ivec2(0, 0)) {
        return max(u_metersPerPixel, 0.0);
      }${SHADER_NEIGHBOR_METERS_BLOCK}      return max(u_metersPerPixel, 0.0);
    }

    float getElevationExtended(vec2 pos) {
      ivec2 offset;
      vec2 tilePos = resolveNeighborCoords(pos, offset);
      return fetchElevationForOffset(offset, tilePos);
    }

    float computeRaySampleLod(float horizontalMeters, float metersPerPixel) {
      float texelFootprint = horizontalMeters / max(metersPerPixel, 0.0001);
      float lod = log2(max(texelFootprint, 1.0)) - 2.0;
      return clamp(lod, 0.0, 8.0);
    }

    float sampleElevationAdaptive(vec2 pos, float horizontalMeters, float metersPerPixel) {
      ivec2 offset;
      vec2 tilePos = resolveNeighborCoords(pos, offset);
      float localMetersPerPixel = getMetersPerPixelForOffset(offset);
      if (localMetersPerPixel <= 0.0) {
        localMetersPerPixel = metersPerPixel;
      }
      localMetersPerPixel = max(localMetersPerPixel, 0.0001);
      float lod = computeRaySampleLod(horizontalMeters, localMetersPerPixel);
      if (lod <= 0.001) {
        return fetchElevationForOffset(offset, tilePos);
      }
      return fetchElevationForOffsetLod(offset, tilePos, lod);
    }

    float computeAdaptiveStepGrowth(float horizontalMeters) {
      float t = clamp(horizontalMeters / 6000.0, 0.0, 1.0);
      return mix(1.04, 1.10, t);
    }

    vec2 computeSobelGradient(vec2 pos) {
      float samplingDistance = 0.5;
      vec2 safePos = clampTexCoord(pos);
      float metersPerPixel = 1.5 * pow(2.0, 16.0 - u_zoom);
      float metersPerTile  = metersPerPixel * 256.0;
      float delta = samplingDistance / metersPerTile;

      float tl = getElevationExtended(safePos + vec2(-delta, -delta));
      float tm = getElevationExtended(safePos + vec2(0.0, -delta));
      float tr = getElevationExtended(safePos + vec2(delta, -delta));
      float ml = getElevationExtended(safePos + vec2(-delta, 0.0));
      float mr = getElevationExtended(safePos + vec2(delta, 0.0));
      float bl = getElevationExtended(safePos + vec2(-delta, delta));
      float bm = getElevationExtended(safePos + vec2(0.0, delta));
      float br = getElevationExtended(safePos + vec2(delta, delta));

      float gx = (-tl + tr - 2.0 * ml + 2.0 * mr - bl + br) / (8.0 * samplingDistance);
      float gy = (-tl - 2.0 * tm - tr + bl + 2.0 * bm + br) / (8.0 * samplingDistance);

      return vec2(gx, gy);
    }

    float computeLatitudeForTexCoord(float y) {
      return (u_latrange.x - u_latrange.y) * (1.0 - y) + u_latrange.y;
    }

    vec2 samplePrefilteredHillshadeGradient(vec2 pos) {
      vec2 safePos = clampTexCoord(pos);
      vec2 encoded = texture(u_hillshade_gradient, safePos).rg;
      float latitude = computeLatitudeForTexCoord(safePos.y);
      float scaleFactor = max(abs(cos(radians(latitude))), 0.000001);
      return ((encoded * 8.0) - 4.0) / scaleFactor;
    }

    vec2 getHillshadeGradient(vec2 pos) {
      if (u_hillshade_gradient_available > 0.5) {
        return samplePrefilteredHillshadeGradient(pos);
      }
      return computeSobelGradient(pos);
    }
  `,

  // Vertex shader
  getVertexShader: function(shaderDescription, extent) {
    return `#version 300 es
      precision highp float;
      precision highp int;
      ${shaderDescription.vertexShaderPrelude}
      ${shaderDescription.define}

      uniform sampler2D u_image;
      uniform vec2 u_dimension;
      uniform int    u_original_vertex_count;
      uniform vec4   u_terrain_unpack;
      uniform float  u_terrain_exaggeration;

      in  highp vec2 a_pos;
      out highp vec2 v_texCoord;
      out highp float v_elevation;
      out highp float v_isWall;
      out highp vec2 v_uv;
      out highp float v_depth;

      float getElevation(vec2 pos) {
        vec4 data = texture(u_image, pos) * 255.0;
        return (data.r * u_terrain_unpack[0]
              + data.g * u_terrain_unpack[1]
              + data.b * u_terrain_unpack[2])
              - u_terrain_unpack[3];
      }

      void main() {
        v_texCoord   = a_pos / float(${extent});
        float elev   = getElevation(v_texCoord);
        v_elevation  = elev;
        v_isWall     = float(gl_VertexID >= u_original_vertex_count);
        v_uv         = v_texCoord;
        float finalE = (v_isWall > 0.5)
                       ? elev - 50.0
                       : elev;
        gl_Position  = projectTileFor3D(a_pos, finalE);
        v_depth      = gl_Position.z / gl_Position.w;
      }`;
  },

  // Fragment shaders
  getFragmentShader: function(mode) {
    const registry = typeof window !== 'undefined' ? window.terrainCustomShaderSources : null;
    if (registry && typeof registry[mode] === 'function') {
      return registry[mode](this.commonFunctions);
    }
    return '';
  }
};

