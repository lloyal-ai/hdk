import type { Operation } from 'effection';
import { Tool, CallingAgent } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema, ToolContext } from '@lloyal-labs/lloyal-agents';
import type { Resource, Chunk } from '@lloyal-labs/rig';
import { mergeRanges, subtractRanges } from '@lloyal-labs/rig';

/** Which file a call names. One rule for the present call and every past one,
 *  so "what did that read deliver" cannot drift from "what does this read ask
 *  for". `path` is the alias models reach for when the schema says `filename`. */
function nameOf(args: { filename?: unknown; path?: unknown }): string {
  return (typeof args.filename === 'string' && args.filename)
    || (typeof args.path === 'string' && args.path)
    || '';
}

/**
 * Read content from corpus files by line range
 *
 * Returns only the lines the calling agent has not already RECEIVED, so a
 * second read does not inflate context with what is already there. Line ranges
 * typically come from {@link SearchTool} results.
 *
 * What counts as read is what the agent attends over — its own booked history
 * and its callers' — never a map the tool keeps, which would record a read the
 * pool went on to reject.
 *
 * @category Rig
 */
export class ReadFileTool extends Tool<{ filename: string; startLine?: number; endLine?: number }> {
  readonly name = 'read_file';
  readonly protected = false;
  readonly description = 'Read content from a file at specific line ranges. Use startLine/endLine from search results.';
  readonly parameters: JsonSchema;

  private _resources: Resource[];
  private _chunks: Chunk[];
  private _defaultMaxLines: number;

  constructor(resources: Resource[], opts?: { defaultMaxLines?: number; chunks?: Chunk[] }) {
    super();
    this._resources = resources;
    this._chunks = opts?.chunks ?? [];
    this._defaultMaxLines = opts?.defaultMaxLines ?? 100;
    this.parameters = {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Filename from search results',
          enum: resources.map(r => r.name),
        },
        startLine: { type: 'number', description: 'Start line (1-indexed, from search results)' },
        endLine: { type: 'number', description: 'End line (1-indexed, from search results)' },
      },
      required: ['filename'],
    };
  }

  *execute(
    args: { filename: string; startLine?: number; endLine?: number } & Record<string, unknown>,
    context?: ToolContext,
  ): Operation<unknown> {
    const filename = nameOf(args);
    const file = this._resources.find(r => r.name === filename);
    if (!file) {
      return { error: `File not found: ${filename}. Available: ${this._resources.map(r => r.name).join(', ')}` };
    }

    const lines = file.content.split('\n');
    const [s, e] = this._spanOf(args, lines.length);

    // Every read of THIS file whose result this agent attends over, resolved
    // by the same rule as the present call.
    const agent = yield* CallingAgent.get();
    const prev = agent
      ? mergeRanges(
          agent.attendedResults(this.name)
            .filter((a) => nameOf(a) === filename)
            .map((a) => this._spanOf(a, lines.length))
            .filter(([a, b]) => b > a),
        )
      : [];
    const unread = subtractRanges([s, e], prev);

    if (unread.length === 0) {
      return { file: file.name, note: `Lines ${s + 1}-${e} already read` };
    }

    const content = unread
      .map(([a, b]) => lines.slice(a, b).join('\n'))
      .join('\n...\n');

    const result: Record<string, unknown> = {
      file: file.name,
      content,
      lines: unread.map(([a, b]) => `${a + 1}-${b}`),
    };

    // Add related sections for corpus navigation
    if (this._chunks.length > 0) {
      result.relatedSections = this._findRelated(filename, s, e);
    }

    return result;
  }

  /** The half-open line span a call names — `[s, e)`. The same rule serves the
   *  present call and every past one, so a past read's delivered range cannot
   *  drift from the range the present read asks for. */
  private _spanOf(
    args: { startLine?: unknown; endLine?: unknown },
    lineCount: number,
  ): [number, number] {
    const s = Math.max(0, (typeof args.startLine === 'number' ? args.startLine : 1) - 1);
    const e = Math.min(lineCount, typeof args.endLine === 'number' ? args.endLine : Math.min(this._defaultMaxLines, lineCount));
    return [s, e];
  }

  /**
   * Find related sections: same-file siblings (adjacent in section hierarchy)
   * and cross-file sections with keyword overlap in section paths.
   */
  private _findRelated(
    filename: string,
    readStart: number,
    readEnd: number,
  ): Array<{ file: string; heading: string; section: string; startLine: number; endLine: number }> {
    // Find the chunk being read
    const currentChunk = this._chunks.find(
      c => c.resource === filename && c.startLine - 1 <= readStart && c.endLine >= readEnd,
    );
    const currentSection = currentChunk?.section ?? '';

    // Extract the parent path (everything before the last " > ")
    const lastSep = currentSection.lastIndexOf(' > ');
    const parentPath = lastSep >= 0 ? currentSection.slice(0, lastSep) : '';

    // Same-file siblings: chunks in the same file with the same parent path
    const sameFile = this._chunks.filter(c =>
      c.resource === filename
      && c.section !== currentSection
      && c.section !== ''
      && c.startLine !== (currentChunk?.startLine ?? -1)
      && (parentPath
        ? c.section.startsWith(parentPath + ' > ')
          || c.section === parentPath
        : !c.section.includes(' > ')) // top-level siblings if no parent
    );

    // Cross-file: extract keywords from current heading, find matches in other files
    const keywords = this._extractKeywords(currentChunk?.heading ?? '');
    const crossFile = keywords.length > 0
      ? this._chunks.filter(c =>
          c.resource !== filename
          && c.section !== ''
          && keywords.some(kw =>
            c.heading.toLowerCase().includes(kw)
            || c.section.toLowerCase().includes(kw),
          ),
        )
      : [];

    // Combine, dedup, limit
    const seen = new Set<string>();
    const related: Array<{ file: string; heading: string; section: string; startLine: number; endLine: number }> = [];

    for (const c of [...sameFile, ...crossFile]) {
      const key = `${c.resource}:${c.startLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      related.push({
        file: c.resource,
        heading: c.heading,
        section: c.section,
        startLine: c.startLine,
        endLine: c.endLine,
      });
      if (related.length >= 8) break;
    }

    return related;
  }

  /** Extract lowercase keywords (3+ chars) from a heading */
  private _extractKeywords(heading: string): string[] {
    return heading
      .toLowerCase()
      .split(/[\s>_\-./]+/)
      .filter(w => w.length >= 3);
  }
}
