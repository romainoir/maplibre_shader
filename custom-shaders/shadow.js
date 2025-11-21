(function () {
  const registry = window.terrainCustomShaderSources = window.terrainCustomShaderSources || {};
  registry.shadow = function (common) {
    return `#version 300 es
        precision highp float;
        precision highp int;
        ${common}
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

        // H4 Global Horizon Uniforms
        uniform highp sampler2DArray u_h4Horizon;
        uniform int   u_h4AzimuthCount;
        uniform int   u_h4QuantizationLevels;
        uniform float u_h4AngleMin;
        uniform float u_h4AngleMax;
        
        in  highp vec2  v_texCoord;
        in  highp float v_elevation;
        out vec4 fragColor;

        const int MAX_SHADOW_STEPS = 64;
        const int MAX_PENUMBRA_SAMPLES = 16;
        const float PI = 3.14159265359;

        const float bayer4x4[16] = float[](
            0.0/16.0, 8.0/16.0, 2.0/16.0, 10.0/16.0,
            12.0/16.0, 4.0/16.0, 14.0/16.0, 6.0/16.0,
            3.0/16.0, 11.0/16.0, 1.0/16.0, 9.0/16.0,
            15.0/16.0, 7.0/16.0, 13.0/16.0, 5.0/16.0
        );

        float getDither(vec2 pos) {
            int x = int(pos.x) % 4;
            int y = int(pos.y) % 4;
            return bayer4x4[y * 4 + x];
        }

        float readHorizonAngle(vec2 uv, int azimuthIndex) {
          vec2 rg = texture(u_h4Horizon, vec3(uv, float(azimuthIndex))).rg;
          float val = rg.r * 65280.0 + rg.g * 255.0;
          float normalized = val / 65535.0;
          return mix(u_h4AngleMin, u_h4AngleMax, normalized);
        }

        float computeGlobalVisibility(vec2 uv) {
          int azCount = max(u_h4AzimuthCount, 1);
          vec2 sunDir = normalize(u_sunDirection);
          if (length(sunDir) < 1e-5) {
            return 1.0;
          }

          float sunAngle = atan(sunDir.y, sunDir.x);
          if (sunAngle < 0.0) {
            sunAngle += 2.0 * PI;
          }
          float azStep = (2.0 * PI) / float(azCount);
          float azFloat = sunAngle / azStep;
          int azIndex0 = int(floor(azFloat)) % azCount;
          if (azIndex0 < 0) azIndex0 += azCount;
          int azIndex1 = (azIndex0 + 1) % azCount;
          float azT = fract(azFloat);

          float angle0 = readHorizonAngle(uv, azIndex0);
          float angle1 = readHorizonAngle(uv, azIndex1);
          float horizonAngle = mix(angle0, angle1, azT);

          float soften = 0.01;
          float delta = u_sunAltitude - horizonAngle;
          return smoothstep(-soften, soften, delta);
        }

        float traceLocalShadowRay(vec2 startPos, float currentElevation, vec2 texelStep, float metersPerPixel, float sunSlope) {
          float maxDist = u_shadowMaxDistance;
          if (maxDist <= 0.0) return 1.0;
          maxDist = min(maxDist, 200.0);

          float threshold = max(u_shadowVisibilityThreshold, 0.0);
          float softness = max(u_shadowEdgeSoftness, 0.0);
          float stepMultiplier = max(u_shadowRayStepMultiplier, 0.1);
          float slopeBiasBase = max(u_shadowSlopeBias, 0.0);
          float pixelBias = max(u_shadowPixelBias, 0.0);

          vec2 baseTexelStep = texelStep / stepMultiplier;
          float baseStepDistance = metersPerPixel / stepMultiplier;
          float maxSlope = -1e6;
          vec2 samplePos = startPos;
          float stepFactor = 1.0;
          float traveled = baseStepDistance * getDither(gl_FragCoord.xy);
          float lastBias = slopeBiasBase;

          float minBound = -${SHADER_MAX_NEIGHBOR_OFFSET}.0;
          float maxBound = 1.0 + ${SHADER_MAX_NEIGHBOR_OFFSET}.0;

          for (int i = 0; i < MAX_SHADOW_STEPS; ++i) {
            float nextDistance = traveled + baseStepDistance * stepFactor;
            if (nextDistance > maxDist) {
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

            float dynamicBias = slopeBiasBase + pixelBias * (metersPerPixel / max(traveled, metersPerPixel));
            float targetSlope = sunSlope - dynamicBias;
            lastBias = dynamicBias;

            if (maxSlope >= targetSlope - threshold) {
              float visibilityNow = targetSlope - maxSlope;
              if (softness <= 0.0001) {
                return visibilityNow > threshold ? 1.0 : 0.0;
              }
              float soften = max(softness, 1e-4);
              return smoothstep(threshold, threshold + soften, visibilityNow);
            }

            float growth = computeAdaptiveStepGrowth(traveled);
            stepFactor = min(stepFactor * growth, 64.0);
          }

          float targetSlope = sunSlope - lastBias;
          float visibility = targetSlope - maxSlope;
          if (softness <= 0.0001) {
            return visibility > threshold ? 1.0 : 0.0;
          }
          float soften = max(softness, 1e-4);
          return smoothstep(threshold, threshold + soften, visibility);
        }

        float computeCastVisibility(vec2 pos, float currentElevation, vec2 sunXY, float metersPerPixel) {
          if (u_sunAltitude <= 0.0) {
            return 0.0;
          }

          float globalVisibility = computeGlobalVisibility(pos);
          if (globalVisibility <= 0.001) {
            return 0.0;
          }

          if (length(sunXY) < 1e-5) {
            return globalVisibility;
          }

          float tileResolution = u_dimension.x;
          vec2 texelStep = sunXY / tileResolution;
          float localVisibility = traceLocalShadowRay(pos, currentElevation, texelStep, metersPerPixel, u_sunSlope);
          return min(globalVisibility, localVisibility);
        }

        float sampleCastVisibility(vec2 pos, float currentElevation, vec2 sunXY, float metersPerPixel) {
          int samples = clamp(u_shadowSampleCount, 1, MAX_PENUMBRA_SAMPLES);
          float radius = max(u_shadowBlurRadius, 0.0);
          if (radius <= 0.0001 || samples <= 1 || length(sunXY) < 1e-5) {
            return computeCastVisibility(pos, currentElevation, sunXY, metersPerPixel);
          }

          vec2 perpendicular = vec2(-sunXY.y, sunXY.x);
          float sigma = max(radius * 0.5, 0.0001);
          float weightSum = 0.0;
          float visibilityAccum = 0.0;
          float invTileRes = 1.0 / u_dimension.x;

          for (int i = 0; i < MAX_PENUMBRA_SAMPLES; ++i) {
            if (i >= samples) {
              break;
            }
            float t = (samples == 1) ? 0.0 : float(i) / float(samples - 1);
            float centered = t * 2.0 - 1.0;
            float offsetAmount = centered * radius;
            float weight = exp(-0.5 * pow(offsetAmount / sigma, 2.0));
            vec2 offsetPos = pos + perpendicular * (offsetAmount * invTileRes);
            visibilityAccum += weight * computeCastVisibility(offsetPos, currentElevation, sunXY, metersPerPixel);
            weightSum += weight;
          }

          return weightSum > 0.0 ? visibilityAccum / weightSum : 1.0;
        }

        void main(){
          vec2 sunXY = normalize(u_sunDirection);
          float metersPerPixel = max(u_metersPerPixel, 0.0001);
          float castVisibility = sampleCastVisibility(v_texCoord, v_elevation, sunXY, metersPerPixel);

          vec2 grad = computeSobelGradient(v_texCoord);
          vec3 normal = normalize(vec3(-grad, 1.0));
          vec3 sunDir = normalize(vec3(sunXY, u_sunSlope));
          float lambert = dot(normal, sunDir);
          float selfLight = smoothstep(-0.12, 0.08, lambert);
          float selfShadow = 1.0 - selfLight;

          float castShadow = 1.0 - castVisibility;
          float combinedShadow = clamp(castShadow + (1.0 - castShadow) * selfShadow, 0.0, 1.0);

          float maxOpacity = clamp(u_shadowMaxOpacity, 0.0, 1.0);
          float shadowAmount = clamp(combinedShadow * maxOpacity, 0.0, 1.0);

          // Add ambient detail based on slope to reveal terrain shape in shadows
          float slope = length(grad);
          float ambientDetail = 1.0 - clamp(slope * 0.5, 0.0, 0.3);

          // Mix between full light (1.0) and ambient shadow (with detail)
          // Base ambient raised to 0.35 to allow detail to darken crevices without crushing blacks
          float brightness = mix(1.0, 0.35 * ambientDetail, shadowAmount);
          
          float warmMix = clamp(u_sunWarmIntensity, 0.0, 1.0) * shadowAmount;
          vec3 tint = mix(vec3(1.0), u_sunWarmColor, warmMix);
          vec3 color = brightness * tint;

          fragColor = vec4(color, 1.0);
        }`;
  };
})();
