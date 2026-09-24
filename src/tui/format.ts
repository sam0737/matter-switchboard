export function pretty(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function formatNumber(value: number | null, unit: string): string {
  if (value === null) return "—";
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${unit}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
