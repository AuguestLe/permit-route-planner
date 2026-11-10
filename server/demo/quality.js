import sharp from 'sharp';

const RESOLUTION_MIN = 400;
const ENTROPY_MIN = 1.0;
const LAPLACIAN_MIN = 45;
const BRIGHT_VALUE = 245;
const BRIGHT_RATIO_MAX = 0.18;
const DARK_VALUE = 10;
const DARK_RATIO_MAX = 0.75;
const DOWNSCALE_EDGE = 768;

function check(code, label, value, threshold, status) {
  return { code, label, value, threshold, status };
}

function entropy(histogram, total) {
  let result = 0;
  for (const count of histogram) {
    if (!count) continue;
    const probability = count / total;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function laplacianVariance(pixels, width, height) {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let squared = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const laplacian = -4 * pixels[index]
        + pixels[index - 1] + pixels[index + 1]
        + pixels[index - width] + pixels[index + width];
      sum += laplacian;
      squared += laplacian * laplacian;
      count += 1;
    }
  }
  if (!count) return 0;
  const mean = sum / count;
  return squared / count - mean * mean;
}

/** Explainable synthetic-demo quality heuristics, not authenticity detection. */
export async function inspectQuality(buffer) {
  const metadata = await sharp(buffer, { failOn: 'warning', limitInputPixels: 40_000_000 }).metadata();
  if (!Number.isInteger(metadata.width) || !Number.isInteger(metadata.height)) {
    throw new CodeError('INVALID_IMAGE', '图片无法读取。');
  }
  const { data, info } = await sharp(buffer, { failOn: 'warning', limitInputPixels: 40_000_000 })
    .greyscale()
    .resize({ width: DOWNSCALE_EDGE, height: DOWNSCALE_EDGE, fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const width = info.width;
  const height = info.height;
  const pixels = new Uint8Array(width * height);
  for (let index = 0; index < pixels.length; index += 1) pixels[index] = data[index * channels];

  const histogram = new Uint32Array(256);
  let bright = 0;
  let dark = 0;
  for (const pixel of pixels) {
    histogram[pixel] += 1;
    if (pixel > BRIGHT_VALUE) bright += 1;
    if (pixel < DARK_VALUE) dark += 1;
  }
  const total = pixels.length;
  const checks = [
    check('resolution', '最小分辨率', `${metadata.width}×${metadata.height}`, `${RESOLUTION_MIN}×${RESOLUTION_MIN}`,
      metadata.width < RESOLUTION_MIN || metadata.height < RESOLUTION_MIN ? 'reject' : 'pass'),
    check('blank', '空白程度', entropy(histogram, total).toFixed(3), ENTROPY_MIN,
      entropy(histogram, total) < ENTROPY_MIN ? 'reject' : 'pass'),
    check('blur', '清晰度代理', laplacianVariance(pixels, width, height).toFixed(1), LAPLACIAN_MIN,
      laplacianVariance(pixels, width, height) < LAPLACIAN_MIN ? 'warn' : 'pass'),
    check('brightness', '过亮像素比例', bright / total, BRIGHT_RATIO_MAX,
      bright / total > BRIGHT_RATIO_MAX ? 'warn' : 'pass'),
    check('darkness', '过暗像素比例', dark / total, DARK_RATIO_MAX,
      dark / total > DARK_RATIO_MAX ? 'warn' : 'pass'),
  ];
  const status = checks.some(item => item.status === 'reject') ? 'reject'
    : checks.some(item => item.status === 'warn') ? 'warn' : 'pass';
  return { status, checks };
}

export class CodeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CodeError';
    this.code = code;
  }
}
