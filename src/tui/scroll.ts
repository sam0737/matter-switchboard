const HINT_BLOCK_ROWS = 2;
// A frame as tall as the terminal scrolls the alternate screen and hides the first row.
const TERMINAL_SLACK_ROWS = 1;

export type ScrollMove = "up" | "down" | "pageup" | "pagedown" | "home" | "end";

export interface SliceWindow<T> {
  items: T[];
  offset: number;
  total: number;
  height: number;
  fits: boolean;
}

export function contentWidth(columns: number): number {
  // A line as wide as the terminal wraps, which shifts every row below it.
  return Math.max(1, columns - 1);
}

export function wrapText(text: string, columns: number): string[] {
  const width = Math.max(1, columns);
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      lines.push("");
      continue;
    }
    for (let index = 0; index < line.length; index += width) {
      lines.push(line.slice(index, index + width));
    }
  }
  return lines.length === 0 ? [""] : lines;
}

export function visibleSlice<T>(
  items: readonly T[],
  rows: number,
  chrome: number,
  offset: number,
): SliceWindow<T> {
  const usable = Math.max(1, rows - TERMINAL_SLACK_ROWS);
  const fitHeight = Math.max(1, usable - chrome);
  const fits = items.length <= fitHeight;
  const height = fits ? fitHeight : Math.max(1, usable - chrome - 1);
  const maxOffset = Math.max(0, items.length - height);
  const next = Math.min(Math.max(0, offset), maxOffset);
  return {
    items: items.slice(next, next + height),
    offset: next,
    total: items.length,
    height,
    fits,
  };
}

export function moveScroll(
  current: number,
  move: ScrollMove,
  total: number,
  viewport: number,
): number {
  const height = Math.max(1, viewport);
  const max = Math.max(0, total - height);
  const base = Math.min(Math.max(0, current), max);
  if (move === "home") return 0;
  if (move === "end") return max;
  if (move === "up") return Math.max(0, base - 1);
  if (move === "down") return Math.min(max, base + 1);
  if (move === "pageup") return Math.max(0, base - height);
  return Math.min(max, base + height);
}

export function revealOffset(
  offset: number,
  index: number,
  count: number,
  viewport: number,
): number {
  const height = Math.max(1, viewport);
  const max = Math.max(0, count - height);
  if (count === 0) return 0;
  const clampedIndex = Math.min(Math.max(0, index), count - 1);
  let next = Math.min(Math.max(0, offset), max);
  if (clampedIndex < next) next = clampedIndex;
  if (clampedIndex >= next + height) next = clampedIndex - height + 1;
  return Math.min(max, Math.max(0, next));
}

export interface ResultLayout {
  titleLines: string[];
  lines: string[];
  offset: number;
  total: number;
  height: number;
  fits: boolean;
  status: string;
}

export function layoutResult(input: {
  title: string;
  body: string;
  columns: number;
  rows: number;
  offset: number;
}): ResultLayout {
  const width = contentWidth(input.columns);
  const titleLines = wrapText(input.title, width);
  const bodyLines = wrapText(input.body, width);
  const slice = visibleSlice(
    bodyLines,
    input.rows,
    titleLines.length + HINT_BLOCK_ROWS,
    input.offset,
  );
  return {
    titleLines,
    lines: slice.items,
    offset: slice.offset,
    total: slice.total,
    height: slice.height,
    fits: slice.fits,
    status: slice.fits ? "" : scrollStatus(slice.offset, slice.items.length, slice.total, width),
  };
}

export function rangeStatus(offset: number, shown: number, total: number): string {
  const end = Math.min(total, offset + shown);
  return `${offset + 1}-${end} / ${total}`;
}

export function scrollStatus(
  offset: number,
  shown: number,
  total: number,
  columns: number,
): string {
  const range = rangeStatus(offset, shown, total);
  const candidates = [
    `${range}   arrows scroll   pgup/pgdn page   home/end`,
    `${range}   arrows scroll   pgup/pgdn page`,
    `${range}   arrows scroll`,
    range,
  ];
  for (const candidate of candidates) {
    if (candidate.length <= columns) return candidate;
  }
  return range.slice(0, Math.max(1, columns));
}
