(function() {
  const registry = window.terrainCustomShaderSources = window.terrainCustomShaderSources || {};
  registry.shadow = function(common) {
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
          float minBound = -${SHADER_MAX_NEIGHBOR_OFFSET}.0;
          float maxBound = 1.0 + ${SHADER_MAX_NEIGHBOR_OFFSET}.0;
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
          fragColor = vec4(finalColor, 1.0);
        }`;
  };
})();
