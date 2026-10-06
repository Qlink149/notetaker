import type { Turn } from '@meetingid/shared';

export interface SpeakerResolution {
  /** Global label (`S1`) → display name. */
  speakerMap: Record<string, string>;
  /** Real names identified in the meeting. */
  participants: string[];
  /** Number of speakers left without a real name. */
  unknownCount: number;
}

/**
 * Turns anonymous speaker labels into display names. Phase 1 ships `AnonymousResolver`;
 * Phase 2 adds a voiceprint-based resolver behind the same interface.
 */
export interface SpeakerResolver {
  resolve(input: { turns: Turn[]; analysisUrl: string | null }): Promise<SpeakerResolution>;
}

/** `S1..Sn` → `Speaker 1..n`. Never guesses a real identity. */
export class AnonymousResolver implements SpeakerResolver {
  async resolve({
    turns,
  }: {
    turns: Turn[];
    analysisUrl: string | null;
  }): Promise<SpeakerResolution> {
    const speakerMap: Record<string, string> = {};
    for (const t of turns) {
      if (speakerMap[t.speaker]) continue;
      const n = /^S(\d+)$/.exec(t.speaker)?.[1];
      speakerMap[t.speaker] = `Speaker ${n ?? Object.keys(speakerMap).length + 1}`;
    }
    return { speakerMap, participants: [], unknownCount: Object.keys(speakerMap).length };
  }
}
