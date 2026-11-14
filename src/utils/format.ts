const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const inrCompactFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function formatInr(value: number, compact = false): string {
  if (!Number.isFinite(value)) return '₹0.00';
  if (compact && Math.abs(value) > 0 && Math.abs(value) < 100) {
    return inrFormatter.format(value);
  }
  return compact ? inrCompactFormatter.format(value) : inrFormatter.format(value);
}

export function formatSignedInr(value: number): string {
  if (!Number.isFinite(value)) return '₹0.00';
  const absFormatted = inrFormatter.format(Math.abs(value));
  if (value > 0) return `+${absFormatted}`;
  if (value < 0) return `-${absFormatted}`;
  return absFormatted;
}

export function formatSignedPct(value: number): string {
  if (!Number.isFinite(value)) return '0.00%';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(2)}%`;
}

export function formatTimeShort(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso.slice(11, 19);
  }
}
