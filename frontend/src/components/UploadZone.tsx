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

  const validateAndSelect = useCallback(
    (file: File) => {
      setError(null);
      if (file.size > maxSize) {
        setError(`File exceeds maximum size (${formatSize(maxSize)})`);
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

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      if (disabled) return;
      const file = e.dataTransfer.files[0];
      if (file) validateAndSelect(file);
    },
    [disabled, validateAndSelect]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) validateAndSelect(file);
    },
    [validateAndSelect]
  );

  return (
    <div
      className={`
        relative border-2 border-dashed rounded-lg p-12 text-center cursor-pointer
        transition-all duration-200
        ${isDragOver ? 'border-vault-accent bg-vault-accent/5' : 'border-gray-600 hover:border-gray-400'}
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
      `}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      onClick={() => !disabled && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={handleChange}
        disabled={disabled}
      />

      <div className="space-y-3">
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
        <p className="mt-3 text-red-400 text-sm">{error}</p>
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
