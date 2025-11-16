import {describe, expect, test, vi} from 'vitest';
import {DepthMode} from '../gl/depth_mode';
import {drawSky} from './draw_sky';

vi.mock('./program/sky_program', () => ({
    skyUniformValues: vi.fn().mockReturnValue('sky-uniforms')
}));

describe('drawSky', () => {
    test('draws with depth testing disabled so sky overlays custom layers', () => {
        const draw = vi.fn();
        const useProgram = vi.fn().mockReturnValue({draw});
        const painter: any = {
            context: {
                gl: {TRIANGLES: 4}
            },
            style: {map: {transform: {}}},
            pixelRatio: 1,
            useProgram,
            colorModeForRenderPass: vi.fn().mockReturnValue('color-mode')
        };
        const sky: any = {
            mesh: {
                vertexBuffer: 'vb',
                indexBuffer: 'ib',
                segments: []
            }
        };

        drawSky(painter, sky);

        expect(draw).toHaveBeenCalled();
        const [, , depthMode] = draw.mock.calls[0];
        expect(depthMode).toBe(DepthMode.disabled);
    });
});
