(function() {
  const registry = window.terrainCustomShaderSources = window.terrainCustomShaderSources || {};
  registry.slope = function(common) {
    return `#version 300 es
        precision highp float;
        precision highp int;
        ${common}
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
  };
})();
