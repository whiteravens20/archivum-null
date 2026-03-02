interface ProgressBarProps {
  progress: number; // 0 to 1
  label?: string;
}

export default function ProgressBar({ progress, label }: ProgressBarProps) {
  const pct = Math.min(100, Math.max(0, progress * 100));

  return (
    <div className="space-y-1">
      {label && (
        <div className="flex justify-between text-xs text-gray-400">
          <span>{label}</span>
          <span>{pct.toFixed(0)}%</span>
        </div>
      )}
      <div className="w-full h-1.5 bg-vault-secondary rounded-full overflow-hidden">
        <div
          className="h-full bg-vault-accent rounded-full transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
