import { useState, useCallback, useRef } from 'react';
import { formatBytes } from '../format.ts';
import { useI18n } from '../i18n/i18n.ts';

interface UploadZoneProps {
  onFileSelect: (file: File) => void;
  maxSize: number;
  disabled?: boolean;
}

export default function UploadZone({ onFileSelect, maxSize, disabled }: UploadZoneProps) {
  const { t, locale } = useI18n();
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<'uploadZone.tooLarge' | 'uploadZone.empty' | 'uploadZone.unreadable' | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Counter-based drag tracking: avoids false dragleave when cursor crosses child elements.
  // Every dragenter increments, every dragleave decrements — isDragOver only clears at 0.
  const dragCounter = useRef(0);

  const validateAndSelect = useCallback(
    (file: File) => {
      setError(null);
      if (file.size > maxSize) {
        setError('uploadZone.tooLarge');
        return;
      }
      if (file.size === 0) {
        setError('uploadZone.empty');
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
            () => setError('uploadZone.unreadable'),
          );
          return;
        }
      }

      setError('uploadZone.unreadable');
    },
    [disabled, validateAndSelect]
  );

  return (
    <div
      className={`
        relative border-2 border-dashed rounded-lg p-12 text-center cursor-pointer
        transition-all duration-200
        ${isDragOver ? 'border-vault-accent-ink bg-vault-accent/5' : 'border-vault-line hover:border-vault-line-strong'}
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
        <p className="text-vault-text-soft">
          {isDragOver ? t('uploadZone.dropHere') : t('uploadZone.prompt')}
        </p>
        <p className="text-xs text-vault-subtle">
          {t('uploadZone.hint', { size: formatBytes(maxSize, locale) })}
        </p>
      </div>

      {error && (
        <p className="mt-3 text-vault-danger text-sm pointer-events-none">
          {t(error, { size: formatBytes(maxSize, locale) })}
        </p>
      )}
    </div>
  );
}
