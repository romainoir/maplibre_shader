in float v_depth;

// methods for pack/unpack depth value to texture rgba
// https://stackoverflow.com/questions/34963366/encode-floating-point-data-in-a-rgba-texture
const highp vec4 bitSh = vec4(256. * 256. * 256., 256. * 256., 256., 1.);
const highp vec4 bitMsk = vec4(0.,vec3(1./256.0));
highp vec4 pack(highp float value) {
    highp vec4 comp = fract(value * bitSh);
    comp -= comp.xxyz * bitMsk;
    return comp;
}

highp float encodeDepth(highp float clipSpaceDepth) {
    // Convert clip-space depth (-1..1) into the 0..1 range expected by the
    // packing routine before storing it in the color attachment. Clamping keeps
    // precision issues from generating NaNs when the clip coordinate drifts
    // slightly outside of the canonical range.
    return clamp(clipSpaceDepth * 0.5 + 0.5, 0.0, 1.0);
}

void main() {
    fragColor = pack(encodeDepth(v_depth));
}
