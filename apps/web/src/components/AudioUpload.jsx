import { Upload } from 'lucide-react';

/**
 * The only way to add audio while live recording is not offered: pick a recording from the device. Voice Memos
 * (.m4a), .mp3, .wav, .webm and video files with sound are all accepted.
 */
export default function AudioUpload({ onComplete }) {
  const onFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) onComplete(file);
  };

  return (
    <div className="space-y-3">
      <label className="w-full block">
        <input type="file" accept="audio/*,video/*" className="hidden" onChange={onFileChange} />
        <span className="flex items-center justify-center h-14 w-full rounded-full border border-input bg-secondary text-secondary-foreground cursor-pointer text-base">
          <Upload className="w-5 h-5 mr-2" /> Upload audio file
        </span>
      </label>
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
