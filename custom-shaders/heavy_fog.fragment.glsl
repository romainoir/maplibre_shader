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
