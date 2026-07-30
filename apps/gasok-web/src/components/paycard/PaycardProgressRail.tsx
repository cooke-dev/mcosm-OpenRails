type PaycardProgressRailProps = {
  progress: number;
  state: string;
};

export function PaycardProgressRail({
  progress,
  state,
}: PaycardProgressRailProps) {
  const bounded = Math.min(100, Math.max(0, progress));

  return (
    <div
      className="paycard-progress"
      aria-label={`${state}: ${bounded.toFixed(0)} percent accrued`}
    >
      <div className="paycard-progress-track">
        <span style={{ width: `${bounded}%` }} />
        <i style={{ left: `${bounded}%` }} />
      </div>

      <div className="paycard-progress-labels">
        <span>0</span>
        <strong>{bounded.toFixed(0)}% ACCRUED</strong>
        <span>100%</span>
      </div>
    </div>
  );
}
