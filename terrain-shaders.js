/* terrain-shaders.js */
const SHADER_MAX_NEIGHBOR_OFFSET = 2;
const DAYLIGHT_SHADER_SAMPLE_CAP = 16;
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

function shaderBuildNeighborOffsets(maxOffset) {
  const offsets = [];
  for (let dy = -maxOffset; dy <= maxOffset; dy++) {
    for (let dx = -maxOffset; dx <= maxOffset; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (Math.abs(dx) + Math.abs(dy) > maxOffset) continue;
      offsets.push({ dx, dy, uniform: shaderUniformNameForOffset(dx, dy) });
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

const TerrainShaders = {
  // Common GLSL functions shared among the fragment shaders.
  commonFunctions: `
    precision highp float;
    precision highp int;
    uniform sampler2D u_image;
${SHADER_NEIGHBOR_UNIFORM_BLOCK}    uniform sampler2D u_gradient;
    uniform vec4 u_terrain_unpack;
    uniform vec2 u_dimension;
    uniform float u_zoom;
    uniform float u_metersPerPixel;
    uniform vec2 u_latrange;
    uniform float u_samplingDistance;
    uniform int u_usePrecomputedGradient;

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

    float getElevationExtended(vec2 pos) {
      vec2 tilePos = pos;
      ivec2 offset = ivec2(0);
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
      tilePos = clampTexCoord(tilePos);
${SHADER_NEIGHBOR_FETCH_BLOCK}      return getElevationFromTexture(u_image, tilePos);
    }

    float getElevationExtendedLod(vec2 pos, float lod) {
      vec2 tilePos = pos;
      ivec2 offset = ivec2(0);
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
      tilePos = clampTexCoord(tilePos);
${SHADER_NEIGHBOR_FETCH_BLOCK_LOD}      return getElevationFromTextureLod(u_image, tilePos, lod);
    }

    float computeRaySampleLod(float horizontalMeters, float metersPerPixel) {
      float texelFootprint = horizontalMeters / max(metersPerPixel, 0.0001);
      float lod = log2(max(texelFootprint, 1.0)) - 2.0;
      return clamp(lod, 0.0, 8.0);
    }

    float sampleElevationAdaptive(vec2 pos, float horizontalMeters, float metersPerPixel) {
      float lod = computeRaySampleLod(horizontalMeters, metersPerPixel);
      if (lod <= 0.001) {
        return getElevationExtended(pos);
      }
      return getElevationExtendedLod(pos, lod);
    }

    float computeAdaptiveStepGrowth(float horizontalMeters) {
      float t = clamp(horizontalMeters / 6000.0, 0.0, 1.0);
      return mix(1.04, 1.10, t);
    }

    vec2 computeSobelGradient(vec2 pos) {
      if (u_usePrecomputedGradient == 1) {
        vec2 safePos = clampTexCoord(pos);
        vec2 precomputed = texture(u_gradient, safePos).rg;
        return precomputed;
      }
      vec2 safePos = pos;
      float metersPerPixel = max(u_metersPerPixel, 0.0001);
      float metersPerTile  = metersPerPixel * u_dimension.x;
      float sampleDist = max(u_samplingDistance, 0.0001);
      float delta = sampleDist / metersPerTile;
      float denom = 2.0 * sampleDist;

      vec2 dx = vec2(delta, 0.0);
      vec2 dy = vec2(0.0, delta);

      float left = getElevationExtended(safePos - dx);
      float right = getElevationExtended(safePos + dx);
      float top = getElevationExtended(safePos - dy);
      float bottom = getElevationExtended(safePos + dy);

      float gx = (right - left) / denom;
      float gy = (bottom - top) / denom;

      return vec2(gx, gy);
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
        float finalE = (v_isWall > 0.5)
                       ? elev - 50.0
                       : elev;
        gl_Position  = projectTileFor3D(a_pos, finalE);
      }`;
  },

  // Fragment shaders
  getFragmentShader: function(mode) {
    switch(mode) {
      case "hillshade":
        return `#version 300 es
        precision highp float;
        precision highp int;
        ${this.commonFunctions}
        uniform vec3  u_hillshade_highlight_color;
        uniform vec3  u_hillshade_shadow_color;
        uniform vec3  u_hillshade_accent_color;
        uniform float u_hillshade_exaggeration;
        uniform vec2  u_hillshade_light_dir;
        uniform float u_hillshade_light_altitude;
        uniform float u_hillshade_opacity;
        in  highp vec2 v_texCoord;
        out vec4 fragColor;

        vec3 getHillshadeLightVector() {
          float cosAlt = cos(u_hillshade_light_altitude);
          vec2 dir = normalize(u_hillshade_light_dir);
          return normalize(vec3(dir.x * cosAlt, dir.y * cosAlt, sin(u_hillshade_light_altitude)));
        }

        vec3 evaluateHillshade(vec2 grad) {
          vec2 scaledGrad = grad * u_hillshade_exaggeration;
          vec3 normal = normalize(vec3(-scaledGrad.x, -scaledGrad.y, 1.0));
          vec3 lightDir = getHillshadeLightVector();
          float diffuse = clamp(dot(normal, lightDir), -1.0, 1.0);
          float shade = clamp(0.5 + 0.5 * diffuse, 0.0, 1.0);
          vec3 baseColor = mix(u_hillshade_shadow_color, u_hillshade_highlight_color, shade);
          float accent = pow(clamp(1.0 - normal.z, 0.0, 1.0), 2.0);
          return mix(baseColor, u_hillshade_accent_color, accent);
        }

        void main() {
          vec2 grad = computeSobelGradient(v_texCoord);
          vec3 color = evaluateHillshade(grad);
          fragColor = vec4(color, u_hillshade_opacity);
        }`;

      case "normal":
        return `#version 300 es
        precision highp float;
        precision highp int;
        ${this.commonFunctions}
        in  highp vec2 v_texCoord;
        out vec4 fragColor;
        void main() {
          vec2 grad   = computeSobelGradient(v_texCoord);
          vec3 normal = normalize(vec3(-grad, 1.0));
          fragColor   = vec4(normal * 0.5 + 0.5, 1.0);
        }`;

      case "avalanche":
        return `#version 300 es
        precision highp float;
        precision highp int;
        ${this.commonFunctions}
        in  highp vec2 v_texCoord;
        out vec4 fragColor;
        float computeSlopeDegrees(vec2 pos) {
          vec2 g = computeSobelGradient(pos);
          return degrees(atan(length(g)));
        }
        void main() {
          float slope = computeSlopeDegrees(v_texCoord);
          float alpha = smoothstep(30.0, 35.0, slope);
          vec3 color  = slope < 30.0 ? vec3(0.0) :
                        slope < 35.0 ? vec3(226.0,190.0,27.0)/255.0 :
                        slope < 40.0 ? vec3(216.0,114.0,27.0)/255.0 :
                        slope < 45.0 ? vec3(226.0,27.0,27.0)/255.0 :
                                       vec3(184.0,130.0,173.0)/255.0;
          fragColor = vec4(color, alpha);
        }`;

      case "slope":
        return `#version 300 es
        precision highp float;
        precision highp int;
        ${this.commonFunctions}
        in  highp vec2 v_texCoord;
        out vec4 fragColor;
        float computeSlopeDegrees(vec2 pos) {
          vec2 g = computeSobelGradient(pos);
          return degrees(atan(length(g)));
        }
        vec3 getColorForSlope(float slope) {
          slope = min(slope, 90.0);
          vec3 colors[9] = vec3[](
            vec3(0.0, 0.9, 0.75), vec3(0.4, 0.9, 0.36),
            vec3(0.87,0.87,0.0), vec3(1.0, 0.7, 0.0),
            vec3(1.0, 0.28,0.2), vec3(0.87,0.0, 0.43),
            vec3(0.6, 0.0, 0.58), vec3(0.41,0.0, 0.58),
            vec3(0.3, 0.0, 0.53)
          );
          float stops[9] = float[](5.0,15.0,25.0,35.0,45.0,55.0,65.0,75.0,90.0);
          for (int i = 0; i < 8; i++) {
            if (slope <= stops[i+1]) {
              float t = (slope - stops[i]) / (stops[i+1] - stops[i]);
              return mix(colors[i], colors[i+1], smoothstep(0.0,1.0,t));
            }
          }
          return colors[8];
        }
        void main() {
          float slope   = computeSlopeDegrees(v_texCoord);
          vec3 color    = getColorForSlope(slope);
          fragColor     = vec4(color, 0.7);
        }`;

      case "aspect":
        return `#version 300 es
        precision highp float;
        precision highp int;
        ${this.commonFunctions}
        in  highp vec2 v_texCoord;
        out vec4 fragColor;
        void main() {
          vec2 grad = computeSobelGradient(v_texCoord);
          grad = -grad;
          float aspect = mod(degrees(atan(grad.x, grad.y)) + 180.0, 360.0);
          vec3 color;
          if      (aspect >= 337.5 || aspect < 22.5)  color = vec3(0.47,1.0,1.0);
          else if (aspect <  67.5)                    color = vec3(0.48,0.76,1.0);
          else if (aspect < 112.5)                    color = vec3(1.0,1.0,1.0);
          else if (aspect < 157.5)                    color = vec3(1.0,0.7,0.52);
          else if (aspect < 202.5)                    color = vec3(1.0,0.3,0.0);
          else if (aspect < 247.5)                    color = vec3(0.48,0.14,0.0);
          else if (aspect < 292.5)                    color = vec3(0.16,0.16,0.16);
          else                                         color = vec3(0.0, 0.21,0.47);
          fragColor = vec4(color, 0.9);
        }`;

      case "snow":
        return `#version 300 es
        precision highp float;
        ${this.commonFunctions}
        uniform float u_snow_altitude;
        uniform float u_snow_maxSlope;
        in vec2 v_texCoord;
        in float v_elevation;
        out vec4 fragColor;
        float computeSlopeDegrees(vec2 pos) {
            return degrees(atan(length(computeSobelGradient(pos))));
        }
        float getAspect(vec2 grad) {
            float aspect = degrees(atan(grad.x, grad.y));
            return mod(aspect + 180.0, 360.0);
        }
        float getSnowCoverageForElevation(float elevation, float aspect) {
            float aspectFactor = smoothstep(180.0, 0.0, aspect) * 0.5 + 0.5;
            float lowBand = 2000.0;
            float midBand = 3400.0;
            float highBand = 4100.0;
            float coverage;
            if (elevation < lowBand) {
                coverage = 1.0 * aspectFactor;
            } else if (elevation < midBand) {
                float t = (elevation - lowBand) / (midBand - lowBand);
                coverage = mix(1.0, 2.5, t) * aspectFactor;
            } else if (elevation < highBand) {
                float t = (elevation - midBand) / (highBand - midBand);
                coverage = mix(2.5, 3.0, t) * aspectFactor;
            } else {
                coverage = 3.0 * aspectFactor;
            }
            return coverage;
        }
        vec3 evaluateSnowHillshade(vec2 grad) {
            vec3 normal = normalize(vec3(-grad, 1.0));
            vec3 lightDir = normalize(vec3(0.45, 0.35, 0.82));
            float diffuse = clamp(dot(normal, lightDir), -1.0, 1.0);
            float shade = clamp(0.55 + 0.45 * diffuse, 0.0, 1.0);
            vec3 shadowColor = vec3(0.78, 0.82, 0.86);
            vec3 highlightColor = vec3(1.0);
            return mix(shadowColor, highlightColor, shade);
        }
        void main() {
            vec2 grad = computeSobelGradient(v_texCoord);
            float aspect = getAspect(grad);
            float slope  = computeSlopeDegrees(v_texCoord);
            float altitudeMask = smoothstep(
                u_snow_altitude + 100.0,
                u_snow_altitude + 200.0,
                v_elevation
            );
            float slopeMask = step(slope, u_snow_maxSlope);
            float snowCoverage = getSnowCoverageForElevation(v_elevation, aspect);
            vec3 snowColor = evaluateSnowHillshade(grad);
            float finalMask = clamp(altitudeMask * slopeMask * snowCoverage, 0.0, 1.0);
            fragColor = vec4(snowColor, finalMask * 0.95);
        }`;

      case "shadow":
        return `#version 300 es
        precision highp float;
        precision highp int;
        ${this.commonFunctions}
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
        in  highp vec2  v_texCoord;
        in  highp float v_elevation;
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
          float minBound = -${SHADER_MAX_NEIGHBOR_OFFSET}.0;
          float maxBound = 1.0 + ${SHADER_MAX_NEIGHBOR_OFFSET}.0;
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
          float visibility = computeSunVisibility(v_texCoord, v_elevation);
          vec2 grad = computeSobelGradient(v_texCoord);
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

      case "daylight":
        return `#version 300 es
        precision highp float;
        precision highp int;
        ${this.commonFunctions}
        uniform int   u_daylightSampleCount;
        uniform vec2  u_daylightSunDir[${DAYLIGHT_SHADER_SAMPLE_CAP}];
        uniform float u_daylightSunAltitude[${DAYLIGHT_SHADER_SAMPLE_CAP}];
        uniform float u_daylightSampleWeight[${DAYLIGHT_SHADER_SAMPLE_CAP}];
        uniform float u_daylightSampleTime[${DAYLIGHT_SHADER_SAMPLE_CAP}];
        uniform int   u_shadowSampleCount;
        uniform float u_shadowBlurRadius;
        uniform float u_shadowMaxDistance;
        uniform float u_shadowVisibilityThreshold;
        uniform float u_shadowEdgeSoftness;
        uniform float u_shadowRayStepMultiplier;
        in  highp vec2  v_texCoord;
        in  highp float v_elevation;
        out vec4 fragColor;

        const int MAX_DAYLIGHT_STEPS = 320;
        const int MAX_DAYLIGHT_KERNEL_SAMPLES = 32;
        const int MAX_DAYLIGHT_SAMPLES = ${DAYLIGHT_SHADER_SAMPLE_CAP};

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
          float minBound = -${SHADER_MAX_NEIGHBOR_OFFSET}.0;
          float maxBound = 1.0 + ${SHADER_MAX_NEIGHBOR_OFFSET}.0;
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
            float visibility = computeDaylightVisibility(v_texCoord, v_elevation, sunDir, altitude);
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

      default:
        return '';
    }
  }
};

