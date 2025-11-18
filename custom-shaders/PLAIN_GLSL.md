# Copy-paste GLSL shader library

Each snippet below is a full fragment shader that already inlines the shared terrain helper
functions (elevation sampling, Sobel gradients, SRGB helpers, etc.). Copy the block you want
into your MapLibre custom layer panel and wire up the uniforms listed at the top of the shader.
For background on what each effect does, see [custom-shaders/README.md](./README.md).

### Additional shader concepts

The snippets below implement the six additional ideas in full GLSL so you can paste them straight into a custom layer panel.

## Curvature & concavity diagnostic

Colors convex ridges with warm hues and concave basins with cool hues by comparing a ring of elevation samples against the current pixel.

```glsl
#version 300 es
        precision highp float;
        precision highp int;
        
    precision highp float;
    precision highp int;
    uniform sampler2D u_image;
    uniform sampler2D u_hillshade_gradient;
        uniform sampler2D u_image_0_m2;
    uniform sampler2D u_image_topLeft;
    uniform sampler2D u_image_top;
    uniform sampler2D u_image_topRight;
    uniform sampler2D u_image_m2_0;
    uniform sampler2D u_image_left;
    uniform sampler2D u_image_right;
    uniform sampler2D u_image_p2_0;
    uniform sampler2D u_image_bottomLeft;
    uniform sampler2D u_image_bottom;
    uniform sampler2D u_image_bottomRight;
    uniform sampler2D u_image_0_p2;

    uniform vec4 u_terrain_unpack;
    uniform vec2 u_dimension;
    uniform float u_zoom;
    uniform float u_metersPerPixel;
    uniform float u_metersPerPixel_0_m2;
    uniform float u_metersPerPixel_topLeft;
    uniform float u_metersPerPixel_top;
    uniform float u_metersPerPixel_topRight;
    uniform float u_metersPerPixel_m2_0;
    uniform float u_metersPerPixel_left;
    uniform float u_metersPerPixel_right;
    uniform float u_metersPerPixel_p2_0;
    uniform float u_metersPerPixel_bottomLeft;
    uniform float u_metersPerPixel_bottom;
    uniform float u_metersPerPixel_bottomRight;
    uniform float u_metersPerPixel_0_p2;
    uniform vec2 u_latrange;
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
      const int MAX_OFFSET = 2;
      for (int i = 0; i < 8; ++i) {
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
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTexture(u_image_0_m2, tilePos);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTexture(u_image_topLeft, tilePos);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTexture(u_image_top, tilePos);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTexture(u_image_topRight, tilePos);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTexture(u_image_m2_0, tilePos);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTexture(u_image_left, tilePos);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTexture(u_image_right, tilePos);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTexture(u_image_p2_0, tilePos);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTexture(u_image_bottomLeft, tilePos);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTexture(u_image_bottom, tilePos);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTexture(u_image_bottomRight, tilePos);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTexture(u_image_0_p2, tilePos);
      }
      return getElevationFromTexture(u_image, tilePos);
    }

    float fetchElevationForOffsetLod(ivec2 offset, vec2 tilePos, float lod) {
      if (offset == ivec2(0, 0)) {
        return getElevationFromTextureLod(u_image, tilePos, lod);
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTextureLod(u_image_0_m2, tilePos, lod);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTextureLod(u_image_topLeft, tilePos, lod);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTextureLod(u_image_top, tilePos, lod);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTextureLod(u_image_topRight, tilePos, lod);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTextureLod(u_image_m2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTextureLod(u_image_left, tilePos, lod);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTextureLod(u_image_right, tilePos, lod);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTextureLod(u_image_p2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTextureLod(u_image_bottomLeft, tilePos, lod);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTextureLod(u_image_bottom, tilePos, lod);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTextureLod(u_image_bottomRight, tilePos, lod);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTextureLod(u_image_0_p2, tilePos, lod);
      }
      return getElevationFromTextureLod(u_image, tilePos, lod);
    }

    float getMetersPerPixelForOffset(ivec2 offset) {
      if (offset == ivec2(0, 0)) {
        return max(u_metersPerPixel, 0.0);
      }
      if (offset == ivec2(0, -2)) {
        return max(u_metersPerPixel_0_m2, 0.0);
      }
      if (offset == ivec2(-1, -1)) {
        return max(u_metersPerPixel_topLeft, 0.0);
      }
      if (offset == ivec2(0, -1)) {
        return max(u_metersPerPixel_top, 0.0);
      }
      if (offset == ivec2(1, -1)) {
        return max(u_metersPerPixel_topRight, 0.0);
      }
      if (offset == ivec2(-2, 0)) {
        return max(u_metersPerPixel_m2_0, 0.0);
      }
      if (offset == ivec2(-1, 0)) {
        return max(u_metersPerPixel_left, 0.0);
      }
      if (offset == ivec2(1, 0)) {
        return max(u_metersPerPixel_right, 0.0);
      }
      if (offset == ivec2(2, 0)) {
        return max(u_metersPerPixel_p2_0, 0.0);
      }
      if (offset == ivec2(-1, 1)) {
        return max(u_metersPerPixel_bottomLeft, 0.0);
      }
      if (offset == ivec2(0, 1)) {
        return max(u_metersPerPixel_bottom, 0.0);
      }
      if (offset == ivec2(1, 1)) {
        return max(u_metersPerPixel_bottomRight, 0.0);
      }
      if (offset == ivec2(0, 2)) {
        return max(u_metersPerPixel_0_p2, 0.0);
      }
      return max(u_metersPerPixel, 0.0);
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
        in  highp vec2 v_texCoord;
        out vec4 fragColor;

        float computeSlopeDegrees(vec2 pos) {
          vec2 g = computeSobelGradient(pos);
          return degrees(atan(length(g)));
        }

        float computeCurvature(vec2 pos) {
          vec2 safePos = clampTexCoord(pos);
          float center = getElevationExtended(safePos);
          float metersPerPixel = 1.5 * pow(2.0, 16.0 - u_zoom);
          float metersPerTile = metersPerPixel * 256.0;
          float radiusMeters = 20.0;
          float delta = radiusMeters / metersPerTile;
          const vec2 ringOffsets[12] = vec2[](
            vec2(1.0, 0.0), vec2(-1.0, 0.0),
            vec2(0.0, 1.0), vec2(0.0, -1.0),
            vec2(0.707, 0.707), vec2(0.707, -0.707),
            vec2(-0.707, 0.707), vec2(-0.707, -0.707),
            vec2(1.5, 0.0), vec2(-1.5, 0.0),
            vec2(0.0, 1.5), vec2(0.0, -1.5)
          );
          float sum = 0.0;
          for (int i = 0; i < 12; ++i) {
            sum += getElevationExtended(safePos + ringOffsets[i] * delta);
          }
          float mean = sum / 12.0;
          return mean - center;
        }

        void main() {
          float curvature = computeCurvature(v_texCoord);
          float slope = computeSlopeDegrees(v_texCoord);
          float slopeMask = smoothstep(3.0, 18.0, slope);
          float intensity = clamp(abs(curvature) / 5.0, 0.0, 1.0) * slopeMask;
          float concavity = smoothstep(-1.5, 1.5, curvature);
          vec3 concaveColor = vec3(0.18, 0.44, 0.94);
          vec3 convexColor = vec3(1.0, 0.58, 0.08);
          vec3 neutralColor = vec3(0.08, 0.08, 0.08);
          vec3 ramp = mix(concaveColor, convexColor, concavity);
          vec3 color = mix(neutralColor, ramp, intensity);
          fragColor = vec4(color, 0.85 * intensity + 0.15);
        }
```

## Latitude-adjusted snowline bands

Estimates a freezing altitude that changes with latitude and aspect, then blends alpine snow above the computed snowline and warmer tones below it.

```glsl
#version 300 es
        precision highp float;
        precision highp int;
        
    precision highp float;
    precision highp int;
    uniform sampler2D u_image;
    uniform sampler2D u_hillshade_gradient;
        uniform sampler2D u_image_0_m2;
    uniform sampler2D u_image_topLeft;
    uniform sampler2D u_image_top;
    uniform sampler2D u_image_topRight;
    uniform sampler2D u_image_m2_0;
    uniform sampler2D u_image_left;
    uniform sampler2D u_image_right;
    uniform sampler2D u_image_p2_0;
    uniform sampler2D u_image_bottomLeft;
    uniform sampler2D u_image_bottom;
    uniform sampler2D u_image_bottomRight;
    uniform sampler2D u_image_0_p2;

    uniform vec4 u_terrain_unpack;
    uniform vec2 u_dimension;
    uniform float u_zoom;
    uniform float u_metersPerPixel;
    uniform float u_metersPerPixel_0_m2;
    uniform float u_metersPerPixel_topLeft;
    uniform float u_metersPerPixel_top;
    uniform float u_metersPerPixel_topRight;
    uniform float u_metersPerPixel_m2_0;
    uniform float u_metersPerPixel_left;
    uniform float u_metersPerPixel_right;
    uniform float u_metersPerPixel_p2_0;
    uniform float u_metersPerPixel_bottomLeft;
    uniform float u_metersPerPixel_bottom;
    uniform float u_metersPerPixel_bottomRight;
    uniform float u_metersPerPixel_0_p2;
    uniform vec2 u_latrange;
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
      const int MAX_OFFSET = 2;
      for (int i = 0; i < 8; ++i) {
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
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTexture(u_image_0_m2, tilePos);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTexture(u_image_topLeft, tilePos);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTexture(u_image_top, tilePos);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTexture(u_image_topRight, tilePos);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTexture(u_image_m2_0, tilePos);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTexture(u_image_left, tilePos);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTexture(u_image_right, tilePos);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTexture(u_image_p2_0, tilePos);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTexture(u_image_bottomLeft, tilePos);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTexture(u_image_bottom, tilePos);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTexture(u_image_bottomRight, tilePos);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTexture(u_image_0_p2, tilePos);
      }
      return getElevationFromTexture(u_image, tilePos);
    }

    float fetchElevationForOffsetLod(ivec2 offset, vec2 tilePos, float lod) {
      if (offset == ivec2(0, 0)) {
        return getElevationFromTextureLod(u_image, tilePos, lod);
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTextureLod(u_image_0_m2, tilePos, lod);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTextureLod(u_image_topLeft, tilePos, lod);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTextureLod(u_image_top, tilePos, lod);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTextureLod(u_image_topRight, tilePos, lod);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTextureLod(u_image_m2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTextureLod(u_image_left, tilePos, lod);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTextureLod(u_image_right, tilePos, lod);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTextureLod(u_image_p2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTextureLod(u_image_bottomLeft, tilePos, lod);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTextureLod(u_image_bottom, tilePos, lod);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTextureLod(u_image_bottomRight, tilePos, lod);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTextureLod(u_image_0_p2, tilePos, lod);
      }
      return getElevationFromTextureLod(u_image, tilePos, lod);
    }

    float getMetersPerPixelForOffset(ivec2 offset) {
      if (offset == ivec2(0, 0)) {
        return max(u_metersPerPixel, 0.0);
      }
      if (offset == ivec2(0, -2)) {
        return max(u_metersPerPixel_0_m2, 0.0);
      }
      if (offset == ivec2(-1, -1)) {
        return max(u_metersPerPixel_topLeft, 0.0);
      }
      if (offset == ivec2(0, -1)) {
        return max(u_metersPerPixel_top, 0.0);
      }
      if (offset == ivec2(1, -1)) {
        return max(u_metersPerPixel_topRight, 0.0);
      }
      if (offset == ivec2(-2, 0)) {
        return max(u_metersPerPixel_m2_0, 0.0);
      }
      if (offset == ivec2(-1, 0)) {
        return max(u_metersPerPixel_left, 0.0);
      }
      if (offset == ivec2(1, 0)) {
        return max(u_metersPerPixel_right, 0.0);
      }
      if (offset == ivec2(2, 0)) {
        return max(u_metersPerPixel_p2_0, 0.0);
      }
      if (offset == ivec2(-1, 1)) {
        return max(u_metersPerPixel_bottomLeft, 0.0);
      }
      if (offset == ivec2(0, 1)) {
        return max(u_metersPerPixel_bottom, 0.0);
      }
      if (offset == ivec2(1, 1)) {
        return max(u_metersPerPixel_bottomRight, 0.0);
      }
      if (offset == ivec2(0, 2)) {
        return max(u_metersPerPixel_0_p2, 0.0);
      }
      return max(u_metersPerPixel, 0.0);
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
        in  highp vec2 v_texCoord;
        in  highp float v_elevation;
        out vec4 fragColor;

        float computeSlopeDegrees(vec2 pos) {
          vec2 g = computeSobelGradient(pos);
          return degrees(atan(length(g)));
        }

        float computeAspectShade(vec2 grad) {
          vec2 dir = normalize(vec2(grad.x, grad.y) + vec2(0.0001));
          return -dir.y;
        }

        float computeSnowline(float latitude, float aspectShade) {
          float normalizedLat = clamp(abs(latitude) / 60.0, 0.0, 1.0);
          float equatorSnowline = 4800.0;
          float poleSnowline = 200.0;
          float base = mix(equatorSnowline, poleSnowline, normalizedLat);
          float shadeAdjustment = aspectShade * 200.0;
          return base + shadeAdjustment;
        }

        void main() {
          float latitude = computeLatitudeForTexCoord(v_texCoord.y);
          vec2 grad = getHillshadeGradient(v_texCoord);
          float aspectShade = computeAspectShade(grad);
          float snowline = computeSnowline(latitude, aspectShade);
          float lapseRate = 6.0;
          float temperatureDelta = lapseRate * (snowline - v_elevation) / 1000.0;
          float snowMask = smoothstep(-1.0, 1.0, -temperatureDelta);
          float slope = computeSlopeDegrees(v_texCoord);
          float slopeShade = smoothstep(15.0, 45.0, slope);
          vec3 meadow = vec3(0.12, 0.23, 0.07);
          vec3 tundra = vec3(0.39, 0.32, 0.19);
          vec3 snow = vec3(0.93, 0.97, 1.0);
          vec3 ground = mix(meadow, tundra, clamp((v_elevation - 1000.0) / 1500.0, 0.0, 1.0));
          vec3 baseColor = mix(ground, snow, snowMask);
          baseColor = mix(baseColor, snow, slopeShade * 0.25);
          fragColor = vec4(baseColor, 0.95);
        }
```

## Depth-based atmospheric perspective

Applies volumetric haze in screen space by linearizing `v_depth` and blending toward configurable fog and horizon colors.

```glsl
#version 300 es
precision highp float;

uniform sampler2D u_color;
uniform vec4 u_fog_color_near;
uniform vec4 u_fog_color_far;
uniform float u_near;
uniform float u_far;
uniform float u_fog_density;
uniform float u_height_falloff;

in vec2 v_uv;
in float v_depth;

out vec4 fragColor;

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

float linearizeDepth(float depth) {
  float z = depth * 2.0 - 1.0;
  return (2.0 * u_near * u_far) / (u_far + u_near - z * (u_far - u_near));
}

void main() {
  vec4 base = texture(u_color, v_uv);
  float depthLinear = linearizeDepth(v_depth);
  float normalized = clamp((depthLinear - u_near) / max(u_far - u_near, 0.0001), 0.0, 1.0);
  float fogFactor = 1.0 - exp(-normalized * u_fog_density);
  float horizonFactor = pow(normalized, 1.5);
  float heightMask = exp(-depthLinear * u_height_falloff);
  vec4 fogColor = mix(u_fog_color_near, u_fog_color_far, horizonFactor);
  fogColor.rgb = mix(fogColor.rgb, u_fog_color_far.rgb, 1.0 - heightMask);
  vec3 baseLinear = srgbToLinear(base).rgb;
  vec3 fogLinear = srgbToLinear(fogColor).rgb;
  vec3 result = mix(baseLinear, fogLinear, fogFactor);
  float alpha = mix(base.a, fogColor.a, fogFactor);
  fragColor = vec4(linearToSrgb(result), alpha);
}
```

## Cliff and wall highlighter

Emphasizes steep cliffs and mesh skirts by combining the per-vertex wall flag with gradient magnitude and slope thresholds.

```glsl
#version 300 es
        precision highp float;
        precision highp int;
        
    precision highp float;
    precision highp int;
    uniform sampler2D u_image;
    uniform sampler2D u_hillshade_gradient;
        uniform sampler2D u_image_0_m2;
    uniform sampler2D u_image_topLeft;
    uniform sampler2D u_image_top;
    uniform sampler2D u_image_topRight;
    uniform sampler2D u_image_m2_0;
    uniform sampler2D u_image_left;
    uniform sampler2D u_image_right;
    uniform sampler2D u_image_p2_0;
    uniform sampler2D u_image_bottomLeft;
    uniform sampler2D u_image_bottom;
    uniform sampler2D u_image_bottomRight;
    uniform sampler2D u_image_0_p2;

    uniform vec4 u_terrain_unpack;
    uniform vec2 u_dimension;
    uniform float u_zoom;
    uniform float u_metersPerPixel;
    uniform float u_metersPerPixel_0_m2;
    uniform float u_metersPerPixel_topLeft;
    uniform float u_metersPerPixel_top;
    uniform float u_metersPerPixel_topRight;
    uniform float u_metersPerPixel_m2_0;
    uniform float u_metersPerPixel_left;
    uniform float u_metersPerPixel_right;
    uniform float u_metersPerPixel_p2_0;
    uniform float u_metersPerPixel_bottomLeft;
    uniform float u_metersPerPixel_bottom;
    uniform float u_metersPerPixel_bottomRight;
    uniform float u_metersPerPixel_0_p2;
    uniform vec2 u_latrange;
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
      const int MAX_OFFSET = 2;
      for (int i = 0; i < 8; ++i) {
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
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTexture(u_image_0_m2, tilePos);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTexture(u_image_topLeft, tilePos);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTexture(u_image_top, tilePos);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTexture(u_image_topRight, tilePos);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTexture(u_image_m2_0, tilePos);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTexture(u_image_left, tilePos);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTexture(u_image_right, tilePos);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTexture(u_image_p2_0, tilePos);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTexture(u_image_bottomLeft, tilePos);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTexture(u_image_bottom, tilePos);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTexture(u_image_bottomRight, tilePos);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTexture(u_image_0_p2, tilePos);
      }
      return getElevationFromTexture(u_image, tilePos);
    }

    float fetchElevationForOffsetLod(ivec2 offset, vec2 tilePos, float lod) {
      if (offset == ivec2(0, 0)) {
        return getElevationFromTextureLod(u_image, tilePos, lod);
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTextureLod(u_image_0_m2, tilePos, lod);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTextureLod(u_image_topLeft, tilePos, lod);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTextureLod(u_image_top, tilePos, lod);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTextureLod(u_image_topRight, tilePos, lod);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTextureLod(u_image_m2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTextureLod(u_image_left, tilePos, lod);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTextureLod(u_image_right, tilePos, lod);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTextureLod(u_image_p2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTextureLod(u_image_bottomLeft, tilePos, lod);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTextureLod(u_image_bottom, tilePos, lod);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTextureLod(u_image_bottomRight, tilePos, lod);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTextureLod(u_image_0_p2, tilePos, lod);
      }
      return getElevationFromTextureLod(u_image, tilePos, lod);
    }

    float getMetersPerPixelForOffset(ivec2 offset) {
      if (offset == ivec2(0, 0)) {
        return max(u_metersPerPixel, 0.0);
      }
      if (offset == ivec2(0, -2)) {
        return max(u_metersPerPixel_0_m2, 0.0);
      }
      if (offset == ivec2(-1, -1)) {
        return max(u_metersPerPixel_topLeft, 0.0);
      }
      if (offset == ivec2(0, -1)) {
        return max(u_metersPerPixel_top, 0.0);
      }
      if (offset == ivec2(1, -1)) {
        return max(u_metersPerPixel_topRight, 0.0);
      }
      if (offset == ivec2(-2, 0)) {
        return max(u_metersPerPixel_m2_0, 0.0);
      }
      if (offset == ivec2(-1, 0)) {
        return max(u_metersPerPixel_left, 0.0);
      }
      if (offset == ivec2(1, 0)) {
        return max(u_metersPerPixel_right, 0.0);
      }
      if (offset == ivec2(2, 0)) {
        return max(u_metersPerPixel_p2_0, 0.0);
      }
      if (offset == ivec2(-1, 1)) {
        return max(u_metersPerPixel_bottomLeft, 0.0);
      }
      if (offset == ivec2(0, 1)) {
        return max(u_metersPerPixel_bottom, 0.0);
      }
      if (offset == ivec2(1, 1)) {
        return max(u_metersPerPixel_bottomRight, 0.0);
      }
      if (offset == ivec2(0, 2)) {
        return max(u_metersPerPixel_0_p2, 0.0);
      }
      return max(u_metersPerPixel, 0.0);
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
        in  highp vec2 v_texCoord;
        in  highp float v_isWall;
        out vec4 fragColor;

        float computeSlopeDegrees(vec2 pos) {
          vec2 g = computeSobelGradient(pos);
          return degrees(atan(length(g)));
        }

        void main() {
          vec2 grad = computeSobelGradient(v_texCoord);
          float slope = computeSlopeDegrees(v_texCoord);
          float wallMask = smoothstep(0.1, 0.9, v_isWall);
          float cliffMask = smoothstep(45.0, 70.0, slope);
          float gradientStrength = clamp(length(grad) / 30.0, 0.0, 1.0);
          vec3 base = vec3(0.08, 0.09, 0.12) + gradientStrength * 0.12;
          vec3 cliffColor = vec3(1.0, 0.35, 0.08);
          vec3 wallColor = vec3(0.52, 0.82, 1.0);
          vec3 color = mix(base, cliffColor, cliffMask);
          color = mix(color, wallColor, wallMask);
          float alpha = max(cliffMask, wallMask);
          fragColor = vec4(color, mix(0.4, 0.95, alpha));
        }
```

## Planform flow accumulation estimate

Walks downhill along the DEM gradient for a few steps to approximate wetness and highlight potential drainage lines.

```glsl
#version 300 es
        precision highp float;
        precision highp int;
        
    precision highp float;
    precision highp int;
    uniform sampler2D u_image;
    uniform sampler2D u_hillshade_gradient;
        uniform sampler2D u_image_0_m2;
    uniform sampler2D u_image_topLeft;
    uniform sampler2D u_image_top;
    uniform sampler2D u_image_topRight;
    uniform sampler2D u_image_m2_0;
    uniform sampler2D u_image_left;
    uniform sampler2D u_image_right;
    uniform sampler2D u_image_p2_0;
    uniform sampler2D u_image_bottomLeft;
    uniform sampler2D u_image_bottom;
    uniform sampler2D u_image_bottomRight;
    uniform sampler2D u_image_0_p2;

    uniform vec4 u_terrain_unpack;
    uniform vec2 u_dimension;
    uniform float u_zoom;
    uniform float u_metersPerPixel;
    uniform float u_metersPerPixel_0_m2;
    uniform float u_metersPerPixel_topLeft;
    uniform float u_metersPerPixel_top;
    uniform float u_metersPerPixel_topRight;
    uniform float u_metersPerPixel_m2_0;
    uniform float u_metersPerPixel_left;
    uniform float u_metersPerPixel_right;
    uniform float u_metersPerPixel_p2_0;
    uniform float u_metersPerPixel_bottomLeft;
    uniform float u_metersPerPixel_bottom;
    uniform float u_metersPerPixel_bottomRight;
    uniform float u_metersPerPixel_0_p2;
    uniform vec2 u_latrange;
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
      const int MAX_OFFSET = 2;
      for (int i = 0; i < 8; ++i) {
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
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTexture(u_image_0_m2, tilePos);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTexture(u_image_topLeft, tilePos);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTexture(u_image_top, tilePos);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTexture(u_image_topRight, tilePos);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTexture(u_image_m2_0, tilePos);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTexture(u_image_left, tilePos);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTexture(u_image_right, tilePos);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTexture(u_image_p2_0, tilePos);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTexture(u_image_bottomLeft, tilePos);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTexture(u_image_bottom, tilePos);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTexture(u_image_bottomRight, tilePos);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTexture(u_image_0_p2, tilePos);
      }
      return getElevationFromTexture(u_image, tilePos);
    }

    float fetchElevationForOffsetLod(ivec2 offset, vec2 tilePos, float lod) {
      if (offset == ivec2(0, 0)) {
        return getElevationFromTextureLod(u_image, tilePos, lod);
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTextureLod(u_image_0_m2, tilePos, lod);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTextureLod(u_image_topLeft, tilePos, lod);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTextureLod(u_image_top, tilePos, lod);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTextureLod(u_image_topRight, tilePos, lod);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTextureLod(u_image_m2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTextureLod(u_image_left, tilePos, lod);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTextureLod(u_image_right, tilePos, lod);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTextureLod(u_image_p2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTextureLod(u_image_bottomLeft, tilePos, lod);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTextureLod(u_image_bottom, tilePos, lod);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTextureLod(u_image_bottomRight, tilePos, lod);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTextureLod(u_image_0_p2, tilePos, lod);
      }
      return getElevationFromTextureLod(u_image, tilePos, lod);
    }

    float getMetersPerPixelForOffset(ivec2 offset) {
      if (offset == ivec2(0, 0)) {
        return max(u_metersPerPixel, 0.0);
      }
      if (offset == ivec2(0, -2)) {
        return max(u_metersPerPixel_0_m2, 0.0);
      }
      if (offset == ivec2(-1, -1)) {
        return max(u_metersPerPixel_topLeft, 0.0);
      }
      if (offset == ivec2(0, -1)) {
        return max(u_metersPerPixel_top, 0.0);
      }
      if (offset == ivec2(1, -1)) {
        return max(u_metersPerPixel_topRight, 0.0);
      }
      if (offset == ivec2(-2, 0)) {
        return max(u_metersPerPixel_m2_0, 0.0);
      }
      if (offset == ivec2(-1, 0)) {
        return max(u_metersPerPixel_left, 0.0);
      }
      if (offset == ivec2(1, 0)) {
        return max(u_metersPerPixel_right, 0.0);
      }
      if (offset == ivec2(2, 0)) {
        return max(u_metersPerPixel_p2_0, 0.0);
      }
      if (offset == ivec2(-1, 1)) {
        return max(u_metersPerPixel_bottomLeft, 0.0);
      }
      if (offset == ivec2(0, 1)) {
        return max(u_metersPerPixel_bottom, 0.0);
      }
      if (offset == ivec2(1, 1)) {
        return max(u_metersPerPixel_bottomRight, 0.0);
      }
      if (offset == ivec2(0, 2)) {
        return max(u_metersPerPixel_0_p2, 0.0);
      }
      return max(u_metersPerPixel, 0.0);
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
        in  highp vec2 v_texCoord;
        out vec4 fragColor;

        float tracePlanformFlow(vec2 pos) {
          vec2 current = clampTexCoord(pos);
          const int MAX_STEPS = 24;
          float weight = 1.0;
          float accum = 0.0;
          float metersPerPixel = 1.5 * pow(2.0, 16.0 - u_zoom);
          float metersPerTile = metersPerPixel * 256.0;
          float stepMeters = 12.0;
          float stepDelta = stepMeters / metersPerTile;
          for (int i = 0; i < MAX_STEPS; ++i) {
            vec2 grad = getHillshadeGradient(current);
            float slope = length(grad);
            accum += slope * weight;
            vec2 dir = normalize(grad + vec2(0.0001));
            current -= dir * stepDelta;
            current = clampTexCoord(current);
            weight *= 0.88;
          }
          return accum / float(MAX_STEPS);
        }

        void main() {
          float wetness = clamp(tracePlanformFlow(v_texCoord) / 12.0, 0.0, 1.0);
          float wetPow = pow(wetness, 1.2);
          vec3 dryColor = vec3(0.28, 0.22, 0.18);
          vec3 wetColor = vec3(0.0, 0.44, 0.82);
          vec3 saturated = vec3(0.6, 0.9, 1.0);
          vec3 color = mix(dryColor, wetColor, wetPow);
          color = mix(color, saturated, pow(wetness, 3.0));
          float alpha = mix(0.35, 0.95, wetPow);
          fragColor = vec4(color, alpha);
        }
```

## Terrain detail foveation

Keeps nearby terrain crisp with a high-frequency detail texture and fades it with distance using the provided depth buffer.

```glsl
#version 300 es
precision highp float;

uniform sampler2D u_color;
uniform sampler2D u_detail;
uniform float u_near;
uniform float u_far;
uniform float u_detail_near_scale;
uniform float u_detail_far_scale;
uniform float u_detail_intensity;
uniform float u_gloss_intensity;
uniform vec3 u_gloss_color;

in vec2 v_uv;
in float v_depth;

out vec4 fragColor;

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

float linearizeDepth(float depth) {
  float z = depth * 2.0 - 1.0;
  return (2.0 * u_near * u_far) / (u_far + u_near - z * (u_far - u_near));
}

void main() {
  vec4 base = texture(u_color, v_uv);
  vec3 baseLinear = srgbToLinear(base).rgb;
  float depthLinear = linearizeDepth(v_depth);
  float distanceFactor = clamp((depthLinear - u_near) / max(u_far - u_near, 0.0001), 0.0, 1.0);
  float focus = smoothstep(0.0, 0.4, 1.0 - distanceFactor);
  float scale = mix(u_detail_far_scale, u_detail_near_scale, focus);
  vec2 detailUv = v_uv * scale;
  vec3 detailSample = texture(u_detail, detailUv).rgb * 2.0 - 1.0;
  vec3 detailLinear = detailSample * (u_detail_intensity * focus);
  float rim = pow(1.0 - distanceFactor, 3.0) * u_gloss_intensity;
  vec3 glossLinear = u_gloss_color * rim;
  vec3 finalLinear = baseLinear + detailLinear + glossLinear;
  fragColor = vec4(linearToSrgb(finalLinear), base.a);
}
```

## Aspect

Color-coded slope aspect using a bright categorical palette.

```glsl
#version 300 es
        precision highp float;
        precision highp int;
        
    precision highp float;
    precision highp int;
    uniform sampler2D u_image;
    uniform sampler2D u_hillshade_gradient;
        uniform sampler2D u_image_0_m2;
    uniform sampler2D u_image_topLeft;
    uniform sampler2D u_image_top;
    uniform sampler2D u_image_topRight;
    uniform sampler2D u_image_m2_0;
    uniform sampler2D u_image_left;
    uniform sampler2D u_image_right;
    uniform sampler2D u_image_p2_0;
    uniform sampler2D u_image_bottomLeft;
    uniform sampler2D u_image_bottom;
    uniform sampler2D u_image_bottomRight;
    uniform sampler2D u_image_0_p2;

    uniform vec4 u_terrain_unpack;
    uniform vec2 u_dimension;
    uniform float u_zoom;
    uniform float u_metersPerPixel;
    uniform float u_metersPerPixel_0_m2;
    uniform float u_metersPerPixel_topLeft;
    uniform float u_metersPerPixel_top;
    uniform float u_metersPerPixel_topRight;
    uniform float u_metersPerPixel_m2_0;
    uniform float u_metersPerPixel_left;
    uniform float u_metersPerPixel_right;
    uniform float u_metersPerPixel_p2_0;
    uniform float u_metersPerPixel_bottomLeft;
    uniform float u_metersPerPixel_bottom;
    uniform float u_metersPerPixel_bottomRight;
    uniform float u_metersPerPixel_0_p2;
    uniform vec2 u_latrange;
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
      const int MAX_OFFSET = 2;
      for (int i = 0; i < 8; ++i) {
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
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTexture(u_image_0_m2, tilePos);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTexture(u_image_topLeft, tilePos);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTexture(u_image_top, tilePos);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTexture(u_image_topRight, tilePos);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTexture(u_image_m2_0, tilePos);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTexture(u_image_left, tilePos);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTexture(u_image_right, tilePos);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTexture(u_image_p2_0, tilePos);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTexture(u_image_bottomLeft, tilePos);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTexture(u_image_bottom, tilePos);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTexture(u_image_bottomRight, tilePos);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTexture(u_image_0_p2, tilePos);
      }
      return getElevationFromTexture(u_image, tilePos);
    }

    float fetchElevationForOffsetLod(ivec2 offset, vec2 tilePos, float lod) {
      if (offset == ivec2(0, 0)) {
        return getElevationFromTextureLod(u_image, tilePos, lod);
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTextureLod(u_image_0_m2, tilePos, lod);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTextureLod(u_image_topLeft, tilePos, lod);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTextureLod(u_image_top, tilePos, lod);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTextureLod(u_image_topRight, tilePos, lod);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTextureLod(u_image_m2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTextureLod(u_image_left, tilePos, lod);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTextureLod(u_image_right, tilePos, lod);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTextureLod(u_image_p2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTextureLod(u_image_bottomLeft, tilePos, lod);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTextureLod(u_image_bottom, tilePos, lod);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTextureLod(u_image_bottomRight, tilePos, lod);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTextureLod(u_image_0_p2, tilePos, lod);
      }
      return getElevationFromTextureLod(u_image, tilePos, lod);
    }

    float getMetersPerPixelForOffset(ivec2 offset) {
      if (offset == ivec2(0, 0)) {
        return max(u_metersPerPixel, 0.0);
      }
      if (offset == ivec2(0, -2)) {
        return max(u_metersPerPixel_0_m2, 0.0);
      }
      if (offset == ivec2(-1, -1)) {
        return max(u_metersPerPixel_topLeft, 0.0);
      }
      if (offset == ivec2(0, -1)) {
        return max(u_metersPerPixel_top, 0.0);
      }
      if (offset == ivec2(1, -1)) {
        return max(u_metersPerPixel_topRight, 0.0);
      }
      if (offset == ivec2(-2, 0)) {
        return max(u_metersPerPixel_m2_0, 0.0);
      }
      if (offset == ivec2(-1, 0)) {
        return max(u_metersPerPixel_left, 0.0);
      }
      if (offset == ivec2(1, 0)) {
        return max(u_metersPerPixel_right, 0.0);
      }
      if (offset == ivec2(2, 0)) {
        return max(u_metersPerPixel_p2_0, 0.0);
      }
      if (offset == ivec2(-1, 1)) {
        return max(u_metersPerPixel_bottomLeft, 0.0);
      }
      if (offset == ivec2(0, 1)) {
        return max(u_metersPerPixel_bottom, 0.0);
      }
      if (offset == ivec2(1, 1)) {
        return max(u_metersPerPixel_bottomRight, 0.0);
      }
      if (offset == ivec2(0, 2)) {
        return max(u_metersPerPixel_0_p2, 0.0);
      }
      return max(u_metersPerPixel, 0.0);
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
        }
```

## Avalanche

Highlights avalanche-prone slopes with a thermal ramp.

```glsl
#version 300 es
        precision highp float;
        precision highp int;
        
    precision highp float;
    precision highp int;
    uniform sampler2D u_image;
    uniform sampler2D u_hillshade_gradient;
        uniform sampler2D u_image_0_m2;
    uniform sampler2D u_image_topLeft;
    uniform sampler2D u_image_top;
    uniform sampler2D u_image_topRight;
    uniform sampler2D u_image_m2_0;
    uniform sampler2D u_image_left;
    uniform sampler2D u_image_right;
    uniform sampler2D u_image_p2_0;
    uniform sampler2D u_image_bottomLeft;
    uniform sampler2D u_image_bottom;
    uniform sampler2D u_image_bottomRight;
    uniform sampler2D u_image_0_p2;

    uniform vec4 u_terrain_unpack;
    uniform vec2 u_dimension;
    uniform float u_zoom;
    uniform float u_metersPerPixel;
    uniform float u_metersPerPixel_0_m2;
    uniform float u_metersPerPixel_topLeft;
    uniform float u_metersPerPixel_top;
    uniform float u_metersPerPixel_topRight;
    uniform float u_metersPerPixel_m2_0;
    uniform float u_metersPerPixel_left;
    uniform float u_metersPerPixel_right;
    uniform float u_metersPerPixel_p2_0;
    uniform float u_metersPerPixel_bottomLeft;
    uniform float u_metersPerPixel_bottom;
    uniform float u_metersPerPixel_bottomRight;
    uniform float u_metersPerPixel_0_p2;
    uniform vec2 u_latrange;
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
      const int MAX_OFFSET = 2;
      for (int i = 0; i < 8; ++i) {
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
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTexture(u_image_0_m2, tilePos);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTexture(u_image_topLeft, tilePos);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTexture(u_image_top, tilePos);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTexture(u_image_topRight, tilePos);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTexture(u_image_m2_0, tilePos);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTexture(u_image_left, tilePos);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTexture(u_image_right, tilePos);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTexture(u_image_p2_0, tilePos);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTexture(u_image_bottomLeft, tilePos);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTexture(u_image_bottom, tilePos);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTexture(u_image_bottomRight, tilePos);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTexture(u_image_0_p2, tilePos);
      }
      return getElevationFromTexture(u_image, tilePos);
    }

    float fetchElevationForOffsetLod(ivec2 offset, vec2 tilePos, float lod) {
      if (offset == ivec2(0, 0)) {
        return getElevationFromTextureLod(u_image, tilePos, lod);
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTextureLod(u_image_0_m2, tilePos, lod);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTextureLod(u_image_topLeft, tilePos, lod);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTextureLod(u_image_top, tilePos, lod);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTextureLod(u_image_topRight, tilePos, lod);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTextureLod(u_image_m2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTextureLod(u_image_left, tilePos, lod);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTextureLod(u_image_right, tilePos, lod);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTextureLod(u_image_p2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTextureLod(u_image_bottomLeft, tilePos, lod);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTextureLod(u_image_bottom, tilePos, lod);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTextureLod(u_image_bottomRight, tilePos, lod);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTextureLod(u_image_0_p2, tilePos, lod);
      }
      return getElevationFromTextureLod(u_image, tilePos, lod);
    }

    float getMetersPerPixelForOffset(ivec2 offset) {
      if (offset == ivec2(0, 0)) {
        return max(u_metersPerPixel, 0.0);
      }
      if (offset == ivec2(0, -2)) {
        return max(u_metersPerPixel_0_m2, 0.0);
      }
      if (offset == ivec2(-1, -1)) {
        return max(u_metersPerPixel_topLeft, 0.0);
      }
      if (offset == ivec2(0, -1)) {
        return max(u_metersPerPixel_top, 0.0);
      }
      if (offset == ivec2(1, -1)) {
        return max(u_metersPerPixel_topRight, 0.0);
      }
      if (offset == ivec2(-2, 0)) {
        return max(u_metersPerPixel_m2_0, 0.0);
      }
      if (offset == ivec2(-1, 0)) {
        return max(u_metersPerPixel_left, 0.0);
      }
      if (offset == ivec2(1, 0)) {
        return max(u_metersPerPixel_right, 0.0);
      }
      if (offset == ivec2(2, 0)) {
        return max(u_metersPerPixel_p2_0, 0.0);
      }
      if (offset == ivec2(-1, 1)) {
        return max(u_metersPerPixel_bottomLeft, 0.0);
      }
      if (offset == ivec2(0, 1)) {
        return max(u_metersPerPixel_bottom, 0.0);
      }
      if (offset == ivec2(1, 1)) {
        return max(u_metersPerPixel_bottomRight, 0.0);
      }
      if (offset == ivec2(0, 2)) {
        return max(u_metersPerPixel_0_p2, 0.0);
      }
      return max(u_metersPerPixel, 0.0);
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
        }
```

## Daylight

Integrates H4 horizon rasters into day-length hues.

```glsl
#version 300 es
        precision highp float;
        precision highp int;
        
    precision highp float;
    precision highp int;
    uniform sampler2D u_image;
    uniform sampler2D u_hillshade_gradient;
        uniform sampler2D u_image_0_m2;
    uniform sampler2D u_image_topLeft;
    uniform sampler2D u_image_top;
    uniform sampler2D u_image_topRight;
    uniform sampler2D u_image_m2_0;
    uniform sampler2D u_image_left;
    uniform sampler2D u_image_right;
    uniform sampler2D u_image_p2_0;
    uniform sampler2D u_image_bottomLeft;
    uniform sampler2D u_image_bottom;
    uniform sampler2D u_image_bottomRight;
    uniform sampler2D u_image_0_p2;

    uniform vec4 u_terrain_unpack;
    uniform vec2 u_dimension;
    uniform float u_zoom;
    uniform float u_metersPerPixel;
    uniform float u_metersPerPixel_0_m2;
    uniform float u_metersPerPixel_topLeft;
    uniform float u_metersPerPixel_top;
    uniform float u_metersPerPixel_topRight;
    uniform float u_metersPerPixel_m2_0;
    uniform float u_metersPerPixel_left;
    uniform float u_metersPerPixel_right;
    uniform float u_metersPerPixel_p2_0;
    uniform float u_metersPerPixel_bottomLeft;
    uniform float u_metersPerPixel_bottom;
    uniform float u_metersPerPixel_bottomRight;
    uniform float u_metersPerPixel_0_p2;
    uniform vec2 u_latrange;
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
      const int MAX_OFFSET = 2;
      for (int i = 0; i < 8; ++i) {
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
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTexture(u_image_0_m2, tilePos);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTexture(u_image_topLeft, tilePos);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTexture(u_image_top, tilePos);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTexture(u_image_topRight, tilePos);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTexture(u_image_m2_0, tilePos);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTexture(u_image_left, tilePos);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTexture(u_image_right, tilePos);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTexture(u_image_p2_0, tilePos);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTexture(u_image_bottomLeft, tilePos);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTexture(u_image_bottom, tilePos);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTexture(u_image_bottomRight, tilePos);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTexture(u_image_0_p2, tilePos);
      }
      return getElevationFromTexture(u_image, tilePos);
    }

    float fetchElevationForOffsetLod(ivec2 offset, vec2 tilePos, float lod) {
      if (offset == ivec2(0, 0)) {
        return getElevationFromTextureLod(u_image, tilePos, lod);
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTextureLod(u_image_0_m2, tilePos, lod);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTextureLod(u_image_topLeft, tilePos, lod);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTextureLod(u_image_top, tilePos, lod);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTextureLod(u_image_topRight, tilePos, lod);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTextureLod(u_image_m2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTextureLod(u_image_left, tilePos, lod);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTextureLod(u_image_right, tilePos, lod);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTextureLod(u_image_p2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTextureLod(u_image_bottomLeft, tilePos, lod);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTextureLod(u_image_bottom, tilePos, lod);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTextureLod(u_image_bottomRight, tilePos, lod);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTextureLod(u_image_0_p2, tilePos, lod);
      }
      return getElevationFromTextureLod(u_image, tilePos, lod);
    }

    float getMetersPerPixelForOffset(ivec2 offset) {
      if (offset == ivec2(0, 0)) {
        return max(u_metersPerPixel, 0.0);
      }
      if (offset == ivec2(0, -2)) {
        return max(u_metersPerPixel_0_m2, 0.0);
      }
      if (offset == ivec2(-1, -1)) {
        return max(u_metersPerPixel_topLeft, 0.0);
      }
      if (offset == ivec2(0, -1)) {
        return max(u_metersPerPixel_top, 0.0);
      }
      if (offset == ivec2(1, -1)) {
        return max(u_metersPerPixel_topRight, 0.0);
      }
      if (offset == ivec2(-2, 0)) {
        return max(u_metersPerPixel_m2_0, 0.0);
      }
      if (offset == ivec2(-1, 0)) {
        return max(u_metersPerPixel_left, 0.0);
      }
      if (offset == ivec2(1, 0)) {
        return max(u_metersPerPixel_right, 0.0);
      }
      if (offset == ivec2(2, 0)) {
        return max(u_metersPerPixel_p2_0, 0.0);
      }
      if (offset == ivec2(-1, 1)) {
        return max(u_metersPerPixel_bottomLeft, 0.0);
      }
      if (offset == ivec2(0, 1)) {
        return max(u_metersPerPixel_bottom, 0.0);
      }
      if (offset == ivec2(1, 1)) {
        return max(u_metersPerPixel_bottomRight, 0.0);
      }
      if (offset == ivec2(0, 2)) {
        return max(u_metersPerPixel_0_p2, 0.0);
      }
      return max(u_metersPerPixel, 0.0);
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
  
        uniform highp sampler2DArray u_h4Horizon;
        uniform sampler2D      u_h4Lut;
        uniform int   u_h4AzimuthCount;
        uniform int   u_h4QuantizationLevels;
        uniform float u_h4MinutesToHours;
        uniform float u_h4MaxHours;
        uniform int   u_shadowSampleCount;
        uniform float u_shadowBlurRadius;
        uniform float u_shadowMaxDistance;
        uniform float u_shadowVisibilityThreshold;
        uniform float u_shadowEdgeSoftness;
        uniform float u_shadowRayStepMultiplier;
        in  highp vec2  v_texCoord;
        in  highp float v_elevation;
        out vec4 fragColor;

        const int MAX_H4_AZIMUTS = 64;

        int readHorizonIndex(vec2 uv, int azimuthIndex, int quantLevels) {
          int safeLevels = max(quantLevels, 2);
          float normalized = texture(u_h4Horizon, vec3(uv, float(azimuthIndex))).r;
          float scaled = normalized * float(safeLevels - 1);
          float clamped = clamp(floor(scaled + 0.5), 0.0, float(safeLevels - 1));
          return int(clamped);
        }

        void main(){
          int azCount = clamp(u_h4AzimuthCount, 1, MAX_H4_AZIMUTS);
          int quantLevels = max(u_h4QuantizationLevels, 2);
          float minutes = 0.0;
          for (int i = 0; i < MAX_H4_AZIMUTS; ++i) {
            if (i >= azCount) {
              break;
            }
            int levelIndex = readHorizonIndex(v_texCoord, i, quantLevels);
            float minutesAbove = max(texelFetch(u_h4Lut, ivec2(levelIndex, i), 0).r, 0.0);
            minutes += minutesAbove;
          }
          float hours = minutes * u_h4MinutesToHours;
          float hoursPerAzimuth = hours / float(azCount);
          float maxHours = max(u_h4MaxHours, 0.0);
          float durationRatio = maxHours > 0.0
            ? clamp(hoursPerAzimuth / maxHours, 0.0, 1.0)
            : 0.0;
          float sunriseRatio = clamp(0.5 - hoursPerAzimuth / 48.0, 0.0, 1.0);
          vec3 cold = vec3(0.2, 0.45, 0.9);
          vec3 warm = vec3(0.98, 0.45, 0.25);
          vec3 base = mix(cold, warm, durationRatio);
          float brightness = mix(0.6, 1.15, clamp(1.0 - sunriseRatio, 0.0, 1.0));
          vec3 finalColor = clamp(base * brightness, 0.0, 1.0);
          float contrast = 1.15;
          vec3 contrastedColor = clamp((finalColor - 0.5) * contrast + 0.5, 0.0, 1.0);
          fragColor = vec4(contrastedColor, 0.95);
        }
```

## Hillshade

Multi-parameter analytic hillshade with custom tints.

```glsl
#version 300 es
        precision highp float;
        precision highp int;
        
    precision highp float;
    precision highp int;
    uniform sampler2D u_image;
    uniform sampler2D u_hillshade_gradient;
        uniform sampler2D u_image_0_m2;
    uniform sampler2D u_image_topLeft;
    uniform sampler2D u_image_top;
    uniform sampler2D u_image_topRight;
    uniform sampler2D u_image_m2_0;
    uniform sampler2D u_image_left;
    uniform sampler2D u_image_right;
    uniform sampler2D u_image_p2_0;
    uniform sampler2D u_image_bottomLeft;
    uniform sampler2D u_image_bottom;
    uniform sampler2D u_image_bottomRight;
    uniform sampler2D u_image_0_p2;

    uniform vec4 u_terrain_unpack;
    uniform vec2 u_dimension;
    uniform float u_zoom;
    uniform float u_metersPerPixel;
    uniform float u_metersPerPixel_0_m2;
    uniform float u_metersPerPixel_topLeft;
    uniform float u_metersPerPixel_top;
    uniform float u_metersPerPixel_topRight;
    uniform float u_metersPerPixel_m2_0;
    uniform float u_metersPerPixel_left;
    uniform float u_metersPerPixel_right;
    uniform float u_metersPerPixel_p2_0;
    uniform float u_metersPerPixel_bottomLeft;
    uniform float u_metersPerPixel_bottom;
    uniform float u_metersPerPixel_bottomRight;
    uniform float u_metersPerPixel_0_p2;
    uniform vec2 u_latrange;
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
      const int MAX_OFFSET = 2;
      for (int i = 0; i < 8; ++i) {
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
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTexture(u_image_0_m2, tilePos);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTexture(u_image_topLeft, tilePos);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTexture(u_image_top, tilePos);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTexture(u_image_topRight, tilePos);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTexture(u_image_m2_0, tilePos);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTexture(u_image_left, tilePos);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTexture(u_image_right, tilePos);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTexture(u_image_p2_0, tilePos);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTexture(u_image_bottomLeft, tilePos);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTexture(u_image_bottom, tilePos);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTexture(u_image_bottomRight, tilePos);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTexture(u_image_0_p2, tilePos);
      }
      return getElevationFromTexture(u_image, tilePos);
    }

    float fetchElevationForOffsetLod(ivec2 offset, vec2 tilePos, float lod) {
      if (offset == ivec2(0, 0)) {
        return getElevationFromTextureLod(u_image, tilePos, lod);
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTextureLod(u_image_0_m2, tilePos, lod);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTextureLod(u_image_topLeft, tilePos, lod);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTextureLod(u_image_top, tilePos, lod);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTextureLod(u_image_topRight, tilePos, lod);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTextureLod(u_image_m2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTextureLod(u_image_left, tilePos, lod);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTextureLod(u_image_right, tilePos, lod);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTextureLod(u_image_p2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTextureLod(u_image_bottomLeft, tilePos, lod);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTextureLod(u_image_bottom, tilePos, lod);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTextureLod(u_image_bottomRight, tilePos, lod);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTextureLod(u_image_0_p2, tilePos, lod);
      }
      return getElevationFromTextureLod(u_image, tilePos, lod);
    }

    float getMetersPerPixelForOffset(ivec2 offset) {
      if (offset == ivec2(0, 0)) {
        return max(u_metersPerPixel, 0.0);
      }
      if (offset == ivec2(0, -2)) {
        return max(u_metersPerPixel_0_m2, 0.0);
      }
      if (offset == ivec2(-1, -1)) {
        return max(u_metersPerPixel_topLeft, 0.0);
      }
      if (offset == ivec2(0, -1)) {
        return max(u_metersPerPixel_top, 0.0);
      }
      if (offset == ivec2(1, -1)) {
        return max(u_metersPerPixel_topRight, 0.0);
      }
      if (offset == ivec2(-2, 0)) {
        return max(u_metersPerPixel_m2_0, 0.0);
      }
      if (offset == ivec2(-1, 0)) {
        return max(u_metersPerPixel_left, 0.0);
      }
      if (offset == ivec2(1, 0)) {
        return max(u_metersPerPixel_right, 0.0);
      }
      if (offset == ivec2(2, 0)) {
        return max(u_metersPerPixel_p2_0, 0.0);
      }
      if (offset == ivec2(-1, 1)) {
        return max(u_metersPerPixel_bottomLeft, 0.0);
      }
      if (offset == ivec2(0, 1)) {
        return max(u_metersPerPixel_bottom, 0.0);
      }
      if (offset == ivec2(1, 1)) {
        return max(u_metersPerPixel_bottomRight, 0.0);
      }
      if (offset == ivec2(0, 2)) {
        return max(u_metersPerPixel_0_p2, 0.0);
      }
      return max(u_metersPerPixel, 0.0);
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
          vec2 grad = getHillshadeGradient(v_texCoord);
          vec3 color = evaluateHillshade(grad);
          fragColor = vec4(color, u_hillshade_opacity);
        }
```

## Normal

Visualizes DEM normals as RGB vectors.

```glsl
#version 300 es
        precision highp float;
        precision highp int;
        
    precision highp float;
    precision highp int;
    uniform sampler2D u_image;
    uniform sampler2D u_hillshade_gradient;
        uniform sampler2D u_image_0_m2;
    uniform sampler2D u_image_topLeft;
    uniform sampler2D u_image_top;
    uniform sampler2D u_image_topRight;
    uniform sampler2D u_image_m2_0;
    uniform sampler2D u_image_left;
    uniform sampler2D u_image_right;
    uniform sampler2D u_image_p2_0;
    uniform sampler2D u_image_bottomLeft;
    uniform sampler2D u_image_bottom;
    uniform sampler2D u_image_bottomRight;
    uniform sampler2D u_image_0_p2;

    uniform vec4 u_terrain_unpack;
    uniform vec2 u_dimension;
    uniform float u_zoom;
    uniform float u_metersPerPixel;
    uniform float u_metersPerPixel_0_m2;
    uniform float u_metersPerPixel_topLeft;
    uniform float u_metersPerPixel_top;
    uniform float u_metersPerPixel_topRight;
    uniform float u_metersPerPixel_m2_0;
    uniform float u_metersPerPixel_left;
    uniform float u_metersPerPixel_right;
    uniform float u_metersPerPixel_p2_0;
    uniform float u_metersPerPixel_bottomLeft;
    uniform float u_metersPerPixel_bottom;
    uniform float u_metersPerPixel_bottomRight;
    uniform float u_metersPerPixel_0_p2;
    uniform vec2 u_latrange;
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
      const int MAX_OFFSET = 2;
      for (int i = 0; i < 8; ++i) {
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
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTexture(u_image_0_m2, tilePos);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTexture(u_image_topLeft, tilePos);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTexture(u_image_top, tilePos);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTexture(u_image_topRight, tilePos);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTexture(u_image_m2_0, tilePos);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTexture(u_image_left, tilePos);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTexture(u_image_right, tilePos);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTexture(u_image_p2_0, tilePos);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTexture(u_image_bottomLeft, tilePos);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTexture(u_image_bottom, tilePos);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTexture(u_image_bottomRight, tilePos);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTexture(u_image_0_p2, tilePos);
      }
      return getElevationFromTexture(u_image, tilePos);
    }

    float fetchElevationForOffsetLod(ivec2 offset, vec2 tilePos, float lod) {
      if (offset == ivec2(0, 0)) {
        return getElevationFromTextureLod(u_image, tilePos, lod);
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTextureLod(u_image_0_m2, tilePos, lod);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTextureLod(u_image_topLeft, tilePos, lod);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTextureLod(u_image_top, tilePos, lod);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTextureLod(u_image_topRight, tilePos, lod);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTextureLod(u_image_m2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTextureLod(u_image_left, tilePos, lod);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTextureLod(u_image_right, tilePos, lod);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTextureLod(u_image_p2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTextureLod(u_image_bottomLeft, tilePos, lod);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTextureLod(u_image_bottom, tilePos, lod);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTextureLod(u_image_bottomRight, tilePos, lod);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTextureLod(u_image_0_p2, tilePos, lod);
      }
      return getElevationFromTextureLod(u_image, tilePos, lod);
    }

    float getMetersPerPixelForOffset(ivec2 offset) {
      if (offset == ivec2(0, 0)) {
        return max(u_metersPerPixel, 0.0);
      }
      if (offset == ivec2(0, -2)) {
        return max(u_metersPerPixel_0_m2, 0.0);
      }
      if (offset == ivec2(-1, -1)) {
        return max(u_metersPerPixel_topLeft, 0.0);
      }
      if (offset == ivec2(0, -1)) {
        return max(u_metersPerPixel_top, 0.0);
      }
      if (offset == ivec2(1, -1)) {
        return max(u_metersPerPixel_topRight, 0.0);
      }
      if (offset == ivec2(-2, 0)) {
        return max(u_metersPerPixel_m2_0, 0.0);
      }
      if (offset == ivec2(-1, 0)) {
        return max(u_metersPerPixel_left, 0.0);
      }
      if (offset == ivec2(1, 0)) {
        return max(u_metersPerPixel_right, 0.0);
      }
      if (offset == ivec2(2, 0)) {
        return max(u_metersPerPixel_p2_0, 0.0);
      }
      if (offset == ivec2(-1, 1)) {
        return max(u_metersPerPixel_bottomLeft, 0.0);
      }
      if (offset == ivec2(0, 1)) {
        return max(u_metersPerPixel_bottom, 0.0);
      }
      if (offset == ivec2(1, 1)) {
        return max(u_metersPerPixel_bottomRight, 0.0);
      }
      if (offset == ivec2(0, 2)) {
        return max(u_metersPerPixel_0_p2, 0.0);
      }
      return max(u_metersPerPixel, 0.0);
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
  
        in  highp vec2 v_texCoord;
        out vec4 fragColor;
        void main() {
          vec2 grad   = computeSobelGradient(v_texCoord);
          vec3 normal = normalize(vec3(-grad, 1.0));
          fragColor   = vec4(normal * 0.5 + 0.5, 1.0);
        }
```

## Shadow

Ray-marched sun shadows with soft penumbra control.

```glsl
#version 300 es
        precision highp float;
        precision highp int;
        
    precision highp float;
    precision highp int;
    uniform sampler2D u_image;
    uniform sampler2D u_hillshade_gradient;
        uniform sampler2D u_image_0_m2;
    uniform sampler2D u_image_topLeft;
    uniform sampler2D u_image_top;
    uniform sampler2D u_image_topRight;
    uniform sampler2D u_image_m2_0;
    uniform sampler2D u_image_left;
    uniform sampler2D u_image_right;
    uniform sampler2D u_image_p2_0;
    uniform sampler2D u_image_bottomLeft;
    uniform sampler2D u_image_bottom;
    uniform sampler2D u_image_bottomRight;
    uniform sampler2D u_image_0_p2;

    uniform vec4 u_terrain_unpack;
    uniform vec2 u_dimension;
    uniform float u_zoom;
    uniform float u_metersPerPixel;
    uniform float u_metersPerPixel_0_m2;
    uniform float u_metersPerPixel_topLeft;
    uniform float u_metersPerPixel_top;
    uniform float u_metersPerPixel_topRight;
    uniform float u_metersPerPixel_m2_0;
    uniform float u_metersPerPixel_left;
    uniform float u_metersPerPixel_right;
    uniform float u_metersPerPixel_p2_0;
    uniform float u_metersPerPixel_bottomLeft;
    uniform float u_metersPerPixel_bottom;
    uniform float u_metersPerPixel_bottomRight;
    uniform float u_metersPerPixel_0_p2;
    uniform vec2 u_latrange;
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
      const int MAX_OFFSET = 2;
      for (int i = 0; i < 8; ++i) {
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
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTexture(u_image_0_m2, tilePos);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTexture(u_image_topLeft, tilePos);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTexture(u_image_top, tilePos);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTexture(u_image_topRight, tilePos);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTexture(u_image_m2_0, tilePos);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTexture(u_image_left, tilePos);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTexture(u_image_right, tilePos);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTexture(u_image_p2_0, tilePos);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTexture(u_image_bottomLeft, tilePos);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTexture(u_image_bottom, tilePos);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTexture(u_image_bottomRight, tilePos);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTexture(u_image_0_p2, tilePos);
      }
      return getElevationFromTexture(u_image, tilePos);
    }

    float fetchElevationForOffsetLod(ivec2 offset, vec2 tilePos, float lod) {
      if (offset == ivec2(0, 0)) {
        return getElevationFromTextureLod(u_image, tilePos, lod);
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTextureLod(u_image_0_m2, tilePos, lod);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTextureLod(u_image_topLeft, tilePos, lod);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTextureLod(u_image_top, tilePos, lod);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTextureLod(u_image_topRight, tilePos, lod);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTextureLod(u_image_m2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTextureLod(u_image_left, tilePos, lod);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTextureLod(u_image_right, tilePos, lod);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTextureLod(u_image_p2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTextureLod(u_image_bottomLeft, tilePos, lod);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTextureLod(u_image_bottom, tilePos, lod);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTextureLod(u_image_bottomRight, tilePos, lod);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTextureLod(u_image_0_p2, tilePos, lod);
      }
      return getElevationFromTextureLod(u_image, tilePos, lod);
    }

    float getMetersPerPixelForOffset(ivec2 offset) {
      if (offset == ivec2(0, 0)) {
        return max(u_metersPerPixel, 0.0);
      }
      if (offset == ivec2(0, -2)) {
        return max(u_metersPerPixel_0_m2, 0.0);
      }
      if (offset == ivec2(-1, -1)) {
        return max(u_metersPerPixel_topLeft, 0.0);
      }
      if (offset == ivec2(0, -1)) {
        return max(u_metersPerPixel_top, 0.0);
      }
      if (offset == ivec2(1, -1)) {
        return max(u_metersPerPixel_topRight, 0.0);
      }
      if (offset == ivec2(-2, 0)) {
        return max(u_metersPerPixel_m2_0, 0.0);
      }
      if (offset == ivec2(-1, 0)) {
        return max(u_metersPerPixel_left, 0.0);
      }
      if (offset == ivec2(1, 0)) {
        return max(u_metersPerPixel_right, 0.0);
      }
      if (offset == ivec2(2, 0)) {
        return max(u_metersPerPixel_p2_0, 0.0);
      }
      if (offset == ivec2(-1, 1)) {
        return max(u_metersPerPixel_bottomLeft, 0.0);
      }
      if (offset == ivec2(0, 1)) {
        return max(u_metersPerPixel_bottom, 0.0);
      }
      if (offset == ivec2(1, 1)) {
        return max(u_metersPerPixel_bottomRight, 0.0);
      }
      if (offset == ivec2(0, 2)) {
        return max(u_metersPerPixel_0_p2, 0.0);
      }
      return max(u_metersPerPixel, 0.0);
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
  
        uniform vec2  u_sunDirection;
        uniform float u_sunAltitude;
        uniform float u_sunSlope;
        uniform vec3  u_sunWarmColor;
        uniform float u_sunWarmIntensity;
        uniform int   u_shadowSampleCount;
        uniform float u_shadowBlurRadius;
        uniform float u_shadowMaxDistance;
        uniform float u_shadowVisibilityThreshold;
        uniform float u_shadowEdgeSoftness;
        uniform float u_shadowMaxOpacity;
        uniform float u_shadowRayStepMultiplier;
        uniform float u_shadowSlopeBias;
        uniform float u_shadowPixelBias;
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
          float slopeBiasBase = max(u_shadowSlopeBias, 0.0);
          float pixelBias = max(u_shadowPixelBias, 0.0);
          vec2 baseTexelStep = texelStep / stepMultiplier;
          float baseStepDistance = metersPerPixel / stepMultiplier;
          float maxSlope = -1e6;
          vec2 samplePos = startPos;
          float minBound = -2.0;
          float maxBound = 1.0 + 2.0;
          float stepFactor = 1.0;
          float traveled = 0.0;
          float lastBias = slopeBiasBase;
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
            if (maxSlope > sunSlope + lastBias) {
              float delta = maxSlope - (sunSlope + lastBias);
              if (delta > pixelBias) {
                float softnessFactor = max(softness, 0.0001);
                float gradient = delta / softnessFactor;
                float visibility = exp(-gradient);
                return clamp(visibility, 0.0, 1.0);
              }
            }
            lastBias = mix(lastBias, slopeBiasBase, 0.2);
            stepFactor = min(stepFactor * 1.25, 8.0);
          }
          return 1.0;
        }

        float computeSunVisibility(vec2 pos, float currentElevation) {
          if (u_shadowMaxDistance <= 0.0) {
            return 1.0;
          }

          vec2 horizontalDir = normalize(u_sunDirection);
          if (length(horizontalDir) < 1e-5) {
            return 1.0;
          }

          float tileResolution = u_dimension.x;
          vec2 texelStep = horizontalDir / tileResolution;
          float metersPerPixel = max(u_metersPerPixel, 0.0001);
          float sunSlope = u_sunSlope;

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
          fragColor = vec4(finalColor, shadowIntensity);
        }
```

## Slope

Rainbow ramp of slope steepness in degrees.

```glsl
#version 300 es
        precision highp float;
        precision highp int;
        
    precision highp float;
    precision highp int;
    uniform sampler2D u_image;
    uniform sampler2D u_hillshade_gradient;
        uniform sampler2D u_image_0_m2;
    uniform sampler2D u_image_topLeft;
    uniform sampler2D u_image_top;
    uniform sampler2D u_image_topRight;
    uniform sampler2D u_image_m2_0;
    uniform sampler2D u_image_left;
    uniform sampler2D u_image_right;
    uniform sampler2D u_image_p2_0;
    uniform sampler2D u_image_bottomLeft;
    uniform sampler2D u_image_bottom;
    uniform sampler2D u_image_bottomRight;
    uniform sampler2D u_image_0_p2;

    uniform vec4 u_terrain_unpack;
    uniform vec2 u_dimension;
    uniform float u_zoom;
    uniform float u_metersPerPixel;
    uniform float u_metersPerPixel_0_m2;
    uniform float u_metersPerPixel_topLeft;
    uniform float u_metersPerPixel_top;
    uniform float u_metersPerPixel_topRight;
    uniform float u_metersPerPixel_m2_0;
    uniform float u_metersPerPixel_left;
    uniform float u_metersPerPixel_right;
    uniform float u_metersPerPixel_p2_0;
    uniform float u_metersPerPixel_bottomLeft;
    uniform float u_metersPerPixel_bottom;
    uniform float u_metersPerPixel_bottomRight;
    uniform float u_metersPerPixel_0_p2;
    uniform vec2 u_latrange;
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
      const int MAX_OFFSET = 2;
      for (int i = 0; i < 8; ++i) {
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
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTexture(u_image_0_m2, tilePos);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTexture(u_image_topLeft, tilePos);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTexture(u_image_top, tilePos);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTexture(u_image_topRight, tilePos);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTexture(u_image_m2_0, tilePos);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTexture(u_image_left, tilePos);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTexture(u_image_right, tilePos);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTexture(u_image_p2_0, tilePos);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTexture(u_image_bottomLeft, tilePos);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTexture(u_image_bottom, tilePos);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTexture(u_image_bottomRight, tilePos);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTexture(u_image_0_p2, tilePos);
      }
      return getElevationFromTexture(u_image, tilePos);
    }

    float fetchElevationForOffsetLod(ivec2 offset, vec2 tilePos, float lod) {
      if (offset == ivec2(0, 0)) {
        return getElevationFromTextureLod(u_image, tilePos, lod);
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTextureLod(u_image_0_m2, tilePos, lod);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTextureLod(u_image_topLeft, tilePos, lod);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTextureLod(u_image_top, tilePos, lod);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTextureLod(u_image_topRight, tilePos, lod);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTextureLod(u_image_m2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTextureLod(u_image_left, tilePos, lod);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTextureLod(u_image_right, tilePos, lod);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTextureLod(u_image_p2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTextureLod(u_image_bottomLeft, tilePos, lod);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTextureLod(u_image_bottom, tilePos, lod);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTextureLod(u_image_bottomRight, tilePos, lod);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTextureLod(u_image_0_p2, tilePos, lod);
      }
      return getElevationFromTextureLod(u_image, tilePos, lod);
    }

    float getMetersPerPixelForOffset(ivec2 offset) {
      if (offset == ivec2(0, 0)) {
        return max(u_metersPerPixel, 0.0);
      }
      if (offset == ivec2(0, -2)) {
        return max(u_metersPerPixel_0_m2, 0.0);
      }
      if (offset == ivec2(-1, -1)) {
        return max(u_metersPerPixel_topLeft, 0.0);
      }
      if (offset == ivec2(0, -1)) {
        return max(u_metersPerPixel_top, 0.0);
      }
      if (offset == ivec2(1, -1)) {
        return max(u_metersPerPixel_topRight, 0.0);
      }
      if (offset == ivec2(-2, 0)) {
        return max(u_metersPerPixel_m2_0, 0.0);
      }
      if (offset == ivec2(-1, 0)) {
        return max(u_metersPerPixel_left, 0.0);
      }
      if (offset == ivec2(1, 0)) {
        return max(u_metersPerPixel_right, 0.0);
      }
      if (offset == ivec2(2, 0)) {
        return max(u_metersPerPixel_p2_0, 0.0);
      }
      if (offset == ivec2(-1, 1)) {
        return max(u_metersPerPixel_bottomLeft, 0.0);
      }
      if (offset == ivec2(0, 1)) {
        return max(u_metersPerPixel_bottom, 0.0);
      }
      if (offset == ivec2(1, 1)) {
        return max(u_metersPerPixel_bottomRight, 0.0);
      }
      if (offset == ivec2(0, 2)) {
        return max(u_metersPerPixel_0_p2, 0.0);
      }
      return max(u_metersPerPixel, 0.0);
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
        }
```

## Snow

Stylized snow-cover estimator with slope/aspect bias.

```glsl
#version 300 es
        precision highp float;
        
    precision highp float;
    precision highp int;
    uniform sampler2D u_image;
    uniform sampler2D u_hillshade_gradient;
        uniform sampler2D u_image_0_m2;
    uniform sampler2D u_image_topLeft;
    uniform sampler2D u_image_top;
    uniform sampler2D u_image_topRight;
    uniform sampler2D u_image_m2_0;
    uniform sampler2D u_image_left;
    uniform sampler2D u_image_right;
    uniform sampler2D u_image_p2_0;
    uniform sampler2D u_image_bottomLeft;
    uniform sampler2D u_image_bottom;
    uniform sampler2D u_image_bottomRight;
    uniform sampler2D u_image_0_p2;

    uniform vec4 u_terrain_unpack;
    uniform vec2 u_dimension;
    uniform float u_zoom;
    uniform float u_metersPerPixel;
    uniform float u_metersPerPixel_0_m2;
    uniform float u_metersPerPixel_topLeft;
    uniform float u_metersPerPixel_top;
    uniform float u_metersPerPixel_topRight;
    uniform float u_metersPerPixel_m2_0;
    uniform float u_metersPerPixel_left;
    uniform float u_metersPerPixel_right;
    uniform float u_metersPerPixel_p2_0;
    uniform float u_metersPerPixel_bottomLeft;
    uniform float u_metersPerPixel_bottom;
    uniform float u_metersPerPixel_bottomRight;
    uniform float u_metersPerPixel_0_p2;
    uniform vec2 u_latrange;
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
      const int MAX_OFFSET = 2;
      for (int i = 0; i < 8; ++i) {
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
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTexture(u_image_0_m2, tilePos);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTexture(u_image_topLeft, tilePos);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTexture(u_image_top, tilePos);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTexture(u_image_topRight, tilePos);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTexture(u_image_m2_0, tilePos);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTexture(u_image_left, tilePos);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTexture(u_image_right, tilePos);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTexture(u_image_p2_0, tilePos);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTexture(u_image_bottomLeft, tilePos);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTexture(u_image_bottom, tilePos);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTexture(u_image_bottomRight, tilePos);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTexture(u_image_0_p2, tilePos);
      }
      return getElevationFromTexture(u_image, tilePos);
    }

    float fetchElevationForOffsetLod(ivec2 offset, vec2 tilePos, float lod) {
      if (offset == ivec2(0, 0)) {
        return getElevationFromTextureLod(u_image, tilePos, lod);
      }
      if (offset == ivec2(0, -2)) {
        return getElevationFromTextureLod(u_image_0_m2, tilePos, lod);
      }
      if (offset == ivec2(-1, -1)) {
        return getElevationFromTextureLod(u_image_topLeft, tilePos, lod);
      }
      if (offset == ivec2(0, -1)) {
        return getElevationFromTextureLod(u_image_top, tilePos, lod);
      }
      if (offset == ivec2(1, -1)) {
        return getElevationFromTextureLod(u_image_topRight, tilePos, lod);
      }
      if (offset == ivec2(-2, 0)) {
        return getElevationFromTextureLod(u_image_m2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 0)) {
        return getElevationFromTextureLod(u_image_left, tilePos, lod);
      }
      if (offset == ivec2(1, 0)) {
        return getElevationFromTextureLod(u_image_right, tilePos, lod);
      }
      if (offset == ivec2(2, 0)) {
        return getElevationFromTextureLod(u_image_p2_0, tilePos, lod);
      }
      if (offset == ivec2(-1, 1)) {
        return getElevationFromTextureLod(u_image_bottomLeft, tilePos, lod);
      }
      if (offset == ivec2(0, 1)) {
        return getElevationFromTextureLod(u_image_bottom, tilePos, lod);
      }
      if (offset == ivec2(1, 1)) {
        return getElevationFromTextureLod(u_image_bottomRight, tilePos, lod);
      }
      if (offset == ivec2(0, 2)) {
        return getElevationFromTextureLod(u_image_0_p2, tilePos, lod);
      }
      return getElevationFromTextureLod(u_image, tilePos, lod);
    }

    float getMetersPerPixelForOffset(ivec2 offset) {
      if (offset == ivec2(0, 0)) {
        return max(u_metersPerPixel, 0.0);
      }
      if (offset == ivec2(0, -2)) {
        return max(u_metersPerPixel_0_m2, 0.0);
      }
      if (offset == ivec2(-1, -1)) {
        return max(u_metersPerPixel_topLeft, 0.0);
      }
      if (offset == ivec2(0, -1)) {
        return max(u_metersPerPixel_top, 0.0);
      }
      if (offset == ivec2(1, -1)) {
        return max(u_metersPerPixel_topRight, 0.0);
      }
      if (offset == ivec2(-2, 0)) {
        return max(u_metersPerPixel_m2_0, 0.0);
      }
      if (offset == ivec2(-1, 0)) {
        return max(u_metersPerPixel_left, 0.0);
      }
      if (offset == ivec2(1, 0)) {
        return max(u_metersPerPixel_right, 0.0);
      }
      if (offset == ivec2(2, 0)) {
        return max(u_metersPerPixel_p2_0, 0.0);
      }
      if (offset == ivec2(-1, 1)) {
        return max(u_metersPerPixel_bottomLeft, 0.0);
      }
      if (offset == ivec2(0, 1)) {
        return max(u_metersPerPixel_bottom, 0.0);
      }
      if (offset == ivec2(1, 1)) {
        return max(u_metersPerPixel_bottomRight, 0.0);
      }
      if (offset == ivec2(0, 2)) {
        return max(u_metersPerPixel_0_p2, 0.0);
      }
      return max(u_metersPerPixel, 0.0);
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
  
        uniform float u_snow_altitude;
        uniform float u_snow_maxSlope;
        uniform float u_snow_blur;
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
            vec3 normal = normalize(vec3(-grad * 2.0, 1.0));
            vec3 lightDir = normalize(vec3(0.45, 0.35, 0.82));
            float diffuse = clamp(dot(normal, lightDir), -1.0, 1.0);
            float lambert = clamp(0.5 + 0.5 * diffuse, 0.0, 1.0);
            float contrast = pow(lambert, 0.7);
            float shadowBoost = pow(1.0 - lambert, 2.0);
            vec3 shadowColor = vec3(0.6, 0.67, 0.78);
            vec3 highlightColor = vec3(0.94);
            vec3 color = mix(shadowColor, highlightColor, contrast);
            color *= (1.0 - 0.18 * shadowBoost);
            float specular = pow(max(diffuse, 0.0), 8.0) * 0.06;
            vec3 ambient = vec3(0.88, 0.92, 0.97);
            color = mix(ambient, color + specular, 0.7);
            float fresnel = pow(1.0 - clamp(dot(normal, lightDir), 0.0, 1.0), 3.0);
            vec3 skyTint = vec3(0.76, 0.84, 0.96);
            color = mix(color, skyTint, fresnel * 0.3);
            float ambientOcclusion = smoothstep(0.0, 0.6, lambert);
            color *= mix(0.82, 1.0, ambientOcclusion);
            return clamp(color, 0.0, 1.0);
        }
        float computeSlopeAspectBias(float aspect) {
            float northness = cos(radians(aspect + 180.0));
            return northness * 3.0;
        }
        float computeSnowMask(vec2 pos) {
            float slopeSoftness = 1.5;
            float elevation = getElevationExtended(pos);
            vec2 grad = computeSobelGradient(pos);
            float slope = degrees(atan(length(grad)));
            float aspect = getAspect(grad);
            float slopeBias = computeSlopeAspectBias(aspect);
            float slopeThreshold = clamp(u_snow_maxSlope + slopeBias, 0.0, 90.0);
            float altitudeMask = smoothstep(
                u_snow_altitude + 100.0,
                u_snow_altitude + 200.0,
                elevation
            );
            float slopeMask = 1.0 - smoothstep(
                slopeThreshold - slopeSoftness,
                slopeThreshold + slopeSoftness,
                slope
            );
            float snowCoverage = getSnowCoverageForElevation(elevation, aspect);
            return clamp(altitudeMask * slopeMask * snowCoverage, 0.0, 1.0);
        }
        void main() {
            vec2 grad = computeSobelGradient(v_texCoord);
            float aspect = getAspect(grad);
            float slope  = computeSlopeDegrees(v_texCoord);
            float slopeBias = computeSlopeAspectBias(aspect);
            float slopeThreshold = clamp(u_snow_maxSlope + slopeBias, 0.0, 90.0);
            float altitudeMask = smoothstep(
                u_snow_altitude + 100.0,
                u_snow_altitude + 200.0,
                v_elevation
            );
            float slopeSoftness = 1.5;
            float slopeMask = 1.0 - smoothstep(
                slopeThreshold - slopeSoftness,
                slopeThreshold + slopeSoftness,
                slope
            );
            float snowCoverage = getSnowCoverageForElevation(v_elevation, aspect);
            float baseMask = clamp(altitudeMask * slopeMask * snowCoverage, 0.0, 1.0);
            float blurAmount = max(u_snow_blur, 0.0);
            float blurMix = clamp(blurAmount, 0.0, 1.0);
            vec2 texel = 1.0 / u_dimension;
            const float maskSigma = 0.35;
            const float slopeSigma = 10.0;
            const float altitudeSigma = 120.0;
            const float invTwoMaskSigmaSq = 1.0 / (2.0 * maskSigma * maskSigma);
            const float invTwoSlopeSigmaSq = 1.0 / (2.0 * slopeSigma * slopeSigma);
            const float invTwoAltitudeSigmaSq = 1.0 / (2.0 * altitudeSigma * altitudeSigma);
            float baseWeight = 4.0;
            float accum = baseMask * baseWeight;
            float weight = baseWeight;
            float uniformAccum = baseMask;
            float uniformWeight = 1.0;
            const vec2 kernelOffsets[8] = vec2[](
                vec2(1.0, 0.0), vec2(-1.0, 0.0),
                vec2(0.0, 1.0), vec2(0.0, -1.0),
                vec2(1.0, 1.0), vec2(1.0, -1.0),
                vec2(-1.0, 1.0), vec2(-1.0, -1.0)
            );
            const float kernelWeights[8] = float[](2.0, 2.0, 2.0, 2.0, 1.0, 1.0, 1.0, 1.0);
            for (int i = 0; i < 8; i++) {
                vec2 offset = kernelOffsets[i] * texel;
                float neighborMask = computeSnowMask(v_texCoord + offset);
                float neighborSlope = computeSlopeDegrees(v_texCoord + offset);
                float neighborElevation = getElevationExtended(v_texCoord + offset);
                float maskDelta = neighborMask - baseMask;
                float slopeDelta = neighborSlope - slope;
                float altitudeDelta = neighborElevation - v_elevation;
                float bilateral = exp(-maskDelta * maskDelta * invTwoMaskSigmaSq
                                      - slopeDelta * slopeDelta * invTwoSlopeSigmaSq
                                      - altitudeDelta * altitudeDelta * invTwoAltitudeSigmaSq);
                float sampleWeight = kernelWeights[i] * bilateral;
                accum += neighborMask * sampleWeight;
                weight += sampleWeight;
                uniformAccum += neighborMask;
                uniformWeight += 1.0;
            }
            float blurredMask = clamp(accum / weight, 0.0, 1.0);
            float uniformBlur = clamp(uniformAccum / uniformWeight, 0.0, 1.0);
            float extraBlur = clamp(blurAmount - 1.0, 0.0, 1.0);
            float finalMask = mix(baseMask, blurredMask, blurMix);
            float strongerMask = mix(blurredMask, uniformBlur, extraBlur);
            finalMask = mix(finalMask, strongerMask, extraBlur);
            vec3 snowColor = evaluateSnowHillshade(grad);
            fragColor = vec4(snowColor, finalMask * 0.95);
        }
```

## Heavy Fog

Depth-based atmospheric fog with a sky-tinted horizon.

```glsl
#version 300 es
precision highp float;

uniform sampler2D u_color;
uniform vec4 u_fog_color;
uniform vec4 u_horizon_color;
uniform float u_near;
uniform float u_far;
uniform float u_fog_start;
uniform float u_fog_end;

in vec2 v_uv;
in float v_depth;

out vec4 fragColor;

float linearizeDepth(float depth) {
    float z = depth * 2.0 - 1.0;
    return (2.0 * u_near * u_far) / (u_far + u_near - z * (u_far - u_near));
}

void main() {
    vec4 base = texture(u_color, v_uv);
    float eyeDepth = linearizeDepth(v_depth);
    float fogAmount = smoothstep(u_fog_start, u_fog_end, eyeDepth);

    vec4 fogColor = mix(u_fog_color, u_horizon_color, fogAmount);

    vec3 baseLinear = srgbToLinear(base).rgb;
    vec3 fogLinear = srgbToLinear(fogColor).rgb;
    vec3 resultLinear = mix(baseLinear, fogLinear, fogAmount);

    fragColor = linearToSrgb(vec4(resultLinear, base.a));
}
```
