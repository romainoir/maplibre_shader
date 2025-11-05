/* terrain-shaders.js */
const TerrainShaders = {
  // Common GLSL functions shared among the fragment shaders.
  commonFunctions: `
    precision highp float;
    precision highp int;
    uniform sampler2D u_image;
    uniform sampler2D u_image_left;
    uniform sampler2D u_image_right;
    uniform sampler2D u_image_top;
    uniform sampler2D u_image_bottom;
    uniform sampler2D u_image_topLeft;
    uniform sampler2D u_image_topRight;
    uniform sampler2D u_image_bottomLeft;
    uniform sampler2D u_image_bottomRight;
    uniform vec4 u_terrain_unpack;
    uniform vec2 u_dimension;
    uniform float u_zoom;
    uniform vec2 u_latrange;

    float getElevationFromTexture(sampler2D tex, vec2 pos) {
      vec3 data = texture(tex, pos).rgb * 255.0;
      // Terrarium encoding: elevation = (R * 256 + G + B / 256) - 32768
      return dot(data, vec3(256.0, 1.0, 1.0 / 256.0)) - 32768.0;
    }

    vec2 clampTexCoord(vec2 pos) {
      float border = 1.0 / u_dimension.x;
      return clamp(pos, vec2(border), vec2(1.0 - border));
    }

    float getElevationExtended(vec2 pos) {
      vec2 tilePos = pos;
      vec2 offset = vec2(0.0);
      for (int i = 0; i < 2; i++) {
        if (tilePos.x < 0.0 && offset.x > -1.5) {
          tilePos.x += 1.0;
          offset.x -= 1.0;
        }
        if (tilePos.x > 1.0 && offset.x < 1.5) {
          tilePos.x -= 1.0;
          offset.x += 1.0;
        }
        if (tilePos.y < 0.0 && offset.y > -1.5) {
          tilePos.y += 1.0;
          offset.y -= 1.0;
        }
        if (tilePos.y > 1.0 && offset.y < 1.5) {
          tilePos.y -= 1.0;
          offset.y += 1.0;
        }
      }
      offset = clamp(offset, vec2(-1.0), vec2(1.0));
      tilePos = clampTexCoord(tilePos);

      if (offset.x == -1.0 && offset.y == -1.0) {
        return getElevationFromTexture(u_image_topLeft, tilePos);
      }
      if (offset.x == 1.0 && offset.y == -1.0) {
        return getElevationFromTexture(u_image_topRight, tilePos);
      }
      if (offset.x == -1.0 && offset.y == 1.0) {
        return getElevationFromTexture(u_image_bottomLeft, tilePos);
      }
      if (offset.x == 1.0 && offset.y == 1.0) {
        return getElevationFromTexture(u_image_bottomRight, tilePos);
      }
      if (offset.x == -1.0) {
        return getElevationFromTexture(u_image_left, tilePos);
      }
      if (offset.x == 1.0) {
        return getElevationFromTexture(u_image_right, tilePos);
      }
      if (offset.y == -1.0) {
        return getElevationFromTexture(u_image_top, tilePos);
      }
      if (offset.y == 1.0) {
        return getElevationFromTexture(u_image_bottom, tilePos);
      }
      return getElevationFromTexture(u_image, tilePos);
    }
    
    const float samplingDistance = 0.5;
    
    vec2 computeSobelGradient(vec2 pos) {
      vec2 safePos = clampTexCoord(pos);
      float metersPerPixel = 1.5 * pow(2.0, 16.0 - u_zoom);
      float metersPerTile  = metersPerPixel * u_dimension.x;
      float delta = samplingDistance / metersPerTile;
      
      float tl = getElevationExtended(safePos + vec2(-delta, -delta));
      float tm = getElevationExtended(safePos + vec2(0.0,   -delta));
      float tr = getElevationExtended(safePos + vec2(delta,  -delta));
      float ml = getElevationExtended(safePos + vec2(-delta,  0.0));
      float mr = getElevationExtended(safePos + vec2(delta,   0.0));
      float bl = getElevationExtended(safePos + vec2(-delta,  delta));
      float bm = getElevationExtended(safePos + vec2(0.0,    delta));
      float br = getElevationExtended(safePos + vec2(delta,   delta));
      
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
        // ←←← UNCHANGED ←←←
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
            vec2 grad = computeSobelGradient(v_texCoord);
            float aspect = getAspect(grad);
            float slope  = computeSlopeDegrees(clampTexCoord(v_texCoord));
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
        uniform vec2  u_sunDirection;
        uniform float u_sunAltitude;
        in  highp vec2  v_texCoord;
        in  highp float v_elevation;
        out vec4 fragColor;

        const int MAX_SHADOW_STEPS = 512;

        float traceShadowRay(vec2 startPos, float currentElevation, vec2 texelStep, float metersPerPixel, float sunSlope) {
          float maxSlope = -1e6;
          vec2 samplePos = startPos;
          for (int i = 1; i <= MAX_SHADOW_STEPS; ++i) {
            samplePos += texelStep;
            if (samplePos.x < -1.0 || samplePos.x > 2.0 || samplePos.y < -1.0 || samplePos.y > 2.0) {
              break;
            }
            float horizontalMeters = float(i) * metersPerPixel;
            if (horizontalMeters <= 0.0) {
              continue;
            }
            float sampleElevation = getElevationExtended(samplePos);
            float slope = (sampleElevation - currentElevation) / horizontalMeters;
            maxSlope = max(maxSlope, slope);
          }
          float visibility = sunSlope - maxSlope;
          return smoothstep(0.02, 0.18, visibility);
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
          float metersPerPixel = 1.5 * pow(2.0, 16.0 - u_zoom);
          float clampedAltitude = clamp(u_sunAltitude, -1.55334306, 1.55334306);
          float sunSlope = tan(clampedAltitude);

          vec2 perpendicular = vec2(-horizontalDir.y, horizontalDir.x);
          const int SAMPLE_COUNT = 5;
          float offsets[SAMPLE_COUNT] = float[]( -1.5, -0.75, 0.0, 0.75, 1.5 );
          float weights[SAMPLE_COUNT] = float[]( 0.1, 0.2, 0.4, 0.2, 0.1 );

          float visibility = 0.0;
          for (int i = 0; i < SAMPLE_COUNT; ++i) {
            vec2 offsetPos = pos + perpendicular * (offsets[i] / tileResolution);
            visibility += weights[i] * traceShadowRay(offsetPos, currentElevation, texelStep, metersPerPixel, sunSlope);
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
          float alpha = 0.12 + 0.6 * combinedShadow;
          vec3 shadowColor = vec3(0.0);
          fragColor = vec4(shadowColor, alpha);
        }`;

      default:
        return '';
    }
  }
};

