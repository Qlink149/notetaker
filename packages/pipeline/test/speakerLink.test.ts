import { describe, expect, it } from 'vitest';
import { linkSpeakersAcrossChunks } from '../src/speakerLink.js';
import { assembleChunks } from '../src/assemble.js';
import { sentences as s, turn } from './helpers.js';

const overlap = { start: 570, end: 600 };

describe('linkSpeakersAcrossChunks', () => {
  it('links labels even when the engine swapped them between chunks', () => {
    // earlier: G1 talks first, G2 second. Later chunk calls the same voices S2 then S1.
    const prev = [
      turn('G1', 571, 577, s[0]!),
      turn('G2', 578, 584, s[1]!),
      turn('G1', 585, 591, s[2]!),
      turn('G2', 592, 598, s[3]!),
    ];
    const next = [
      turn('S2', 571, 577, s[0]!),
      turn('S1', 578, 584, s[1]!),
      turn('S2', 585, 591, s[2]!),
      turn('S1', 592, 598, s[3]!),
      turn('S1', 610, 620, s[4]!),
    ];
    expect(linkSpeakersAcrossChunks(prev, next, overlap)).toEqual({ S2: 'G1', S1: 'G2' });
  });

  it('leaves a speaker absent from the overlap unmatched', () => {
    const prev = [turn('G1', 572, 580, s[0]!), turn('G2', 582, 590, s[1]!)];
    const next = [
      turn('S1', 572, 580, s[0]!),
      turn('S2', 582, 590, s[1]!),
      turn('S3', 640, 650, s[5]!), // new voice, only after the overlap
    ];
    expect(linkSpeakersAcrossChunks(prev, next, overlap)).toEqual({ S1: 'G1', S2: 'G2', S3: null });
  });

  it('tolerates a 6-second timestamp drift', () => {
    const prev = [turn('G1', 572, 578, s[6]!), turn('G2', 580, 586, s[7]!)];
    const next = [turn('S1', 578, 584, s[6]!), turn('S2', 586, 592, s[7]!)];
    expect(linkSpeakersAcrossChunks(prev, next, overlap)).toEqual({ S1: 'G1', S2: 'G2' });
  });

  it('refuses an ambiguous match without a 1.5x margin', () => {
    // S1's overlap speech matches G1 and G2 equally
    const prev = [turn('G1', 572, 576, s[8]!), turn('G2', 580, 584, s[9]!)];
    const next = [turn('S1', 572, 576, s[8]!), turn('S1', 580, 584, s[9]!)];
    expect(linkSpeakersAcrossChunks(prev, next, overlap)).toEqual({ S1: null });
  });

  it('ignores short fillers that do not match strongly', () => {
    const prev = [turn('G1', 575, 576, 'haan ji')];
    const next = [turn('S1', 575, 576, 'theek hai')];
    expect(linkSpeakersAcrossChunks(prev, next, overlap)).toEqual({ S1: null });
  });
});

describe('assembleChunks', () => {
  it('stitches three chunks into global labels by first appearance', () => {
    const c0 = {
      startSec: 0,
      endSec: 600,
      turns: [turn('S1', 10, 20, s[0]!), turn('S2', 575, 582, s[1]!), turn('S1', 586, 596, s[2]!)],
    };
    const c1 = {
      startSec: 570,
      endSec: 1170,
      turns: [
        turn('S1', 576, 583, s[1]!), // = c0 S2
        turn('S2', 587, 597, s[2]!), // = c0 S1
        turn('S3', 700, 710, s[3]!), // new
        turn('S1', 1145, 1150, s[4]!),
      ],
    };
    const c2 = {
      startSec: 1140,
      endSec: 1500,
      turns: [turn('S1', 1146, 1151, s[4]!), turn('S1', 1200, 1210, s[5]!)],
    };
    const { turns, speakerCount } = assembleChunks([c2, c0, c1]);
    expect(turns.map((t) => [t.speaker, t.textRoman])).toEqual([
      ['S1', s[0]],
      ['S2', s[1]],
      ['S1', s[2]],
      ['S3', s[3]],
      ['S2', s[4]],
      ['S2', s[5]],
    ]);
    expect(speakerCount).toBe(3);
  });

  it('gives fresh labels across a gap left by a failed chunk', () => {
    const { turns } = assembleChunks([
      { startSec: 0, endSec: 600, turns: [turn('S1', 10, 20, s[0]!)] },
      { startSec: 1140, endSec: 1740, turns: [turn('S1', 1150, 1160, s[1]!)] },
    ]);
    expect(turns.map((t) => t.speaker)).toEqual(['S1', 'S2']);
  });
});

describe('linking with live-run shapes', () => {
  it('links a short later turn contained in a long earlier turn, 10.5 s apart', () => {
    // From Meeting-21-9-2026: the earlier chunk merged speech into one 25 s turn near its end.
    const overlap = { start: 1140, end: 1170 };
    const prev = [
      turn(
        'G1',
        1117.8,
        1145,
        'matlab hamari baaki bhi saari effort hai itne mahine ki effort hai',
      ),
      turn(
        'G3',
        1145,
        1170,
        'parag bhai hum usko is trah kar sakte hain ki hamare paas jitne jo store hain jo is month',
      ),
    ];
    const next = [
      turn(
        'S5',
        1155.5,
        1169.8,
        'Parag bhai, hum isko is tarah kar sakte hain ki humare paas jitne jo store hain, jo is month',
      ),
    ];
    expect(linkSpeakersAcrossChunks(prev, next, overlap)).toEqual({ S5: 'G3' });
  });

  it('does not link fillers by containment', () => {
    const overlap = { start: 570, end: 600 };
    const prev = [turn('G1', 575, 590, 'haan ji bilkul theek hai aage chalte hain report pe')];
    const next = [turn('S1', 580, 581, 'haan ji')];
    expect(linkSpeakersAcrossChunks(prev, next, overlap)).toEqual({ S1: null });
  });
});

describe('spelling-tolerant matching', () => {
  it('treats different romanisations of the same words as the same', async () => {
    const { skeleton, jaccard } = await import('../src/text.js');
    expect(skeleton('kaaynaat')).toBe(skeleton('kayanaat'));
    expect(skeleton('vahaan')).toBe(skeleton('vahan'));
    expect(jaccard('saari kaaynaat ban jaati hai', 'sari kayanaat ban jaati hai')).toBe(1);
  });

  it('links AOM-style overlaps that differ only in spelling', () => {
    const overlap = { start: 570, end: 600 };
    const prev = [
      turn(
        'G2',
        578.2,
        600,
        'sari kayanaat ban jaati hai. Vahan se andar se marshal aa gaya koi aur bacha diya',
      ),
    ];
    const next = [
      turn('S1', 570, 571.3, 'saari kaaynaat ban jaati hai'),
      turn('S1', 572.1, 575.1, 'vahaan se andar se maseeha aa gaya koee.'),
    ];
    expect(linkSpeakersAcrossChunks(prev, next, overlap)).toEqual({ S1: 'G2' });
  });
});
