(function() {
  const registry = window.terrainCustomShaderSources = window.terrainCustomShaderSources || {};
  registry.daylight = function(common) {
    return `#version 300 es
        precision highp float;
        precision highp int;
        ${common}
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
        }`;
  };
})();
