import { useState, useCallback, useRef } from 'react';

interface UploadZoneProps {
  onFileSelect: (file: File) => void;
  maxSize: number;
  disabled?: boolean;
}

export default function UploadZone({ onFileSelect, maxSize, disabled }: UploadZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Counter-based drag tracking: avoids false dragleave when cursor crosses child elements.
  // Every dragenter increments, every dragleave decrements — isDragOver only clears at 0.
  const dragCounter = useRef(0);

  const validateAndSelect = useCallback(
    (file: File) => {
      setError(null);
      if (file.size > maxSize) {
        setError(`File too large — maximum allowed size is ${formatSize(maxSize)}`);
        return;
      }
      if (file.size === 0) {
        setError('File is empty');
        return;
      }
      onFileSelect(file);
    },
    [maxSize, onFileSelect]
  );

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (disabled) return;
      dragCounter.current += 1;
      if (dragCounter.current === 1) setIsDragOver(true);
    },
    [disabled]
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current -= 1;
      if (dragCounter.current === 0) setIsDragOver(false);
    },
    []
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault(); // required for drop to fire
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setIsDragOver(false);
      if (disabled) return;

      // 1. Fast path: synchronous access (X11, Windows, macOS, Chrome/Firefox)
      const syncFile: File | null =
        e.dataTransfer.files[0] ??
        (e.dataTransfer.items[0]?.kind === 'file'
          ? e.dataTransfer.items[0].getAsFile()
          : null);

      if (syncFile) {
        validateAndSelect(syncFile);
        return;
      }

      // 2. Async fallback: Wayland / xdg-desktop-portal DnD delivers files
      //    only through FileSystemEntry.file() — getAsFile() returns null there.
      const item = e.dataTransfer.items?.[0];
      if (item?.kind === 'file') {
        const entry = item.webkitGetAsEntry?.();
        if (entry?.isFile) {
          (entry as FileSystemFileEntry).file(
            (f) => validateAndSelect(f),
            () => setError('Could not read the dropped file — try using the file picker instead'),
          );
          return;
        }
      }

      setError('Could not read the dropped file — try using the file picker instead');
    },
    [disabled, validateAndSelect]
  );

  return (
    <div
      className={`
        relative border-2 border-dashed rounded-lg p-12 text-center cursor-pointer
        transition-all duration-200
        ${isDragOver ? 'border-vault-accent bg-vault-accent/5' : 'border-gray-600 hover:border-gray-400'}
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
      `}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={() => !disabled && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) validateAndSelect(file);
          // Reset so the same file can be re-selected after an error
          e.target.value = '';
        }}
        disabled={disabled}
      />

      {/* pointer-events-none: all drag/click events go to the outer div only */}
      <div className="space-y-3 pointer-events-none">
        <div className="text-4xl opacity-40">
          {isDragOver ? '↓' : '◈'}
        </div>
        <p className="text-gray-300">
          {isDragOver ? 'Drop file here' : 'Drop file or click to select'}
        </p>
        <p className="text-xs text-gray-500">
          Max size: {formatSize(maxSize)} · Encrypted client-side before upload
        </p>
      </div>

      {error && (
        <p className="mt-3 text-red-400 text-sm pointer-events-none">{error}</p>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}
