import { describe, expect, it } from 'vitest';
import { looksRepetitive } from '../src/repetition.js';
import { sentences } from './helpers.js';

describe('looksRepetitive', () => {
  it('flags a looped phrase', () => {
    const loop = Array.from({ length: 30 }, () => 'to aapko ye karna hai').join(' ');
    expect(looksRepetitive(`shuru mein baat hui ${loop}`)).toBe(true);
  });

  it('flags a phrase looped across many lines', () => {
    const lines = Array.from({ length: 12 }, () => 'Speaker 1: haan ji bilkul sahi baat hai.').join(
      '\n',
    );
    expect(looksRepetitive(lines)).toBe(true);
  });

  it('does not flag normal fillers like "haan haan haan"', () => {
    const text = `haan haan haan ${sentences.join(' ')} haan haan ji ji ji theek hai theek hai`;
    expect(looksRepetitive(text)).toBe(false);
  });

  it('does not flag ordinary varied speech', () => {
    expect(looksRepetitive(sentences.join('. '))).toBe(false);
  });

  it('does not flag short texts', () => {
    expect(looksRepetitive('no no no no no')).toBe(false);
  });

  it('flags a long output made of a few recycled phrases', () => {
    const phrases = ['ek do teen chaar', 'paanch chhe saat aath'];
    const text = Array.from({ length: 120 }, (_, i) => phrases[(i * 7) % 2]).join(' ');
    expect(looksRepetitive(text)).toBe(true);
  });
});
