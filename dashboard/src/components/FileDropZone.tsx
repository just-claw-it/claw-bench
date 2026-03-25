import { useState, useCallback } from "react";

interface Props {
  onFilesAccepted: (reports: unknown[]) => void;
}

export default function FileDropZone({ onFilesAccepted }: Props) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      setError(null);

      const files = Array.from(e.dataTransfer.files).filter((f) =>
        f.name.endsWith(".json")
      );
      if (files.length === 0) {
        setError("No .json files found. Drop benchmark-report.json files.");
        return;
      }

      try {
        const reports = await Promise.all(
          files.map(async (f) => {
            const text = await f.text();
            return JSON.parse(text);
          })
        );
        onFilesAccepted(reports);
      } catch {
        setError("Failed to parse one or more files. Ensure they are valid JSON.");
      }
    },
    [onFilesAccepted]
  );

  const handleFileInput = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      setError(null);
      const files = Array.from(e.target.files ?? []);
      if (files.length === 0) return;
      try {
        const reports = await Promise.all(
          files.map(async (f) => {
            const text = await f.text();
            return JSON.parse(text);
          })
        );
        onFilesAccepted(reports);
      } catch {
        setError("Failed to parse. Ensure files are valid JSON.");
      }
    },
    [onFilesAccepted]
  );

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-xl p-12 text-center transition-colors ${
          isDragging
            ? "border-blue-500 bg-blue-50 dark:bg-blue-900/10"
            : "border-slate-300 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-600"
        }`}
      >
        <p className="text-lg font-medium text-slate-600 dark:text-slate-300">
          Drop benchmark-report.json files here
        </p>
        <p className="text-sm text-slate-400 mt-2">
          or{" "}
          <label className="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer">
            browse files
            <input
              type="file"
              accept=".json"
              multiple
              onChange={handleFileInput}
              className="hidden"
            />
          </label>
        </p>
      </div>
      {error && (
        <p className="mt-3 text-sm text-red-500">{error}</p>
      )}
    </div>
  );
}
