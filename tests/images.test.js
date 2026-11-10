import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { AppError } from '../server/errors.js';
import { UPLOAD_LIMITS, validateImage } from '../server/images.js';

const pngInfo = { name: '测试样本.PNG', mime: 'image/png' };
const jpegInfo = { name: 'sample.JpEg', mime: 'image/jpeg' };
const smallImage = (format) => sharp({
  create: { width: 24, height: 16, channels: 3, background: '#fff' },
}).toFormat(format).toBuffer();

function chunk(type, data = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  body.copy(result, 4);
  result.writeUInt32BE(crc32(body), result.length - 4);
  return result;
}

// A 1-bit image keeps the 40MP boundary fixture's input allocation near 5 MB.
function monochromePng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((1 + Math.ceil(width / 8)) * height))),
    chunk('IEND'),
  ]);
}

function rejectsWith(status, code) {
  return (error) => error instanceof AppError && error.status === status && error.code === code;
}

test('accepts genuine PNG and JPEG with case-insensitive filename extensions', async () => {
  for (const [format, info, extension] of [['png', pngInfo, 'png'], ['jpeg', jpegInfo, 'jpg']]) {
    const buffer = await smallImage(format);
    assert.deepEqual(await validateImage(buffer, info), {
      mime: info.mime, extension, width: 24, height: 16, size: buffer.length,
    });
  }
  await validateImage(await smallImage('jpeg'), { name: 'sample.JPG', mime: 'image/jpeg' });
});

test('checks extension, declared MIME and actual image format independently', async () => {
  const png = await smallImage('png');
  const jpeg = await smallImage('jpeg');
  const cases = [
    [png, { name: 'sample.svg', mime: 'image/png' }],
    [png, { name: 'sample.png.exe', mime: 'image/png' }],
    [png, { name: 'sample.png', mime: 'image/jpeg' }],
    [png, { name: 'sample.jpg', mime: 'image/jpeg' }],
    [jpeg, pngInfo],
    [png, { name: 'sample.png', mime: 'image/svg+xml' }],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>private</text></svg>'), pngInfo],
  ];
  for (const [buffer, info] of cases) {
    await assert.rejects(validateImage(buffer, info), rejectsWith(415, 'UNSUPPORTED_IMAGE'));
  }
});

test('rejects empty, non-buffer, truncated PNG and truncated JPEG without leaking contents', async () => {
  const png = await smallImage('png');
  const jpeg = await smallImage('jpeg');
  for (const [buffer, info] of [
    [Buffer.alloc(0), pngInfo], ['private', pngInfo],
    [png.subarray(0, png.length - 12), pngInfo],
    [jpeg.subarray(0, jpeg.length - 2), jpegInfo],
  ]) {
    await assert.rejects(validateImage(buffer, info), rejectsWith(400, 'INVALID_IMAGE'));
  }
});

test('decodes image data rather than trusting a readable header', async () => {
  const image = await smallImage('png');
  let offset = 8;
  while (image.toString('ascii', offset + 4, offset + 8) !== 'IDAT') {
    offset += image.readUInt32BE(offset) + 12;
  }
  const length = image.readUInt32BE(offset);
  // Keep the chunk framing and checksum valid, corrupt only compressed pixels.
  const damaged = Buffer.concat([
    image.subarray(0, offset), chunk('IDAT', Buffer.alloc(length, 0xff)),
    image.subarray(offset + 12 + length),
  ]);
  await assert.rejects(validateImage(damaged, pngInfo), rejectsWith(400, 'INVALID_IMAGE'));
});

test('rejects APNG animation even if the image decoder only exposes the first frame', async () => {
  const png = await smallImage('png');
  const animationControl = Buffer.alloc(8);
  animationControl.writeUInt32BE(2);
  const animated = Buffer.concat([png.subarray(0, 33), chunk('acTL', animationControl), png.subarray(33)]);
  await assert.rejects(validateImage(animated, pngInfo), rejectsWith(415, 'ANIMATED_IMAGE'));
});

test('accepts exactly 10 MiB and rejects one byte more before decoding', async () => {
  const png = await smallImage('png');
  const padded = Buffer.concat([
    png.subarray(0, -12), chunk('npAd', Buffer.alloc(10 * 1024 * 1024 - png.length - 12)),
    png.subarray(-12),
  ]);
  assert.equal((await validateImage(padded, pngInfo)).size, 10 * 1024 * 1024);
  await assert.rejects(validateImage(Buffer.alloc(10 * 1024 * 1024 + 1), pngInfo), rejectsWith(413, 'IMAGE_TOO_LARGE'));
  assert.equal(UPLOAD_LIMITS.maxFiles, 10);
  assert.equal(UPLOAD_LIMITS.maxTotalBytes, 50 * 1024 * 1024);
});

test('accepts 40MP but rejects images beyond that limit', async () => {
  assert.equal((await validateImage(monochromePng(8000, 5000), pngInfo)).width, 8000);
  await assert.rejects(validateImage(monochromePng(8001, 5000), pngInfo), rejectsWith(413, 'IMAGE_TOO_MANY_PIXELS'));
});
