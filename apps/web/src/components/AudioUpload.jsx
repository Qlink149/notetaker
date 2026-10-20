import { Upload } from 'lucide-react';
import { AUDIO_ACCEPT } from '@/lib/cloudinaryUpload';

/**
 * The only way to add audio while live recording is not offered: pick a recording from the device. Voice Memos
 * (.m4a), .mp3, .wav, .webm, WhatsApp audio (.opus) and video files with sound are all accepted. Several files
 * of one meeting (recorded in batches) can be picked at once: `onFiles` receives them all; without it only the
 * first goes to `onComplete`.
 */
export default function AudioUpload({ onComplete, onFiles }) {
  const onFileChange = (e) => {
    const files = Array.from(e.target.files ?? []);
    // the same file can be chosen again after an error
    e.target.value = '';
    if (!files.length) return;
    if (onFiles) onFiles(files);
    else onComplete(files[0]);
  };

  return (
    <div className="space-y-3">
      <label className="w-full block">
        <input
          type="file"
          accept={AUDIO_ACCEPT}
          multiple={Boolean(onFiles)}
          className="hidden"
          onChange={onFileChange}
        />
        <span className="flex items-center justify-center h-14 w-full rounded-full border border-input bg-secondary text-secondary-foreground cursor-pointer text-base">
          <Upload className="w-5 h-5 mr-2" /> Upload audio file
        </span>
      </label>
      {onFiles && (
        <p className="text-xs text-muted-foreground" data-testid="parts-hint">
          Recorded one meeting in two or three files? Pick them together; they are joined into one
          meeting with one summary.
        </p>
      )}
      <div className="text-xs text-muted-foreground" data-testid="iphone-upload-hint">
        <p>On an iPhone, from Voice Memos:</p>
        <ol className="list-decimal pl-5 mt-1 space-y-0.5">
          <li>Tap the recording, then the ··· (or Share) button.</li>
          <li>Choose "Save to Files" and save it (for example in "On My iPhone").</li>
          <li>Here, tap "Upload audio file", then "Choose Files", and pick it from Recents.</li>
        </ol>
      </div>
      <p
        className="text-xs rounded-lg bg-secondary border border-border p-2.5 text-muted-foreground"
        data-testid="recording-prototype-note"
      >
        Live recording from the dashboard is in the prototype stage for now. Record the meeting with
        your phone's voice recorder and upload the file here.
      </p>
    </div>
  );
}
