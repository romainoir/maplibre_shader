(function () {
   const registry = window.terrainCustomShaderSources = window.terrainCustomShaderSources || {};
   registry.daylight = function (common) {
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
        uniform int   u_daylightMode; // 0=Duration, 1=Sunrise, 2=Sunset
        uniform vec2  u_sunriseRange; // x=min, y=max (minutes)
        uniform vec2  u_sunsetRange;  // x=min, y=max (minutes)
        
        in  highp vec2  v_texCoord;
        in  highp float v_elevation;
        out vec4 fragColor;

        const int MAX_H4_AZIMUTS = 96;

        int readHorizonIndex(vec2 uv, int azimuthIndex, int quantLevels) {
          int safeLevels = max(quantLevels, 2);
          vec2 rg = texture(u_h4Horizon, vec3(uv, float(azimuthIndex))).rg;
          float val = rg.r * 65280.0 + rg.g * 255.0; // r*255*256 + g*255
          float normalized = val / 65535.0;
          float scaled = normalized * float(safeLevels - 1);
          float clamped = clamp(floor(scaled + 0.5), 0.0, float(safeLevels - 1));
          return int(clamped);
        }

        // Inferno color palette for Duration
        vec3 inferno(float t) {
            t = clamp(t, 0.0, 1.0);
            vec3 c0 = vec3(0.001, 0.000, 0.014); // Black/Purple
            vec3 c1 = vec3(0.251, 0.000, 0.294); // Deep Purple
            vec3 c2 = vec3(0.573, 0.106, 0.427); // Purple/Red
            vec3 c3 = vec3(0.867, 0.310, 0.224); // Red/Orange
            vec3 c4 = vec3(0.988, 0.655, 0.208); // Orange/Yellow
            vec3 c5 = vec3(0.988, 0.996, 0.639); // Pale Yellow/White

            if (t < 0.2) return mix(c0, c1, t * 5.0);
            if (t < 0.4) return mix(c1, c2, (t - 0.2) * 5.0);
            if (t < 0.6) return mix(c2, c3, (t - 0.4) * 5.0);
            if (t < 0.8) return mix(c3, c4, (t - 0.6) * 5.0);
            return mix(c4, c5, (t - 0.8) * 5.0);
        }

        // Sunrise Palette: Red (Earliest) -> Black (Later)
        vec3 sunrisePalette(float t) {
            t = clamp(t, 0.0, 1.0);
            // Red for the very first light, fading to black
            return mix(vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, 0.0), t); 
        }

        // Sunset Palette: Black (Earlier) -> Green (Latest)
        vec3 sunsetPalette(float t) {
            t = clamp(t, 0.0, 1.0);
            // Black fading to Green for the very last light
            return mix(vec3(0.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), t);
        }

        void main(){
          int azCount = clamp(u_h4AzimuthCount, 1, MAX_H4_AZIMUTS);
          int quantLevels = max(u_h4QuantizationLevels, 2);
          
          float totalMinutes = 0.0;
          float firstSunTime = 99999.0;
          float lastSunTime = -1.0;
          
          // Iterate azimuths to find duration and time bounds
          for (int i = 0; i < MAX_H4_AZIMUTS; ++i) {
            if (i >= azCount) {
              break;
            }
            int levelIndex = readHorizonIndex(v_texCoord, i, quantLevels);
            
            // Read RGBA: R=Duration, G=MinTime, B=MaxTime
            vec4 lutData = texelFetch(u_h4Lut, ivec2(levelIndex, i), 0);
            float dur = max(lutData.r, 0.0);
            float start = lutData.g;
            float end = lutData.b;
            
            if (dur > 0.0) {
                totalMinutes += dur;
                if (start >= 0.0) firstSunTime = min(firstSunTime, start);
                if (end >= 0.0) lastSunTime = max(lastSunTime, end);
            }
          }
          
          vec3 finalColor = vec3(0.0);
          
          if (u_daylightMode == 1) { // Sunrise
             if (firstSunTime > 2000.0) {
                finalColor = vec3(0.0); // No sun
             } else {
                // Use dynamic range
                float range = max(u_sunriseRange.y - u_sunriseRange.x, 1.0);
                float t = clamp((firstSunTime - u_sunriseRange.x) / range, 0.0, 1.0);
                // If t is 0.0 (earliest), it's Red. If t is 1.0 (latest), it's Black.
                // But we only want to show things within the window.
                // If firstSunTime is outside the window (e.g. much later), t will be 1.0 -> Black.
                // If firstSunTime is much earlier (e.g. 2am?), t will be 0.0 -> Red.
                // We might want to clamp "too early" to black as well if it's unreasonable?
                // For now, let's assume the window covers the interesting part.
                finalColor = sunrisePalette(t);
             }
          } else if (u_daylightMode == 2) { // Sunset
             if (lastSunTime < 0.0) {
                finalColor = vec3(0.0); // No sun
             } else {
                // Use dynamic range
                float range = max(u_sunsetRange.y - u_sunsetRange.x, 1.0);
                float t = clamp((lastSunTime - u_sunsetRange.x) / range, 0.0, 1.0);
                // If t is 1.0 (latest), it's Green. If t is 0.0 (earlier), it's Black.
                finalColor = sunsetPalette(t);
             }
          } else { // Duration (Default)
              float totalHours = totalMinutes * u_h4MinutesToHours;
              float maxDayHours = 16.0; 
              float ratio = clamp(totalHours / maxDayHours, 0.0, 1.0);
              float mapT = smoothstep(0.0, 1.0, ratio);
              finalColor = inferno(mapT);
          }
          
          // Add a bit of hillshade/shading for depth context
          vec2 grad = computeSobelGradient(v_texCoord);
          float slope = length(grad);
          float shade = 1.0 - clamp(slope * 0.5, 0.0, 0.3);
          
          fragColor = vec4(finalColor * shade, 0.95);
        }`;
   };
})();
