type PaycardReceiptProps = {
  label: string;
  status: string;
  hash?: string;
  blockNumber?: number;
  href?: string;
};

function short(value?: string) {
  return value
    ? `${value.slice(0, 10)}…${value.slice(-8)}`
    : '—';
}

export function PaycardReceipt({
  label,
  status,
  hash,
  blockNumber,
  href,
}: PaycardReceiptProps) {
  const className = status
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');

  return (
    <article className={`paycard-receipt is-${className}`}>
      <span>{label}</span>
      <strong>{status}</strong>

      {hash && href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {short(hash)} ↗
        </a>
      ) : (
        <code>{short(hash)}</code>
      )}

      <small>
        {blockNumber
          ? `BLOCK ${blockNumber.toLocaleString()}`
          : 'CANONICAL EVIDENCE'}
      </small>
    </article>
  );
}
