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

#ifndef ML_SRGB_HELPERS
#define ML_SRGB_HELPERS
vec3 srgbToLinear(vec3 color) {
    vec3 srgb = clamp(color, 0.0, 1.0);
    vec3 lo = srgb / 12.92;
    vec3 hi = pow((srgb + 0.055) / 1.055, vec3(2.4));
    return mix(lo, hi, step(vec3(0.04045), srgb));
}

vec4 srgbToLinear(vec4 color) {
    return vec4(srgbToLinear(color.rgb), color.a);
}

vec3 linearToSrgb(vec3 color) {
    vec3 linear = max(color, vec3(0.0));
    vec3 lo = linear * 12.92;
    vec3 hi = 1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055;
    return mix(lo, hi, step(vec3(0.0031308), linear));
}

vec4 linearToSrgb(vec4 color) {
    return vec4(linearToSrgb(color.rgb), color.a);
}
#endif

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
