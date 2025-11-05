/* terrain-shaders.js */
const TerrainShaders = {
  // Common GLSL functions shared among the fragment shaders.
  commonFunctions: `
    precision highp float;
    precision highp int;
    uniform sampler2D u_image;
    uniform vec4 u_terrain_unpack;
    uniform vec2 u_dimension;
    uniform float u_zoom;
    uniform vec2 u_latrange;

    const int MAX_TILE_TEXTURES = 15;
    const int MAX_TILE_LOOKUP = 64;

    uniform int u_tileTextureCount;
    uniform int u_tileLookupCount;
    uniform vec2 u_globalTileOrigin;
    uniform sampler2D u_tileSamplers[MAX_TILE_TEXTURES];
    uniform ivec4 u_tileLookup[MAX_TILE_LOOKUP];
    uniform vec4 u_tileTransform[MAX_TILE_LOOKUP];
    uniform vec2 u_tileCoord;
    uniform float u_tileScale;

    float getElevationFromTexture(sampler2D tex, vec2 pos) {
      vec3 data = texture(tex, pos).rgb * 255.0;
      // Terrarium encoding: elevation = (R * 256 + G + B / 256) - 32768
      return dot(data, vec3(256.0, 1.0, 1.0 / 256.0)) - 32768.0;
    }

    vec2 clampTexCoord(vec2 pos) {
      float border = 1.0 / u_dimension.x;
      return clamp(pos, vec2(border), vec2(1.0 - border));
    }

    float sampleElevationFromSamplers(int samplerIndex, vec2 pos) {
      float elevation = 0.0;
      vec2 uv = clampTexCoord(pos);
      if (samplerIndex == 0) {
        elevation = getElevationFromTexture(u_tileSamplers[0], uv);
      } else if (samplerIndex == 1) {
        elevation = getElevationFromTexture(u_tileSamplers[1], uv);
      } else if (samplerIndex == 2) {
        elevation = getElevationFromTexture(u_tileSamplers[2], uv);
      } else if (samplerIndex == 3) {
        elevation = getElevationFromTexture(u_tileSamplers[3], uv);
      } else if (samplerIndex == 4) {
        elevation = getElevationFromTexture(u_tileSamplers[4], uv);
      } else if (samplerIndex == 5) {
        elevation = getElevationFromTexture(u_tileSamplers[5], uv);
      } else if (samplerIndex == 6) {
        elevation = getElevationFromTexture(u_tileSamplers[6], uv);
      } else if (samplerIndex == 7) {
        elevation = getElevationFromTexture(u_tileSamplers[7], uv);
      } else if (samplerIndex == 8) {
        elevation = getElevationFromTexture(u_tileSamplers[8], uv);
      } else if (samplerIndex == 9) {
        elevation = getElevationFromTexture(u_tileSamplers[9], uv);
      } else if (samplerIndex == 10) {
        elevation = getElevationFromTexture(u_tileSamplers[10], uv);
      } else if (samplerIndex == 11) {
        elevation = getElevationFromTexture(u_tileSamplers[11], uv);
      } else if (samplerIndex == 12) {
        elevation = getElevationFromTexture(u_tileSamplers[12], uv);
      } else if (samplerIndex == 13) {
        elevation = getElevationFromTexture(u_tileSamplers[13], uv);
      } else if (samplerIndex == 14) {
        elevation = getElevationFromTexture(u_tileSamplers[14], uv);
      }
      return elevation;
    }

    int findTileLookupIndex(ivec2 tileIndex) {
      for (int i = 0; i < MAX_TILE_LOOKUP; i++) {
        if (i >= u_tileLookupCount) {
          break;
        }
        ivec4 entry = u_tileLookup[i];
        if (entry.x == tileIndex.x && entry.y == tileIndex.y) {
          return i;
        }
      }
      return -1;
    }

    float sampleElevationFromLookup(int lookupIndex, vec2 localBase, vec2 absoluteCoord) {
      if (lookupIndex < 0) {
        vec2 fallbackOrigin = vec2(u_tileCoord) * u_tileScale;
        vec2 fallbackLocal = (absoluteCoord - fallbackOrigin) / max(u_tileScale, 0.0001);
        return getElevationFromTexture(u_image, clampTexCoord(fallbackLocal));
      }
      ivec4 entry = u_tileLookup[lookupIndex];
      int samplerIndex = entry.z;
      if (samplerIndex < 0 || samplerIndex >= u_tileTextureCount) {
        vec2 fallbackOrigin = vec2(u_tileCoord) * u_tileScale;
        vec2 fallbackLocal = (absoluteCoord - fallbackOrigin) / max(u_tileScale, 0.0001);
        return getElevationFromTexture(u_image, clampTexCoord(fallbackLocal));
      }
      vec4 transform = u_tileTransform[lookupIndex];
      vec2 uv = localBase * transform.xy + transform.zw;
      return sampleElevationFromSamplers(samplerIndex, uv);
    }

    float getElevationGlobal(vec2 globalCoord) {
      vec2 absoluteCoord = globalCoord;
      ivec2 tileIndex = ivec2(floor(absoluteCoord));
      vec2 localBase = absoluteCoord - vec2(tileIndex);
      int lookupIndex = findTileLookupIndex(tileIndex);
      return sampleElevationFromLookup(lookupIndex, localBase, absoluteCoord);
    }

    float getElevationExtended(vec2 globalCoord) {
      return getElevationGlobal(globalCoord);
    }

    const float samplingDistance = 0.5;

    vec2 computeSobelGradient(vec2 globalCoord) {
      float metersPerPixel = 1.5 * pow(2.0, 16.0 - u_zoom);
      float metersPerTile  = metersPerPixel * u_dimension.x;
      float delta = samplingDistance / metersPerTile;
      float deltaGlobal = delta * u_tileScale;
      float tl = getElevationExtended(globalCoord + vec2(-deltaGlobal, -deltaGlobal));
      float tm = getElevationExtended(globalCoord + vec2(0.0,   -deltaGlobal));
      float tr = getElevationExtended(globalCoord + vec2(deltaGlobal,  -deltaGlobal));
      float ml = getElevationExtended(globalCoord + vec2(-deltaGlobal,  0.0));
      float mr = getElevationExtended(globalCoord + vec2(deltaGlobal,   0.0));
      float bl = getElevationExtended(globalCoord + vec2(-deltaGlobal,  deltaGlobal));
      float bm = getElevationExtended(globalCoord + vec2(0.0,    deltaGlobal));
      float br = getElevationExtended(globalCoord + vec2(deltaGlobal,   deltaGlobal));

      float gx = (-tl + tr - 2.0 * ml + 2.0 * mr - bl + br) / (8.0 * samplingDistance);
      float gy = (-tl - 2.0 * tm - tr + bl + 2.0 * bm + br) / (8.0 * samplingDistance);

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
      uniform vec4   u_projection_tile_mercator_coords;
      uniform vec2   u_tileCoord;
      uniform float  u_tileScale;
      uniform vec2   u_globalTileOrigin;

      in  highp vec2 a_pos;
      out highp vec2 v_texCoord;
      out highp float v_elevation;
      out highp float v_isWall;
      out highp vec2 v_globalCoord;

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
        v_globalCoord = vec2(u_tileCoord * u_tileScale + v_texCoord * u_tileScale - u_globalTileOrigin);
        float finalE = (v_isWall > 0.5)
                       ? elev - 50.0
                       : elev;
        gl_Position  = projectTileFor3D(a_pos, finalE);
      }`;
  },

  // Fragment shaders
  getFragmentShader: function(mode) {
    switch(mode) {
      case "normal":
        return `#version 300 es
        precision highp float;
        precision highp int;
        ${this.commonFunctions}
        in  highp vec2 v_texCoord;
        in  highp vec2 v_globalCoord;
        out vec4 fragColor;
        void main() {
          vec2 globalCoord = v_globalCoord + u_globalTileOrigin;
          vec2 grad   = computeSobelGradient(globalCoord);
          vec3 normal = normalize(vec3(-grad, 1.0));
          fragColor   = vec4(normal * 0.5 + 0.5, 1.0);
        }`;

      case "avalanche":
        return `#version 300 es
        precision highp float;
        precision highp int;
        ${this.commonFunctions}
        in  highp vec2 v_texCoord;
        in  highp vec2 v_globalCoord;
        out vec4 fragColor;
        float computeSlopeDegrees(vec2 globalPos) {
          vec2 g = computeSobelGradient(globalPos);
          return degrees(atan(length(g)));
        }
        void main() {
          vec2 globalCoord = v_globalCoord + u_globalTileOrigin;
          float slope = computeSlopeDegrees(globalCoord);
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
        in  highp vec2 v_globalCoord;
        out vec4 fragColor;
        float computeSlopeDegrees(vec2 globalPos) {
          vec2 g = computeSobelGradient(globalPos);
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
          vec2 globalCoord = v_globalCoord + u_globalTileOrigin;
          float slope   = computeSlopeDegrees(globalCoord);
          vec3 color    = getColorForSlope(slope);
          fragColor     = vec4(color, 0.7);
        }`;

      case "aspect":
        return `#version 300 es
        precision highp float;
        precision highp int;
        ${this.commonFunctions}
        in  highp vec2 v_texCoord;
        in  highp vec2 v_globalCoord;
        out vec4 fragColor;
        void main() {
          vec2 globalCoord = v_globalCoord + u_globalTileOrigin;
          vec2 grad = computeSobelGradient(globalCoord);
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
        // ←←← UNCHANGED ←←←
        return `#version 300 es
        precision highp float;
        ${this.commonFunctions}
        uniform float u_snow_altitude;
        uniform float u_snow_maxSlope;
        in vec2 v_texCoord;
        in highp vec2 v_globalCoord;
        in float v_elevation;
        out vec4 fragColor;
        float computeSlopeDegrees(vec2 globalPos) {
            return degrees(atan(length(computeSobelGradient(globalPos))));
        }
        float getAspect(vec2 grad) {
            float aspect = degrees(atan(grad.x, grad.y));
            return mod(aspect + 180.0, 360.0);
        }
        vec4 getSnowColorForElevation(float elevation, float aspect) {
            const vec3 lowSnowColor = vec3(0.5, 0.8, 0.8);
            const vec3 midSnowColor = vec3(0.2, 0.2, 0.8);
            const vec3 highSnowColor = vec3(0.4, 0.0, 0.8);
            float aspectFactor = smoothstep(180.0, 0.0, aspect) * 0.5 + 0.5;
            float snowDepthAdjustment = mix(250.0, 300.0, aspectFactor);
            float lowBand = 2000.0, midBand = 3400.0, highBand = 4100.0;
            vec3 color;
            float snowDepth;
            if (elevation < lowBand) {
                color = lowSnowColor;
                snowDepth = 1.0 * aspectFactor;
            } else if (elevation < midBand) {
                float t = (elevation - lowBand) / (midBand - lowBand);
                color = mix(lowSnowColor, midSnowColor, smoothstep(0.0,1.0,t));
                snowDepth = mix(1.0,2.5,t) * aspectFactor;
            } else if (elevation < highBand) {
                float t = (elevation - midBand) / (highBand - midBand);
                color = mix(midSnowColor, highSnowColor, smoothstep(0.0,1.0,t));
                snowDepth = mix(2.5,3.0,t) * aspectFactor;
            } else {
                color = highSnowColor;
                snowDepth = 3.0 * aspectFactor;
            }
            return vec4(color, snowDepth);
        }
        void main() {
            vec2 globalCoord = v_globalCoord + u_globalTileOrigin;
            vec2 grad = computeSobelGradient(globalCoord);
            float aspect = getAspect(grad);
            float slope  = computeSlopeDegrees(globalCoord);
            float altitudeMask = smoothstep(
                u_snow_altitude + 100.0,
                u_snow_altitude + 200.0,
                v_elevation
            );
            float slopeMask = step(slope, u_snow_maxSlope);
            vec4 snowInfo = getSnowColorForElevation(v_elevation, aspect);
            vec3 snowColor = snowInfo.rgb;
            float snowDepth = snowInfo.a;
            vec3 normal = normalize(vec3(-grad,1.0));
            float diffuse = pow(max(dot(normal,vec3(0,0,0.7)),0.0), 0.5);
            snowColor = mix(snowColor * 0.5, snowColor, diffuse);
            float finalMask = altitudeMask * slopeMask * snowDepth;
            fragColor = vec4(snowColor, finalMask * 0.95);
        }`;

      case "shadow":
        return `#version 300 es
        precision highp float;
        precision highp int;
        ${this.commonFunctions}
        uniform float u_shadowStepSize;
        uniform float u_shadowHorizontalScale;
        uniform float u_shadowLengthFactor;
        uniform vec2  u_sunDirection;
        uniform float u_sunAltitudeTan;
        uniform float u_sunAltitude;
        in  highp vec2  v_texCoord;
        in  highp vec2  v_globalCoord;
        in  highp float v_elevation;
        out vec4 fragColor;

        float computeShadow(vec2 globalCoord, float currentElevation) {
          if (u_sunAltitude <= 0.0) {
            return 0.0;
          }

          const int MAX_STEPS = 96;
          const int CASCADE_COUNT = 3;
          float metersPerPixel = 1.5 * pow(2.0, 16.0 - u_zoom);
          float metersPerTile  = metersPerPixel * u_dimension.x;
          float baseStepMeters = max(u_shadowStepSize, metersPerPixel);
          vec2  lightDir2D     = normalize(u_sunDirection);
          float tanAltitude    = max(u_sunAltitudeTan, 0.01);
          float heightBias     = metersPerPixel * 0.75;

          float cascadeStepMultipliers[CASCADE_COUNT];
          cascadeStepMultipliers[0] = 1.0;
          cascadeStepMultipliers[1] = 4.0;
          cascadeStepMultipliers[2] = 12.0;
          float cascadeLengthMultipliers[CASCADE_COUNT];
          cascadeLengthMultipliers[0] = 1.0;
          cascadeLengthMultipliers[1] = 1.5;
          cascadeLengthMultipliers[2] = 2.0;

          float visibility        = 1.0;
          float accumulatedMeters = 0.0;
          vec2 cascadeOrigin      = globalCoord;

          for (int c = 0; c < CASCADE_COUNT; c++) {
            float stepMultiplier   = cascadeStepMultipliers[c];
            float lengthMultiplier = cascadeLengthMultipliers[c];
            float stepMeters       = baseStepMeters * stepMultiplier;
            float stepSize         = stepMeters / metersPerTile;
            vec2  globalStep       = lightDir2D * u_shadowHorizontalScale * stepSize * u_tileScale;
            int   cascadeSteps     = int(clamp(u_shadowLengthFactor * 24.0 * lengthMultiplier, 4.0, float(MAX_STEPS)));

            for (int i = 1; i <= MAX_STEPS; i++) {
              if (i > cascadeSteps) {
                break;
              }
              float travelMeters = accumulatedMeters + float(i) * stepMeters;
              vec2 sampleCoord   = cascadeOrigin + globalStep * float(i);
              float sampleElev   = getElevationGlobal(sampleCoord);
              float allowedElev  = currentElevation + travelMeters * tanAltitude * u_shadowLengthFactor;
              float diff         = allowedElev - sampleElev + heightBias;
              visibility = min(visibility, smoothstep(0.0, heightBias * 2.0, diff));
              if (visibility <= 0.0001) {
                return 0.0;
              }
            }

            cascadeOrigin      += globalStep * float(cascadeSteps);
            accumulatedMeters  += stepMeters * float(cascadeSteps);
          }

          return visibility;
        }

        void main(){
          vec2 globalCoord = v_globalCoord + u_globalTileOrigin;
          vec2 grad   = computeSobelGradient(globalCoord);
          vec3 normal = normalize(vec3(-grad, 1.0));
          float ambient = 0.25;
          if (u_sunAltitude <= 0.0) {
            fragColor = vec4(vec3(ambient), 1.0);
            return;
          }
          vec3 sunVector = normalize(vec3(u_sunDirection.x, -u_sunDirection.y, max(u_sunAltitudeTan, 0.01)));
          float diffuse = max(dot(normal, sunVector), 0.0);
          float shadow  = computeShadow(globalCoord, v_elevation);
          float shading = ambient + (1.0 - ambient) * diffuse * shadow;
          fragColor    = vec4(vec3(shading), 1.0);
        }`;

      default:
        return '';
    }
  }
};

