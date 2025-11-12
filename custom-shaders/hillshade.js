(function() {
  const registry = window.terrainCustomShaderSources = window.terrainCustomShaderSources || {};
  registry.hillshade = function(common) {
    return `#version 300 es
        precision highp float;
        precision highp int;
        ${common}
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
          vec2 grad = computeSobelGradient(v_texCoord);
          vec3 color = evaluateHillshade(grad);
          fragColor = vec4(color, u_hillshade_opacity);
        }`;
  };
})();
