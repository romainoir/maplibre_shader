(function() {
  const registry = window.terrainCustomShaderSources = window.terrainCustomShaderSources || {};
  registry.aspect = function(common) {
    return `#version 300 es
        precision highp float;
        precision highp int;
        ${common}
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
  };
})();
