import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { AppError } from './errors.js';

export const UPLOAD_LIMITS = Object.freeze({
  maxFiles: 10,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxPixels: 40_000_000,
});

const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');
const invalidImage = () => new AppError(400, 'INVALID_IMAGE', '图片已损坏或内容不完整，请重新选择原始图片。');
const unsupportedImage = () => new AppError(415, 'UNSUPPORTED_IMAGE', '仅支持后缀、文件类型和实际内容一致的 JPG、JPEG 或 PNG 图片。');
const animatedImage = () => new AppError(415, 'ANIMATED_IMAGE', '不支持动画或多帧图片，请上传静态 JPG 或 PNG 图片。');
const tooManyPixels = () => new AppError(413, 'IMAGE_TOO_MANY_PIXELS', '图片像素不能超过 4000 万，请缩小后重试。');

function validatePngChunks(buffer) {
  // libvips may expose APNG as a static PNG, so inspect real chunk boundaries.
  let offset = 8;
  let hasPixels = false;
  while (offset + 12 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > buffer.length) throw invalidImage();
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (offset === 8 && (type !== 'IHDR' || size !== 13)) throw invalidImage();
    if (crc32(buffer.subarray(offset + 4, end - 4)) !== buffer.readUInt32BE(end - 4)) throw invalidImage();
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw animatedImage();
    if (type === 'IDAT') hasPixels = true;
    if (type === 'IEND') {
      if (size !== 0 || end !== buffer.length || !hasPixels) throw invalidImage();
      return;
    }
    offset = end;
  }
  throw invalidImage();
}

/** Validate bytes only. The supplied name is never used as a filesystem path. */
export async function validateImage(buffer, { name, mime } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw invalidImage();
  if (buffer.length > UPLOAD_LIMITS.maxFileBytes) {
    throw new AppError(413, 'IMAGE_TOO_LARGE', '单张图片不能超过 10 MB，请压缩后重试。');
  }
  const suffix = typeof name === 'string' && /\.(png|jpe?g)$/i.exec(name)?.[1].toLowerCase();
  const format = suffix === 'png' ? 'png' : ['jpg', 'jpeg'].includes(suffix) ? 'jpeg' : null;
  if (!format || mime !== `image/${format}`) throw unsupportedImage();
  const actualFormat = buffer.subarray(0, 8).equals(PNG_MAGIC) ? 'png'
    : buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff ? 'jpeg' : null;
  if (actualFormat !== format) throw unsupportedImage();
  if (format === 'png') validatePngChunks(buffer);
  else if (buffer.length < 4 || buffer.readUInt16BE(buffer.length - 2) !== 0xffd9) throw invalidImage();

  const options = { failOn: 'warning', limitInputPixels: UPLOAD_LIMITS.maxPixels };
  try {
    const image = sharp(buffer, options);
    const metadata = await image.metadata();
    if (metadata.format !== format) throw unsupportedImage();
    if ((metadata.pages ?? 1) !== 1 || metadata.delay?.length || metadata.loop !== undefined) throw animatedImage();
    const { width, height } = metadata;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw invalidImage();
    if (width * height > UPLOAD_LIMITS.maxPixels) throw tooManyPixels();
    // stats reads every pixel; metadata alone cannot detect corrupt pixel data.
    // No resize/shrink or large raw output buffer can hide a truncated region.
    await image.stats();
    return { mime: `image/${format}`, extension: format === 'jpeg' ? 'jpg' : 'png', width, height, size: buffer.length };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (typeof error?.message === 'string' && error.message.includes('pixel limit')) throw tooManyPixels();
    throw invalidImage();
  }
}
