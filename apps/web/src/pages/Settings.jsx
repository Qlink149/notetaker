import { useEffect, useState } from "react";
import { Check, Loader2, LogOut, Plus, Trash2 } from "lucide-react";
import { api } from "@/api/client";
import { useAuth } from "@/lib/AuthContext";
import { LANGUAGES } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const KINDS = ["company", "person", "competitor", "product", "place", "other"];

function Section({ title, description, children }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-4 space-y-3">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function SaveButton({ busy, saved, onClick, disabled }) {
  return (
    <Button size="sm" onClick={onClick} disabled={busy || disabled} className="rounded-full">
      {busy ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : saved ? <Check className="w-4 h-4 mr-1" /> : null}
      {saved ? "Saved" : "Save"}
    </Button>
  );
}

export default function Settings() {
  const { workspace, logout, replaceToken } = useAuth();
  const [settings, setSettings] = useState(null);
  const [entries, setEntries] = useState(null);
  const [busy, setBusy] = useState("");
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [newCode, setNewCode] = useState("");

  useEffect(() => {
    api.workspace.settings().then(setSettings).catch((e) => setError(e.message));
    api.glossary.get().then((list) => setEntries(list.map((e) => ({ ...e, aliasText: e.aliases.join(", ") })))).catch((e) => setError(e.message));
  }, []);

  const act = async (key, fn) => {
    setBusy(key);
    setError("");
    setSaved("");
    try {
      await fn();
      setSaved(key);
      setTimeout(() => setSaved((s) => (s === key ? "" : s)), 2000);
    } catch (e) {
      setError(e?.message || "Could not save.");
    } finally {
      setBusy("");
    }
  };

  const saveSettings = () => act("settings", async () => setSettings(await api.workspace.saveSettings(settings)));

  const saveGlossary = () =>
    act("glossary", async () => {
      const clean = entries
        .filter((e) => e.term.trim())
        .map((e) => ({
          term: e.term.trim(),
          kind: e.kind,
          aliases: e.aliasText.split(",").map((a) => a.trim()).filter(Boolean),
          ...(e.note?.trim() ? { note: e.note.trim() } : {}),
        }));
      const savedList = await api.glossary.put(clean);
      setEntries(savedList.map((e) => ({ ...e, aliasText: e.aliases.join(", ") })));
    });

  const rotate = () =>
    act("code", async () => {
      const { token } = await api.workspace.rotateAccessCode(newCode.trim());
      replaceToken(token);
      setNewCode("");
    });

  const updateEntry = (i, patch) => setEntries((list) => list.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const toggleLanguage = (code) =>
    setSettings((s) => ({
      ...s,
      languages: s.languages.includes(code) ? s.languages.filter((l) => l !== code) : [...s.languages, code],
    }));

  if (!settings || !entries) {
    return (
      <div className="flex justify-center py-20">
        {error ? <p className="text-sm text-destructive">{error}</p> : <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">Workspace: {workspace?.name}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={logout}>
          <LogOut className="w-4 h-4 mr-1" /> Sign out
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Section title="Transcription" description="Defaults for new meetings. Each meeting can override languages and engine.">
        <div>
          <p className="text-sm font-medium mb-2">Languages</p>
          <div className="flex flex-wrap gap-2">
            {LANGUAGES.map((l) => (
              <button
                key={l.code}
                type="button"
                aria-pressed={settings.languages.includes(l.code)}
                onClick={() => toggleLanguage(l.code)}
                className={`px-3 py-1.5 rounded-full text-sm ${
                  settings.languages.includes(l.code) ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="font-medium block mb-1">Default engine</span>
            <select
              value={settings.engine}
              onChange={(e) => setSettings({ ...settings, engine: e.target.value })}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="gemini">Gemini</option>
              <option value="deepgram">Deepgram</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="font-medium block mb-1">Default script</span>
            <select
              value={settings.scriptPreference}
              onChange={(e) => setSettings({ ...settings, scriptPreference: e.target.value })}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="roman">Roman (Latin)</option>
              <option value="native">Native (Devanagari / Gujarati)</option>
            </select>
          </label>
        </div>
        <SaveButton busy={busy === "settings"} saved={saved === "settings"} onClick={saveSettings} disabled={!settings.languages.length} />
      </Section>

      <Section
        title="Glossary"
        description="Names and terms spelled exactly like this in transcripts and summaries. Aliases are other ways people say or write them."
      >
        <div className="space-y-3">
          {entries.map((e, i) => (
            <div key={i} className="rounded-xl border border-border p-3 space-y-2">
              <div className="flex gap-2">
                <Input value={e.term} placeholder="Term" aria-label="Term" onChange={(ev) => updateEntry(i, { term: ev.target.value })} />
                <select
                  value={e.kind}
                  aria-label="Kind"
                  onChange={(ev) => updateEntry(i, { kind: ev.target.value })}
                  className="rounded-md border border-input bg-background px-2 text-sm"
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
                <Button size="icon" variant="ghost" aria-label="Remove term" onClick={() => setEntries((list) => list.filter((_, j) => j !== i))}>
                  <Trash2 className="w-4 h-4 text-muted-foreground" />
                </Button>
              </div>
              <Input
                value={e.aliasText}
                placeholder="Aliases, comma-separated"
                aria-label="Aliases"
                onChange={(ev) => updateEntry(i, { aliasText: ev.target.value })}
              />
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="rounded-full" onClick={() => setEntries((list) => [...list, { term: "", kind: "person", aliases: [], aliasText: "" }])}>
            <Plus className="w-4 h-4 mr-1" /> Add term
          </Button>
          <SaveButton busy={busy === "glossary"} saved={saved === "glossary"} onClick={saveGlossary} />
        </div>
      </Section>

      <Section title="Access code" description="Changing it signs out every other device.">
        <div className="flex gap-2">
          <Input type="password" value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="New access code (8+ characters)" aria-label="New access code" />
          <SaveButton busy={busy === "code"} saved={saved === "code"} onClick={rotate} disabled={newCode.trim().length < 8} />
        </div>
      </Section>
    </div>
  );
}
