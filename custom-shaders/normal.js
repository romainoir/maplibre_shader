(function() {
  const registry = window.terrainCustomShaderSources = window.terrainCustomShaderSources || {};
  registry.normal = function(common) {
    return `#version 300 es
        precision highp float;
        precision highp int;
        ${common}
        in  highp vec2 v_texCoord;
        out vec4 fragColor;
        void main() {
          vec2 grad   = computeSobelGradient(v_texCoord);
          vec3 normal = normalize(vec3(-grad, 1.0));
          fragColor   = vec4(normal * 0.5 + 0.5, 1.0);
        }`;
  };
})();
