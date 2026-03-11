/**
 * Helpers for trace structure integration tests.
 *
 * Provides span tree building, filtering, and assertion utilities
 * that work with the /debug/spans endpoint from span-collector.ts.
 */
import type { CollectedSpan } from '../../testing/span-collector.js';

export type { CollectedSpan };

export interface SpanNode {
  span: CollectedSpan;
  children: SpanNode[];
}

/**
 * Fetch collected spans from the test server's debug endpoint.
 * Optionally filter by traceId.
 */
export async function fetchSpans(port: number, traceId?: string): Promise<CollectedSpan[]> {
  const url = traceId
    ? `http://localhost:${port}/debug/spans?traceId=${traceId}`
    : `http://localhost:${port}/debug/spans`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetchSpans failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Clear all collected spans on the test server.
 */
export async function clearSpans(port: number): Promise<void> {
  const res = await fetch(`http://localhost:${port}/debug/spans`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`clearSpans failed: ${res.status}`);
}

/**
 * Build a span tree from a flat list of spans.
 * Returns an array of root nodes (spans with no parent in the set).
 */
export function buildSpanTree(spans: CollectedSpan[]): SpanNode[] {
  const nodeMap = new Map<string, SpanNode>();
  for (const span of spans) {
    nodeMap.set(span.spanId, { span, children: [] });
  }
  const roots: SpanNode[] = [];
  for (const node of nodeMap.values()) {
    if (node.span.parentSpanId && nodeMap.has(node.span.parentSpanId)) {
      nodeMap.get(node.span.parentSpanId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/**
 * Find all spans matching a name pattern.
 */
export function findSpans(spans: CollectedSpan[], name: string): CollectedSpan[] {
  return spans.filter((s) => s.name === name);
}

/**
 * Find all spans whose name starts with a prefix.
 */
export function findSpansByPrefix(spans: CollectedSpan[], prefix: string): CollectedSpan[] {
  return spans.filter((s) => s.name.startsWith(prefix));
}

/**
 * Assert that every non-root span has a valid parent in the set.
 * Returns an array of orphan spans (should be empty for a healthy trace).
 */
export function findOrphans(spans: CollectedSpan[]): CollectedSpan[] {
  const spanIds = new Set(spans.map((s) => s.spanId));
  return spans.filter(
    (s) => s.parentSpanId !== undefined && !spanIds.has(s.parentSpanId),
  );
}

/**
 * Check if a span is a descendant of another span in the tree.
 */
export function isDescendantOf(
  spans: CollectedSpan[],
  childSpanId: string,
  ancestorSpanId: string,
): boolean {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  let current = byId.get(childSpanId);
  while (current) {
    if (current.parentSpanId === ancestorSpanId) return true;
    current = current.parentSpanId ? byId.get(current.parentSpanId) : undefined;
  }
  return false;
}
