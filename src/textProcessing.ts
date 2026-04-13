export interface HighlightSegment {
  rawStart: number;
  rawEnd: number;
  rawText: string;
  spokenWeight: number;
}

function trimBounds(source: string, start: number, end: number): [number, number] {
  let left = start;
  let right = end;

  while (left < right && /\s/.test(source[left] ?? "")) {
    left += 1;
  }

  while (right > left && /\s/.test(source[right - 1] ?? "")) {
    right -= 1;
  }

  return [left, right];
}

function pushSegment(segments: HighlightSegment[], source: string, start: number, end: number): void {
  const [trimmedStart, trimmedEnd] = trimBounds(source, start, end);
  if (trimmedEnd <= trimmedStart) {
    return;
  }

  const rawText = source.slice(trimmedStart, trimmedEnd);
  const spokenPreview = collapseWhitespace(stripMarkdownForSpeech(rawText));
  if (!spokenPreview) {
    return;
  }

  segments.push({
    rawStart: trimmedStart,
    rawEnd: trimmedEnd,
    rawText,
    spokenWeight: Math.max(spokenPreview.length, 1)
  });
}

function splitRangeByRegex(
  source: string,
  start: number,
  end: number,
  splitter: RegExp,
  segments: HighlightSegment[]
): boolean {
  const text = source.slice(start, end);
  let cursor = 0;
  let matched = false;

  for (const match of text.matchAll(splitter)) {
    const boundary = match.index ?? 0;
    if (boundary > cursor) {
      pushSegment(segments, source, start + cursor, start + boundary);
      matched = true;
    }
    cursor = boundary + match[0].length;
  }

  if (cursor < text.length) {
    pushSegment(segments, source, start + cursor, end);
  }

  return matched;
}

function splitParagraph(source: string, start: number, end: number, segments: HighlightSegment[]): void {
  const [trimmedStart, trimmedEnd] = trimBounds(source, start, end);
  if (trimmedEnd <= trimmedStart) {
    return;
  }

  const spanLength = trimmedEnd - trimmedStart;
  if (spanLength <= 240) {
    pushSegment(segments, source, trimmedStart, trimmedEnd);
    return;
  }

  const sentenceSplitter = /(?<=[.!?])\s+/g;
  if (splitRangeByRegex(source, trimmedStart, trimmedEnd, sentenceSplitter, segments)) {
    return;
  }

  const clauseSplitter = /(?<=[,;:])\s+/g;
  if (splitRangeByRegex(source, trimmedStart, trimmedEnd, clauseSplitter, segments)) {
    return;
  }

  pushSegment(segments, source, trimmedStart, trimmedEnd);
}

function mergeTinySegments(segments: HighlightSegment[]): HighlightSegment[] {
  const merged: HighlightSegment[] = [];

  for (const segment of segments) {
    const previous = merged.at(-1);
    if (previous && segment.spokenWeight < 30) {
      previous.rawEnd = segment.rawEnd;
      previous.rawText += ` ${segment.rawText}`;
      previous.spokenWeight += segment.spokenWeight;
      continue;
    }

    merged.push({ ...segment });
  }

  return merged;
}

export function normalizeLineEndings(source: string): string {
  return source.replace(/\r\n/g, "\n");
}

export function collapseWhitespace(source: string): string {
  return normalizeLineEndings(source).replace(/[ \t]+\n/g, "\n").replace(/\s+/g, " ").trim();
}

export function stripMarkdownForSpeech(source: string): string {
  let text = normalizeLineEndings(source);

  text = text.replace(/```[\s\S]*?```/g, "\n");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/_([^_]+)_/g, "$1");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  text = text.replace(/^\s*>\s?/gm, "");
  text = text.replace(/\|/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");

  return collapseWhitespace(text);
}

export function buildHighlightSegments(rawSource: string): HighlightSegment[] {
  const source = normalizeLineEndings(rawSource);
  const segments: HighlightSegment[] = [];
  const paragraphSplitter = /\n\s*\n/g;
  let cursor = 0;

  for (const match of source.matchAll(paragraphSplitter)) {
    const boundary = match.index ?? 0;
    splitParagraph(source, cursor, boundary, segments);
    cursor = boundary + match[0].length;
  }

  splitParagraph(source, cursor, source.length, segments);

  if (segments.length === 0 && source.trim()) {
    pushSegment(segments, source, 0, source.length);
  }

  return mergeTinySegments(segments);
}

export function estimateSegmentEndTimes(segments: HighlightSegment[], totalDurationSeconds: number): number[] {
  const safeDuration = Math.max(totalDurationSeconds, 0.01);
  const totalWeight = segments.reduce((sum, segment) => sum + Math.max(segment.spokenWeight, 1), 0);

  let cursor = 0;
  return segments.map((segment) => {
    const fraction = Math.max(segment.spokenWeight, 1) / Math.max(totalWeight, 1);
    cursor += fraction * safeDuration;
    return cursor;
  });
}
