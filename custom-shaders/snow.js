(function() {
  const registry = window.terrainCustomShaderSources = window.terrainCustomShaderSources || {};
  registry.snow = function(common) {
    return `#version 300 es
        precision highp float;
        ${common}
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
        }`;
  };
})();
