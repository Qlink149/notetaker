import { describe, expect, it } from 'vitest';
import { AUDIO_ACCEPT, audioTypeOf, validateAudioFile } from '../src/lib/cloudinaryUpload';

const file = (name, type = '', size = 4096) => new File(['x'.repeat(size)], name, { type });

describe('audio file types from an iPhone', () => {
  it('trusts an audio or video type from the browser', () => {
    expect(audioTypeOf(file('a.m4a', 'audio/x-m4a'))).toBe('audio/x-m4a');
    expect(audioTypeOf(file('a.mov', 'video/quicktime'))).toBe('video/quicktime');
  });

  it('falls back to the extension when Safari gives an empty type', () => {
    expect(audioTypeOf(file('Recording.M4A'))).toBe('audio/mp4');
    expect(audioTypeOf(file('WhatsApp Audio.opus'))).toBe('audio/ogg');
    expect(validateAudioFile(file('Recording.m4a'))).toBeNull();
  });

  it('rejects other files with a message naming the file', () => {
    expect(audioTypeOf(file('notes.pdf', 'application/pdf'))).toBeNull();
    expect(validateAudioFile(file('notes.pdf', 'application/pdf'))).toMatch(/notes\.pdf/);
  });

  it('lets the picker offer audio by extension as well', () => {
    expect(AUDIO_ACCEPT).toContain('audio/*');
    expect(AUDIO_ACCEPT).toContain('.m4a');
    expect(AUDIO_ACCEPT).toContain('.opus');
  });
});
