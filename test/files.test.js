'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { sniffImageType, cleanFileName } = require('../src/lib/files');

const pad = bytes => Buffer.concat([Buffer.from(bytes), Buffer.alloc(16)]);

test('recognises real images by their first bytes', () => {
  assert.strictEqual(sniffImageType(pad([0x89, 0x50, 0x4e, 0x47])), 'image/png');
  assert.strictEqual(sniffImageType(pad([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.strictEqual(sniffImageType(Buffer.from('GIF89a......')), 'image/gif');
  assert.strictEqual(sniffImageType(Buffer.from('RIFF....WEBPVP8 ')), 'image/webp');
});

test('does not treat text, markup or tiny files as images', () => {
  assert.strictEqual(sniffImageType(Buffer.from('just some plain text here')), null);
  assert.strictEqual(sniffImageType(Buffer.from('<?xml version="1.0"?><root/>')), null);
  assert.strictEqual(sniffImageType(Buffer.from([0x89, 0x50])), null);
  assert.strictEqual(sniffImageType('not a buffer'), null);
});

test('file names lose path separators and control characters', () => {
  assert.strictEqual(cleanFileName('a/b\\c.txt'), 'a_b_c.txt');
  assert.strictEqual(cleanFileName('a\r\nb.txt'), 'a__b.txt');
  assert.strictEqual(cleanFileName(''), 'file');
  assert.strictEqual(cleanFileName('x'.repeat(500)).length, 120);
});
