# Phase 2 report: speaker identity (in progress)

## Stage A: pyannote as the time and speaker base

Inputs:
- Each meeting's original recording, converted to 16 kHz mono FLAC with Phase 1's `toAnalysisFlac`.
- Uploaded through pyannote media storage (`media://p2-<meetingId>.flac`; DECISIONS #26).

Requests:
- Diarize with `exclusive: true` and `turnLevelConfidence: true`.
- `confidence: true` on precision-2 only.
- Speaker count left to the model.

Output:
- Raw output is in `p2_pyannote_responses` under tag `stageA`.
- Each job finished in 26–70 s.

Spend: 0 Gemini calls, and 8 pyannote jobs (4 meetings × 2 models, about 5.0 h of audio in total).

How to read the table:
- Turn confidence is capped at 90 by pyannote, so the last column gives the share of speech whose own-speaker confidence is below 60, not a median.
- "Overlap" is the share of speech time with two or more speakers active.

| Meeting | Model | pyannote speakers | Phase 1 Gemini speakers | Speech s | Overlap | Segments | Exclusive segs | Median seg s | P90 seg s | Speech with turn conf < 60 |
|---|---|---|---|---|---|---|---|---|---|---|
| 200 | precision-2 | 4 | 11 | 1565.6 | 10.7% | 784 | 709 | 1.04 | 5.46 | 2.8% |
| 200 | precision-3 | 4 | 11 | 1580.1 | 11.0% | 785 | 752 | 1.1 | 5.78 | 3.0% |
| 21-9 | precision-2 | 5 | 11 | 2036.3 | 10.8% | 1348 | 1176 | 1.12 | 4.04 | 0.9% |
| 21-9 | precision-3 | 5 | 11 | 2078.9 | 14.0% | 1700 | 1472 | 0.82 | 3.44 | 3.2% |
| AOM | precision-2 | 7 | 18 | 1626.9 | 1.2% | 444 | 427 | 2.26 | 8.72 | 0.8% |
| AOM | precision-3 | 7 | 18 | 1571.3 | 1.1% | 600 | 583 | 1.86 | 5.4 | 1.1% |
| Prachar | precision-2 | 7 | pending | 1938.7 | 14.9% | 1053 | 875 | 0.86 | 4.98 | 1.8% |
| Prachar | precision-3 | 6 | pending | 1934 | 15.2% | 1235 | 1033 | 0.78 | 4.54 | 3.9% |

#### 200 (200 (acceptance)) — precision-2
Speaker time: SPEAKER_02 923.2s, SPEAKER_03 508.9s, SPEAKER_01 173s, SPEAKER_00 128.4s
```
[00:00–00:04] SPEAKER_03
[00:04–00:08] SPEAKER_03
[00:08–00:08] SPEAKER_02
[00:08–00:14] SPEAKER_03
[00:14–00:22] SPEAKER_02
[00:24–00:29] SPEAKER_01
[00:30–00:35] SPEAKER_01
[00:35–00:38] SPEAKER_01
[00:38–00:44] SPEAKER_01
[00:44–00:50] SPEAKER_03
[00:50–00:50] SPEAKER_02
[00:50–01:08] SPEAKER_03
```
#### 200 (200 (acceptance)) — precision-3
Speaker time: SPEAKER_02 930.2s, SPEAKER_03 537.8s, SPEAKER_01 167.5s, SPEAKER_00 129s
```
[00:00–00:01] SPEAKER_03
[00:01–00:03] SPEAKER_02
[00:04–00:13] SPEAKER_03
[00:13–00:15] SPEAKER_02
[00:15–00:15] SPEAKER_03
[00:15–00:15] SPEAKER_02
[00:15–00:15] SPEAKER_03
[00:15–00:15] SPEAKER_00
[00:15–00:15] SPEAKER_03
[00:15–00:22] SPEAKER_02
[00:24–00:24] SPEAKER_01
[00:24–00:29] SPEAKER_01
```
#### 21-9 (Meeting-21-9-2026 (acceptance, ts fix)) — precision-2
Speaker time: SPEAKER_00 780s, SPEAKER_01 608.1s, SPEAKER_04 422.2s, SPEAKER_03 333.6s, SPEAKER_02 112.4s
```
[00:00–00:02] SPEAKER_00
[00:03–00:05] SPEAKER_01
[00:05–00:05] SPEAKER_04
[00:05–00:08] SPEAKER_01
[00:09–00:17] SPEAKER_01
[00:18–00:21] SPEAKER_01
[00:21–00:22] SPEAKER_04
[00:22–00:26] SPEAKER_01
[00:26–00:28] SPEAKER_01
[00:28–00:34] SPEAKER_01
[00:34–00:37] SPEAKER_01
[00:38–00:41] SPEAKER_01
```
#### 21-9 (Meeting-21-9-2026 (acceptance, ts fix)) — precision-3
Speaker time: SPEAKER_00 827.2s, SPEAKER_01 613.6s, SPEAKER_02 433.3s, SPEAKER_03 349.4s, SPEAKER_04 155.2s
```
[00:00–00:02] SPEAKER_01
[00:03–00:05] SPEAKER_01
[00:05–00:05] SPEAKER_02
[00:05–00:05] SPEAKER_03
[00:05–00:08] SPEAKER_01
[00:09–00:17] SPEAKER_01
[00:17–00:21] SPEAKER_01
[00:21–00:22] SPEAKER_02
[00:22–00:28] SPEAKER_01
[00:28–00:34] SPEAKER_01
[00:34–00:37] SPEAKER_01
[00:38–00:41] SPEAKER_01
```
#### AOM (AOM Meeting part 1 (acceptance)) — precision-2
Speaker time: SPEAKER_05 828.3s, SPEAKER_04 291.6s, SPEAKER_00 235.9s, SPEAKER_03 164.9s, SPEAKER_01 54.7s, SPEAKER_02 47.8s, SPEAKER_06 22.8s
```
[00:00–00:01] SPEAKER_04
[00:01–00:05] SPEAKER_04
[00:05–00:06] SPEAKER_04
[00:07–00:08] SPEAKER_04
[00:09–00:10] SPEAKER_04
[00:12–00:14] SPEAKER_04
[00:14–00:16] SPEAKER_04
[00:17–00:18] SPEAKER_04
[00:21–00:23] SPEAKER_04
[00:24–00:24] SPEAKER_00
[00:25–00:29] SPEAKER_04
[00:31–00:31] SPEAKER_04
```
#### AOM (AOM Meeting part 1 (acceptance)) — precision-3
Speaker time: SPEAKER_01 786.4s, SPEAKER_00 234.4s, SPEAKER_06 210.7s, SPEAKER_04 147s, SPEAKER_05 111s, SPEAKER_02 54.5s, SPEAKER_03 43.9s
```
[00:00–00:00] SPEAKER_06
[00:01–00:05] SPEAKER_06
[00:05–00:06] SPEAKER_06
[00:07–00:08] SPEAKER_06
[00:09–00:10] SPEAKER_06
[00:12–00:14] SPEAKER_06
[00:14–00:15] SPEAKER_06
[00:16–00:16] SPEAKER_06
[00:17–00:18] SPEAKER_06
[00:21–00:21] SPEAKER_06
[00:21–00:21] SPEAKER_00
[00:21–00:23] SPEAKER_06
```
#### Prachar (Prachar (acceptance)) — precision-2
Speaker time: SPEAKER_02 1288.4s, SPEAKER_01 291.4s, SPEAKER_05 257.7s, SPEAKER_03 209.8s, SPEAKER_04 69.9s, SPEAKER_06 55.1s, SPEAKER_00 55s
```
[00:05–00:07] SPEAKER_05
[00:10–00:31] SPEAKER_01
[00:31–00:35] SPEAKER_02
[00:35–00:38] SPEAKER_01
[00:42–00:50] SPEAKER_01
[00:50–00:52] SPEAKER_02
[00:52–00:52] SPEAKER_05
[00:52–00:53] SPEAKER_02
[00:53–01:00] SPEAKER_05
[01:00–01:00] SPEAKER_02
[01:00–01:03] SPEAKER_05
[01:03–01:04] SPEAKER_05
```
#### Prachar (Prachar (acceptance)) — precision-3
Speaker time: SPEAKER_03 1278.6s, SPEAKER_04 337.6s, SPEAKER_01 298.3s, SPEAKER_02 211.7s, SPEAKER_00 63.2s, SPEAKER_05 58.8s
```
[00:05–00:07] SPEAKER_01
[00:10–00:25] SPEAKER_04
[00:25–00:26] SPEAKER_03
[00:26–00:31] SPEAKER_04
[00:31–00:34] SPEAKER_03
[00:34–00:34] SPEAKER_01
[00:34–00:35] SPEAKER_03
[00:35–00:38] SPEAKER_04
[00:42–00:50] SPEAKER_04
[00:50–00:52] SPEAKER_03
[00:52–00:52] SPEAKER_01
[00:52–00:53] SPEAKER_03
```
