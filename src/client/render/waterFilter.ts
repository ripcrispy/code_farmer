import { Filter, GlProgram } from "pixi.js";
import { HH, HW } from "./iso.ts";

/**
 * Animated water: one pass over the painted terrain layer that draws the whole water
 * surface. The painter stores how much of each pixel is water in its alpha (254 a trace .. 241 open water, see
 * terrainPainter.ts); the shader draws the water in the painted terrain's palette: drifting
 * deep and shallow patches, a moving network of caustic lines in the light wave colour over
 * a softer web, fine painted grain, and a lapping foam line where it meets the shore.
 * The pattern is computed in tile space (so it stays put when the camera moves) and fades
 * to a flat colour when zoomed far out, where it would only shimmer.
 */
const vertex = `in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

void main(void)
{
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    gl_Position = vec4(position, 0.0, 1.0);
    vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
}
`;

const fragment = `in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
// highp: must match the vertex shader's precision, and screen/world coordinates need it.
uniform highp vec4 uInputSize;
uniform highp vec4 uOutputFrame;
uniform highp float uTime;
// Screen pixel of world point (0, 0), and screen pixels per world pixel.
uniform highp vec2 uOrigin;
uniform highp float uScale;

// The painted terrain's water palette (terrainPainter.ts): deep and shallow water, the
// light wave colour for caustic lines, and foam for highlights and the shoreline.
const vec3 DEEP = vec3(0.114, 0.290, 0.455);
const vec3 SHALLOW = vec3(0.184, 0.471, 0.627);
const vec3 WAVE = vec3(0.498, 0.753, 0.847);
const vec3 FOAM = vec3(0.847, 0.925, 0.941);
const float HW = ${HW.toFixed(1)};
const float HH = ${HH.toFixed(1)};
// Caustic cells per tile.
const float DENSITY = 0.8;

float hash1(highp vec2 p) {
    p = mod(p, 256.0);
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float vnoise(highp vec2 p) {
    highp vec2 i = floor(p);
    vec2 f = p - i;
    f = f * f * (3.0 - 2.0 * f);
    float a = hash1(i);
    float b = hash1(i + vec2(1.0, 0.0));
    float c = hash1(i + vec2(0.0, 1.0));
    float d = hash1(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

highp vec2 hash2(highp vec2 p) {
    p = mod(p, 256.0);
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
}

// Moving cells: x = distance to the nearest border (second-nearest minus nearest point),
// y = third-nearest minus nearest, small where three cells meet.
vec2 cells(highp vec2 p, highp float t) {
    highp vec2 i = floor(p);
    highp vec2 f = p - i;
    float f1 = 8.0;
    float f2 = 8.0;
    float f3 = 8.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 g = vec2(float(x), float(y));
            vec2 h = hash2(i + g);
            vec2 o = 0.5 + 0.4 * sin(t * (0.55 + 0.5 * h) + 6.2831 * h.yx);
            float d = length(g + o - f);
            if (d < f1) { f3 = f2; f2 = f1; f1 = d; }
            else if (d < f2) { f3 = f2; f2 = d; }
            else if (d < f3) { f3 = d; }
        }
    }
    return vec2(f2 - f1, f3 - f1);
}

void main(void)
{
    vec4 color = texture(uTexture, vTextureCoord);
    float a = color.a * 255.0;
    // Dry ground (255), empty space and chunk edges are left alone.
    if (a < 240.5 || a > 254.6) {
        finalColor = color;
        return;
    }
    float w = clamp((254.5 - a) / 13.5, 0.0, 1.0);
    highp vec2 screen = vTextureCoord * uInputSize.xy + uOutputFrame.xy;
    highp vec2 world = (screen - uOrigin) / uScale;
    highp vec2 tile = vec2(world.x / HW + world.y / HH, world.y / HH - world.x / HW) * 0.5;
    highp float t = uTime;

    // Size of one screen pixel in pattern units: used for smooth edges and to fade the
    // pattern out when zoomed so far out that it would shimmer.
    float px = DENSITY * 0.7071 / (HH * uScale);
    float detail = 1.0 - smoothstep(0.1, 0.25, px);

    // Rounded, wavy cells: bend the plane with a broad and a fine layer of slow waves.
    highp vec2 p = tile * DENSITY;
    p += 0.22 * vec2(sin(p.y * 1.7 + t * 0.7), sin(p.x * 1.45 - t * 0.6));
    p += 0.13 * vec2(sin(p.y * 5.0 - t * 1.1), sin(p.x * 4.7 + t * 0.9));
    vec2 c = cells(p, t);
    float aa = max(px, 0.006);
    // White lines: thin, swelling here and there, with blobs where three cells meet.
    float thick = 0.042 * (1.0 + 0.8 * sin(p.x * 1.9 + p.y * 1.4 + t * 0.5) * sin(p.y * 2.3 - t * 0.4));
    float line = 1.0 - smoothstep(thick - aa, thick + aa, c.x);
    float blob = (1.0 - smoothstep(0.15 - aa, 0.15 + aa, c.y)) * (1.0 - smoothstep(0.28, 0.32, c.x));
    line = max(line, blob);
    // The lighter web: a finer, slower network, broken into pieces.
    highp vec2 q = p * 1.7 + vec2(5.3, 2.1);
    vec2 c2 = cells(q, t * 0.8 + 1.0);
    float pieces = clamp((sin(q.x * 0.9 + q.y * 1.3 + t * 0.3) * sin(q.y * 1.1 - q.x * 0.4) + 0.1) / 0.1, 0.0, 1.0);
    float web = (1.0 - smoothstep(0.07 - aa, 0.07 + aa, c2.x)) * pieces;

    // Base: broad, slowly drifting patches of deep and shallow water, as in the painted
    // terrain, with the same large-scale light variation.
    float depth = vnoise(tile * 0.35 + vec2(t * 0.04, -t * 0.03));
    vec3 water = mix(DEEP, SHALLOW, 0.25 + depth * 0.6);
    water *= 0.92 + vnoise(tile * 0.12) * 0.16;
    // The web is a soft lighter tone; the caustic lines use the painted wave colour, a
    // little brighter where cells meet.
    water = mix(water, mix(water, WAVE, 0.45), web * 0.6);
    water = mix(water, WAVE, line * 0.8);
    water = mix(water, FOAM, blob * 0.35);
    // Zoomed far out: just the base tones with a hint of the lines.
    vec3 farColor = mix(DEEP, SHALLOW, 0.25 + depth * 0.6) * (0.92 + vnoise(tile * 0.12) * 0.16);
    water = mix(mix(farColor, WAVE, 0.08), water, detail);
    // Fine painted grain (8 texels per tile, like the terrain), fixed to the ground.
    water *= 0.97 + 0.06 * hash1(floor(tile * 8.0));

    // Shoreline: the painted ground shows where there is little water; a foam line laps
    // back and forth along the edge.
    vec3 painted = color.rgb / max(color.a, 0.001);
    float shore = w + 0.07 * sin(t * 1.6 + (tile.x + tile.y) * 1.1);
    float cover = smoothstep(0.42, 0.5, shore);
    float foam = smoothstep(0.42, 0.47, shore) * (1.0 - smoothstep(0.6, 0.66, shore));
    vec3 rgb = mix(painted, water, cover);
    rgb = mix(rgb, FOAM, foam * 0.75);
    finalColor = vec4(rgb, 1.0);
}
`;

/**
 * Compile and link the shaders once ourselves before using them: if this GPU rejects
 * them, the caller keeps still water instead of a terrain layer that renders nothing.
 */
export function waterShaderWorks(gl: WebGL2RenderingContext | WebGLRenderingContext): boolean {
  const head = "#version 300 es\nprecision highp float;\n";
  const compile = (type: number, src: string): WebGLShader | null => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, head + src);
    gl.compileShader(sh);
    if (gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return sh;
    console.warn("Water shader did not compile; showing still water:", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  };
  const v = compile(gl.VERTEX_SHADER, vertex);
  const f = compile(gl.FRAGMENT_SHADER, fragment);
  if (!v || !f) return false;
  const prog = gl.createProgram();
  if (!prog) return false;
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  gl.linkProgram(prog);
  const ok = !!gl.getProgramParameter(prog, gl.LINK_STATUS);
  if (!ok) console.warn("Water shader did not link; showing still water:", gl.getProgramInfoLog(prog));
  gl.deleteProgram(prog);
  gl.deleteShader(v);
  gl.deleteShader(f);
  return ok;
}

export class WaterFilter extends Filter {
  constructor() {
    super({
      glProgram: GlProgram.from({ vertex, fragment, name: "cf-water" }),
      resources: {
        waterUniforms: {
          uTime: { value: 0, type: "f32" },
          uOrigin: { value: new Float32Array(2), type: "vec2<f32>" },
          uScale: { value: 1, type: "f32" },
        },
      },
    });
  }

  /** Per frame: time in seconds, and how world pixels map to filter (device) pixels. */
  update(time: number, originX: number, originY: number, scale: number): void {
    const u = this.resources.waterUniforms.uniforms as { uTime: number; uOrigin: Float32Array; uScale: number };
    u.uTime = time;
    u.uOrigin[0] = originX;
    u.uOrigin[1] = originY;
    u.uScale = scale;
  }
}
