/**
 * A bare attachment address in prose is a link, as GFM makes a bare url one. A model that cites a moment or a
 * page by writing its address, not a markdown link, has still cited it, and the address says exactly what it
 * cites. What counts as an address is media's citation grammar.
 *
 * The address is found where GFM finds a bare url: in the parse, as a micromark text construct, so the link
 * stands exactly where the source writes it, and a link label, code or an escape is the parser's to decide, never
 * this file's. The construct follows GFM's protocol autolink literal: it starts on the scheme where the previous
 * character is not a letter and no link label is open, runs to whitespace or `<()[]`, and leaves out a trail of
 * punctuation that only leads to that end, which is the sentence's. A run that is not an address is not a link.
 *
 * @category UI
 */
import { parseAttachmentHref, parseAttachmentMoment } from '@lloyal-labs/media';
import { asciiAlpha, markdownLineEndingOrSpace, unicodePunctuation, unicodeWhitespace } from 'micromark-util-character';
import type { Code, Construct, Event, Extension, State, TokenizeContext, Tokenizer } from 'micromark-util-types';
import type { CompileContext, Extension as FromMarkdownExtension, Token } from 'mdast-util-from-markdown';
import type { Processor } from 'unified';
import type {} from 'remark-parse';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    attachmentAddress: 'attachmentAddress';
    attachmentAddressValue: 'attachmentAddressValue';
  }
  interface Token {
    _attachmentAddressWalkedInto?: boolean;
  }
}

/** The content plane's scheme, which every address begins with. */
const SCHEME = 'attachment://';
/** What ends a run outright: markdown punctuation an address never holds. */
const ENDS = new Set(['<', '(', ')', '[', ']'].map((c) => c.codePointAt(0)!));

const isAddress = (run: string): boolean => parseAttachmentMoment(run) !== null || parseAttachmentHref(run) !== null;

/** The end of a run: nothing more, whitespace, or markdown punctuation an address never holds. */
const isEnd = (code: Code): boolean =>
  code === null || markdownLineEndingOrSpace(code) || unicodeWhitespace(code) || ENDS.has(code);

/** Where an address may start: not inside a word. */
const previousAddress = (code: Code): boolean => !asciiAlpha(code);

/**
 * Whether a link label is open before this point, so an address in `[attachment://…](…)` stays the label's text.
 * GFM's own walk, marking the last event so the next construct walks no further back than it.
 */
function previousUnbalanced(events: readonly Event[]): boolean {
  let result = false;
  for (let index = events.length - 1; index >= 0; index--) {
    const token = events[index][1];
    if ((token.type === 'labelLink' || token.type === 'labelImage') && !token._balanced) {
      result = true;
      break;
    }
    if (token._attachmentAddressWalkedInto) break;
  }
  if (events.length > 0 && !result) events[events.length - 1][1]._attachmentAddressWalkedInto = true;
  return result;
}

/** A trail: punctuation, of any script, that only leads to the end of the run. It is the sentence's. */
const tokenizeTrail: Tokenizer = (effects, ok, nok) => {
  const trail: State = (code) => {
    if (isEnd(code)) return ok(code);
    if (unicodePunctuation(code)) {
      effects.consume(code);
      return trail;
    }
    return nok(code);
  };
  return trail;
};

const trail: Construct = { tokenize: tokenizeTrail, partial: true };

/** An address: the scheme, then the run up to its end or its trail, accepted only when the run is an address. */
const tokenizeAddress: Tokenizer = function (this: TokenizeContext, effects, ok, nok) {
  let run = '';
  const take = (code: Code, next: State): State => {
    run += String.fromCodePoint(code!);
    effects.consume(code);
    return next;
  };
  const end: State = (code) => {
    if (!isAddress(run)) return nok(code);
    effects.exit('attachmentAddressValue');
    effects.exit('attachmentAddress');
    return ok(code);
  };
  const rest: State = (code) => {
    if (isEnd(code)) return end(code);
    if (unicodePunctuation(code)) return effects.check(trail, end, (c) => take(c, rest))(code);
    return take(code, rest);
  };
  const scheme: State = (code) =>
    run.length === SCHEME.length ? rest(code) : code === SCHEME.codePointAt(run.length) ? take(code, scheme) : nok(code);
  return (code) => {
    if (code !== SCHEME.codePointAt(0) || !previousAddress(this.previous) || previousUnbalanced(this.events)) return nok(code);
    effects.enter('attachmentAddress');
    effects.enter('attachmentAddressValue');
    return scheme(code);
  };
};

const address: Construct = { name: 'attachmentAddress', tokenize: tokenizeAddress };

const syntax: Extension = { text: { [SCHEME.codePointAt(0)!]: address } };

/** The address as a link, through the handlers GFM's protocol literal uses: its text is the address, and so is
 *  its url. */
const fromMarkdown: FromMarkdownExtension = {
  enter: {
    attachmentAddress(this: CompileContext, token: Token) {
      this.enter({ type: 'link', title: null, url: '', children: [] }, token);
    },
    attachmentAddressValue(this: CompileContext, token: Token) {
      this.config.enter.autolinkProtocol!.call(this, token);
    },
  },
  exit: {
    attachmentAddress(this: CompileContext, token: Token) {
      this.exit(token);
    },
    attachmentAddressValue(this: CompileContext, token: Token) {
      this.config.exit.autolinkProtocol!.call(this, token);
    },
  },
};

/** The remark plugin: every attachment address in text outside a link is a link, where the source writes it. */
export function attachmentLinks(this: Processor): void {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(syntax);
  (data.fromMarkdownExtensions ??= []).push(fromMarkdown);
}
