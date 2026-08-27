import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { PluggableList } from 'unified';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import {
  useTranscriptMarkdownContributions,
  useTranscriptMarkdownStyles,
} from '../contributions';
import { useAtomValue } from 'jotai';
import { escapeCurrencyDollarsWithMap } from '../utils/escapeCurrencyDollars';
import { copyToClipboard } from '../../../utils/clipboard';
import { rehypeAutolinkFilePaths } from '../markdown/rehypeAutolinkFilePaths';
import { rehypeAutolinkTrackerRefs } from '../markdown/rehypeAutolinkTrackerRefs';
import { rehypeAutolinkSessionRefs } from '../markdown/rehypeAutolinkSessionRefs';
import { TrackerReferenceChip } from '../../../plugins/TrackerLinkPlugin';
import { TRACKER_REFERENCE_URN_SCHEME } from '../../../plugins/TrackerLinkPlugin/TrackerReferenceNode';
import { isTrackerReferenceKey } from '../../../plugins/TrackerLinkPlugin/trackerReferenceHref';
import { trackerIssueKeyPrefixesAtom } from '../../../plugins/TrackerPlugin/trackerDataAtoms';
import { SessionReferenceChip } from '../session/SessionReferenceChip';
import { sessionRefMapAtom } from '../session/sessionRefAtoms';
import {
  dispatchAppActionHref,
  isAppActionHref,
} from '../../../utils/appActionLinks';

// Inject MarkdownRenderer styles once (for syntax highlighting, scrollbar, and overflow wrapper)
const injectMarkdownRendererStyles = () => {
  const styleId = 'markdown-renderer-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    /* Wrap toggle visibility */
    .wrap-toggle {
      opacity: 0;
      transition: opacity 0.15s ease;
    }
    .overflow-wrapper:hover .wrap-toggle {
      opacity: 1;
    }

    /* Word wrap enabled state */
    .overflow-wrapper.word-wrap-enabled .overflow-content {
      overflow-x: visible;
    }
    .overflow-wrapper.word-wrap-enabled .overflow-content code,
    .overflow-wrapper.word-wrap-enabled .overflow-content pre,
    .overflow-wrapper.word-wrap-enabled .overflow-content div {
      white-space: pre-wrap !important;
      word-break: break-word !important;
      overflow-wrap: break-word !important;
    }

    /* Reset token backgrounds - prevent boxes from default Prism theme */
    .markdown-content .token {
      background: none !important;
    }

    /* Syntax highlighting token colors using CSS variables */
    .markdown-content .token.comment,
    .markdown-content .token.prolog,
    .markdown-content .token.doctype,
    .markdown-content .token.cdata {
      color: var(--nim-text-faint);
      font-style: italic;
    }
    .markdown-content .token.punctuation {
      color: var(--nim-text-muted);
    }
    .markdown-content .token.property,
    .markdown-content .token.tag,
    .markdown-content .token.boolean,
    .markdown-content .token.number,
    .markdown-content .token.constant,
    .markdown-content .token.symbol,
    .markdown-content .token.deleted {
      color: var(--nim-primary);
    }
    .markdown-content .token.selector,
    .markdown-content .token.attr-name,
    .markdown-content .token.string,
    .markdown-content .token.char,
    .markdown-content .token.builtin,
    .markdown-content .token.inserted {
      color: var(--nim-text);
    }
    .markdown-content .token.operator,
    .markdown-content .token.entity,
    .markdown-content .token.url,
    .markdown-content .language-css .token.string,
    .markdown-content .style .token.string {
      color: var(--nim-text-muted);
    }
    .markdown-content .token.atrule,
    .markdown-content .token.attr-value,
    .markdown-content .token.keyword {
      color: var(--nim-primary);
      font-weight: 500;
    }
    .markdown-content .token.function,
    .markdown-content .token.class-name {
      color: var(--nim-text);
      font-weight: 500;
    }
    .markdown-content .token.regex,
    .markdown-content .token.important,
    .markdown-content .token.variable {
      color: var(--nim-primary);
    }

    /* Code block scrollbar styling */
    .markdown-content pre[class*="language-"]::-webkit-scrollbar {
      height: 8px;
    }
    .markdown-content pre[class*="language-"]::-webkit-scrollbar-track {
      background: var(--nim-bg-secondary);
      border-radius: 4px;
    }
    .markdown-content pre[class*="language-"]::-webkit-scrollbar-thumb {
      background: var(--nim-scrollbar-thumb);
      border-radius: 4px;
    }
    .markdown-content pre[class*="language-"]::-webkit-scrollbar-thumb:hover {
      background: var(--nim-scrollbar-thumb-hover);
    }
  `;
  document.head.appendChild(style);
};

// Initialize styles on module load
if (typeof document !== 'undefined') {
  injectMarkdownRendererStyles();
}

// Wrap preference for transcript code blocks, persisted across remounts.
// react-markdown re-renders on every streaming chunk and reconciles by
// sibling index, not content, so a code block whose position shifts (a new
// paragraph appears above it, a message appends, etc.) gets unmounted and
// remounted with fresh local state. That's the "wrap deselects itself"
// symptom.
//
// Identity is keyed by `${messageId}:${nodeOffset}`. The message id is
// passed in from MessageSegment; node.position.start.offset comes from
// react-markdown's override API and is the byte offset of the code fence
// in the original markdown source. Together they're stable from first
// render through end of stream, which closes the early-streaming hole
// that a content-prefix key would leave open. Falls back to a counter
// for callers that don't have a message id (NewFilePreview, tool result
// renderers, etc.) so the cache still helps in those paths without
// risking cross-message bleed (counter values are uniquely allocated
// per mount, so the only carrier of state restoration in the fallback
// path is the same-instance re-render case).
const WRAP_PREFERENCE_CAP = 200;
const wrapPreferenceByKey = new Map<string, boolean>();

function setWrapPreference(key: string, value: boolean) {
  if (!key) return;
  if (wrapPreferenceByKey.has(key)) {
    wrapPreferenceByKey.delete(key);
  } else if (wrapPreferenceByKey.size >= WRAP_PREFERENCE_CAP) {
    const firstKey = wrapPreferenceByKey.keys().next().value;
    if (firstKey !== undefined) wrapPreferenceByKey.delete(firstKey);
  }
  wrapPreferenceByKey.set(key, value);
}

let _rendererInstanceCounter = 0;
function nextRendererInstanceId(): string {
  _rendererInstanceCounter += 1;
  return `mr${_rendererInstanceCounter}`;
}

let _wrapFallbackCounter = 0;
function nextFallbackKey(): string {
  _wrapFallbackCounter += 1;
  return `cb:fallback:${_wrapFallbackCounter}`;
}

// The "Copied" confirmation faces the same remount problem as the wrap
// preference above: a mid-stream remount would drop it and the user would see
// the copy silently un-confirm itself. It is keyed the same way *where there is
// a message id*, and differently where there is not — see `codeBlockCopyKey`.
// Tool results and sub-agent prompts render without one and are re-rendered by
// every streaming chunk, so the wrap preference's per-mount fallback would lose
// the confirmation immediately.
//
// Only one entry is ever held. The clipboard has room for one thing, so a second
// copy must retire the first confirmation — otherwise two blocks claim to be on
// the clipboard and only the later one is. That also caps the memory this can
// hold, which matters because an entry outlives its component when a streaming
// remount drops the timer.
// The length of the copied text is carried along so that a block which kept
// growing after the copy stops claiming that what is on screen is what is on
// the clipboard — the common case, since streaming appends to a block while it
// is visible.
const COPIED_FEEDBACK_MS = 2000;
let lastCopied: { key: string; at: number; length: number } | null = null;
const copyStateListeners = new Set<() => void>();

function publishCopy(next: typeof lastCopied) {
  lastCopied = next;
  copyStateListeners.forEach((notify) => notify());
}

/**
 * Drops the backslashes the currency escape inserted inside this block, so the
 * clipboard carries what the author wrote. Without it `awk '{print $1, $2}'`
 * copies as `awk '{print \$1, \$2}'` and no longer runs — the escape does not
 * spare code fences, and a bare `\$` in the parsed text cannot be told apart
 * from one the author typed, so the insertion offsets are the only way to know.
 *
 * The parsed body is a contiguous slice of the escaped source for a fenced
 * block. Where it is not — an indented block, whose leading spaces the parser
 * strips per line — the text is returned untouched rather than guessed at.
 */
function stripInsertedEscapes(
  body: string,
  node: unknown,
  escapedSource: string,
  insertions: number[],
): string {
  if (insertions.length === 0 || !body) return body;

  const position = (node as { position?: { start?: { offset?: number }; end?: { offset?: number } } })
    ?.position;
  const start = position?.start?.offset;
  const end = position?.end?.offset;
  if (typeof start !== 'number' || typeof end !== 'number') return body;

  const offsetInBlock = escapedSource.slice(start, end).indexOf(body);
  if (offsetInBlock < 0) return body;

  const bodyStart = start + offsetInBlock;
  const inBody = insertions
    .filter((at) => at >= bodyStart && at < bodyStart + body.length)
    .map((at) => at - bodyStart);
  if (inBody.length === 0) return body;

  // Indexed by UTF-16 code unit, matching the parser's offsets — splitting by
  // code point would shift every index after an emoji.
  const drop = new Set(inBody);
  let out = '';
  for (let index = 0; index < body.length; index += 1) {
    if (!drop.has(index)) out += body[index];
  }
  return out;
}

/**
 * Text of a block code element — fenced or four-space indented — read from the
 * hast node rather than from the rendered output: the highlighted branch turns
 * the source into a tree of styled spans, so reading the DOM would copy markup
 * instead of code. The trailing newline that closes the block is dropped.
 */
function blockCodeText(node: unknown): string {
  const collect = (n: any): string => {
    if (!n) return '';
    if (typeof n.value === 'string') return n.value;
    if (Array.isArray(n.children)) return n.children.map(collect).join('');
    return '';
  };
  return collect(node).replace(/\n$/, '');
}

/**
 * One-click copy for a code block. The document editor already offers this
 * through its code-action menu; the transcript renders code through this
 * component instead and had no copy affordance at all. Copying goes through the
 * Electron clipboard helper rather than a selection, so it does not depend on
 * selection behaviour in the transcript. See nimbalyst/nimbalyst#1162.
 */
const CodeCopyButton: React.FC<{ text: string; feedbackKey: string }> = ({ text, feedbackKey }) => {
  const [, forceRender] = useState(0);

  // Every button watches the single "what is on the clipboard" record, so a
  // second copy retires the first block's confirmation immediately instead of
  // waiting for that block to re-render on its own.
  useEffect(() => {
    const notify = () => forceRender((n) => n + 1);
    copyStateListeners.add(notify);
    return () => {
      copyStateListeners.delete(notify);
    };
  }, []);

  const isMine =
    lastCopied !== null &&
    lastCopied.key === feedbackKey &&
    lastCopied.length === text.length &&
    Date.now() - lastCopied.at < COPIED_FEEDBACK_MS;
  // Carried into the effect deps so that copying the same block again restarts
  // the timer — keyed on the boolean alone, the second confirmation would
  // inherit the first one's remaining time.
  const copiedAt = isMine ? lastCopied!.at : 0;
  const copied = copiedAt > 0;

  useEffect(() => {
    if (!copiedAt) return undefined;
    // Clamped: a clock that jumps backwards would otherwise park the
    // confirmation for as long as the jump lasted.
    const elapsed = Date.now() - copiedAt;
    const remaining = Math.min(COPIED_FEEDBACK_MS, Math.max(0, COPIED_FEEDBACK_MS - elapsed));
    const timer = setTimeout(() => publishCopy(null), remaining);
    return () => clearTimeout(timer);
  }, [copiedAt]);

  const handleCopy = useCallback(async () => {
    try {
      await copyToClipboard(text);
      publishCopy({ key: feedbackKey, at: Date.now(), length: text.length });
    } catch (err) {
      console.error('Failed to copy code block:', err);
    }
  }, [text, feedbackKey]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? 'Copied!' : 'Copy code'}
      aria-label={copied ? 'Copied!' : 'Copy code'}
      // 16px, the height of the wrap toggle it sits beside. Anything taller
      // reaches past the block's top padding and covers the first line of code
      // — and since this button, unlike the toggle, stays visible without
      // hover, the covered text would show through it permanently.
      className={`code-copy-button shrink-0 flex items-center justify-center w-4 h-4 p-0 border-none rounded cursor-pointer bg-[var(--nim-bg-secondary)] transition-colors duration-150 hover:text-nim ${
        copied ? 'text-nim-success' : 'text-nim-muted'
      }`}
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
      )}
    </button>
  );
};

/**
 * A one-line code block is a command, not a listing. It keeps the pill shape it
 * always had and gets the button beside it rather than floating over the far
 * right of the column, and it skips the overflow measurement entirely — the
 * wrap toggle would sit two controls deep over a 26px pill, and the observers
 * are the reflow cost the wrapper below exists to avoid.
 */
const CompactCodeBlock: React.FC<{
  children: React.ReactNode;
  persistKey?: string;
  copyText?: string;
  copyKey?: string;
}> = ({ children, persistKey, copyText, copyKey }) => {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const feedbackKey = useMemo(() => copyKey || persistKey || nextFallbackKey(), []);
  // A block-level row, not an inline one: two consecutive single-line blocks
  // are separated by a bare newline in the markup and would otherwise sit side
  // by side, turning a list of commands into one line.
  //
  // The command scrolls, the button never does. A one-line command is often a
  // long URL with no break opportunity, and it is exactly the case where the
  // button matters most — letting the content push it out of an
  // `overflow-x-hidden` column would remove the feature where it is needed.
  return (
    <div className="code-block-compact flex items-center gap-1 max-w-full my-0.5">
      <span className="min-w-0 overflow-x-auto">{children}</span>
      {copyText ? <CodeCopyButton text={copyText} feedbackKey={feedbackKey} /> : null}
    </div>
  );
};

const OverflowWrapper: React.FC<{
  children: React.ReactNode;
  /** Stable id for wrap-preference persistence across remounts. Compose
   *  from messageId + AST node offset at the call site. */
  persistKey?: string;
  /** Raw text of the wrapped code block, used by the copy button. */
  copyText?: string;
  /** Identity for the copy confirmation; see `codeBlockCopyKey`. */
  copyKey?: string;
}> = ({ children, persistKey, copyText, copyKey }) => {
  // Freeze the key once per mount so the same wrap-preference slot is used
  // for the lifetime of this instance. Re-mounts re-evaluate useMemo and
  // pick up the persisted preference (if any) for the resolved key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const wrapKey = useMemo(() => persistKey || nextFallbackKey(), []);
  const [wordWrap, setWordWrapState] = useState<boolean>(
    () => wrapPreferenceByKey.get(wrapKey) ?? false
  );
  const setWordWrap = useCallback((next: boolean) => {
    setWordWrapState(next);
    setWrapPreference(wrapKey, next);
  }, [wrapKey]);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const hasBeenVisible = useRef(false);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const checkOverflow = () => {
      if (contentRef.current) {
        setIsOverflowing(contentRef.current.scrollWidth > contentRef.current.clientWidth + 1);
      }
    };

    // Only measure once visible - avoids forced reflow for off-screen code blocks
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          hasBeenVisible.current = true;
          checkOverflow();
        }
      },
      { rootMargin: '100px' }
    );
    io.observe(el);

    // Re-check on resize (only when already visible)
    const ro = new ResizeObserver(() => {
      if (hasBeenVisible.current) {
        checkOverflow();
      }
    });
    ro.observe(el);

    return () => {
      io.disconnect();
      ro.disconnect();
    };
  }, [children]);

  return (
    <div className={`overflow-wrapper relative ${wordWrap ? 'word-wrap-enabled' : ''}`}>
      <div ref={contentRef} className="overflow-content max-w-full overflow-x-auto whitespace-pre">
        {children}
      </div>
      <div className="code-block-actions flex items-center gap-1 absolute top-1 right-1">
        {(isOverflowing || wordWrap) && (
          <label className="wrap-toggle flex items-center gap-1 text-[0.6875rem] text-[var(--nim-text-faint)] cursor-pointer select-none bg-[var(--nim-bg-secondary)] py-0.5 px-1.5 rounded">
            <input
              type="checkbox"
              checked={wordWrap}
              onChange={(e) => setWordWrap(e.target.checked)}
              className="w-3 h-3 m-0 cursor-pointer accent-[var(--nim-primary)]"
            />
            <span className="leading-none">Wrap</span>
          </label>
        )}
        {copyText ? <CodeCopyButton text={copyText} feedbackKey={copyKey || wrapKey} /> : null}
      </div>
    </div>
  );
};

/** Matches a UUID (v4-style hex with dashes) used as session reference hrefs. */
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MarkdownRendererProps {
  content: string;
  isUser?: boolean;
  isSystemMessage?: boolean;
  /** Optional: Open local file links directly in the editor. `location` carries
   *  the `:line[:col]` suffix when the link had one, so the editor can scroll
   *  there instead of opening at the top. */
  onOpenFile?: (filePath: string, location?: TranscriptFileLocation) => void;
  /**
   * @deprecated Session UUID references now render as a `SessionReferenceChip`
   * that opens the session via the `open-ai-session` event. Still accepted so
   * existing callers typecheck; no longer used for link handling.
   */
  onOpenSession?: (sessionId: string) => void;
  /** Optional: Stable identifier (typically the message id) used to scope
   *  per-block UI preferences (e.g. the OverflowWrapper Wrap toggle) so
   *  preferences survive react-markdown remounts during streaming. */
  messageId?: string | number;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripQueryAndHash(value: string): string {
  let result = value;
  const hashIndex = result.indexOf('#');
  if (hashIndex >= 0) {
    result = result.slice(0, hashIndex);
  }
  const queryIndex = result.indexOf('?');
  if (queryIndex >= 0) {
    result = result.slice(0, queryIndex);
  }
  return result;
}

/** A position inside a file, as carried by a `:42` / `:42:7` link suffix. */
export interface TranscriptFileLocation {
  /** 1-based line. */
  line: number;
  /** 1-based column. Honored by Monaco; the rich markdown view is block-granular. */
  column?: number;
}

/** A file reference from the transcript, with the location suffix parsed out. */
export interface TranscriptFileTarget {
  path: string;
  line?: number;
  column?: number;
}

/** Narrow a target to its location, or undefined when the link carried no line. */
export function transcriptFileLocation(
  target: TranscriptFileTarget | null | undefined,
): TranscriptFileLocation | undefined {
  if (!target || target.line === undefined) return undefined;
  return target.column === undefined
    ? { line: target.line }
    : { line: target.line, column: target.column };
}

/**
 * Upper bound on an accepted line number. Anything past this is a false
 * positive (a port, a timestamp, a hash fragment) rather than a real location,
 * so it is rejected here rather than being carried to an editor that would
 * clamp it to the last line and scroll somewhere arbitrary.
 */
const MAX_PLAUSIBLE_LINE = 10_000_000;

function isPlausibleLocation(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_PLAUSIBLE_LINE;
}

/**
 * Split a `/path/file.ts:42` or `/path/file.ts:42:7` reference into its path
 * and location. Anchored to the end, so a Windows drive colon (`D:/work/x.ts`)
 * is never mistaken for a line number.
 */
function parseLineAndColumnSuffix(filePath: string): TranscriptFileTarget {
  const match = filePath.match(/:(\d+)(?::(\d+))?$/);
  if (!match) return { path: filePath };

  const line = Number(match[1]);
  const column = match[2] === undefined ? undefined : Number(match[2]);
  const path = filePath.slice(0, match.index);

  if (!isPlausibleLocation(line)) return { path };

  return {
    path,
    line,
    ...(column !== undefined && isPlausibleLocation(column) ? { column } : {}),
  };
}

function isAbsoluteFilePath(filePath: string): boolean {
  return (
    filePath.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(filePath) ||
    filePath.startsWith('\\\\')
  );
}

/**
 * Matches a Windows drive-letter absolute path, tolerating a single spurious
 * leading slash (`/D:/...`) that some link sources prepend. Capture group 1 is
 * the normalized path without the leading slash (e.g. `D:/work/foo.pas`).
 */
const WINDOWS_DRIVE_PATH_RE = /^\/?([A-Za-z]:[\\/].*)$/;

/**
 * react-markdown's `defaultUrlTransform` treats a Windows drive letter (`D:`)
 * as a URL scheme. Since `d:` isn't an allowed protocol it blanks the href to
 * `''`, which made Windows file links render as `<a href="">` and open a blank
 * window on click (GitHub #744). It likewise blanks our `nimbalyst://` tracker
 * reference URNs, which made `[NIM-123](nimbalyst://NIM-123)` links fall through
 * to a blank `<a>` (the tracker-chip check in the `a` renderer never saw the
 * href) and open an empty window on click. Preserve Windows absolute paths and
 * internal nimbalyst links verbatim, and delegate everything else to the
 * default so `javascript:`/`data:` links stay sanitized.
 */
export function transcriptUrlTransform(url: string): string {
  if (
    WINDOWS_DRIVE_PATH_RE.test(url) ||
    url.startsWith('\\\\') ||
    url.trim().startsWith(TRACKER_REFERENCE_URN_SCHEME)
  ) {
    return url;
  }
  return defaultUrlTransform(url);
}

/**
 * Returns the tracker reference key for a `nimbalyst://<key>` href, or null.
 */
export function parseTrackerReferenceHref(href?: string): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed.startsWith(TRACKER_REFERENCE_URN_SCHEME)) return null;
  const key = trimmed.slice(TRACKER_REFERENCE_URN_SCHEME.length);
  return isTrackerReferenceKey(key) ? key : null;
}

/**
 * Resolve href to an openable local file path when it looks like a filesystem link.
 * Returns null for non-file/external links.
 *
 * Path-only view of `resolveTranscriptFileTargetFromHref`, kept because most
 * callers only ever need somewhere to open.
 */
export function resolveTranscriptFilePathFromHref(href?: string): string | null {
  return resolveTranscriptFileTargetFromHref(href)?.path ?? null;
}

/**
 * Resolve href to an openable local file path plus any `:line[:col]` suffix, so
 * a link like `/abs/notes.md:653` can land on line 653 rather than the top.
 * Returns null for non-file/external links.
 */
export function resolveTranscriptFileTargetFromHref(href?: string): TranscriptFileTarget | null {
  if (!href) return null;

  const trimmedHref = href.trim();
  if (!trimmedHref || trimmedHref.startsWith('#')) {
    return null;
  }

  let candidate = trimmedHref;

  if (/^file:\/\//i.test(trimmedHref)) {
    try {
      const parsedUrl = new URL(trimmedHref);
      candidate = safeDecodeURIComponent(stripQueryAndHash(parsedUrl.pathname));
      // file:///C:/Users/... => /C:/Users/... (normalize for Windows absolute path)
      if (/^\/[A-Za-z]:[\\/]/.test(candidate)) {
        candidate = candidate.slice(1);
      }
    } catch {
      return null;
    }
  } else {
    // A Windows drive-letter absolute path (`D:\...`, `D:/...`, or the
    // leading-slash-mangled `/D:/...`) superficially looks like a URI with a
    // `d:` scheme. Detect and normalize it (dropping the spurious leading
    // slash) before the external-scheme rejection below, otherwise these
    // links are treated as external URLs and open a blank window (#744).
    const windowsDrive = trimmedHref.match(WINDOWS_DRIVE_PATH_RE);
    if (windowsDrive) {
      candidate = safeDecodeURIComponent(stripQueryAndHash(windowsDrive[1]));
    } else {
      // Keep web links (https:, mailto:, etc.) as external links.
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(trimmedHref)) {
        return null;
      }
      candidate = safeDecodeURIComponent(stripQueryAndHash(trimmedHref));
    }
  }

  const parsed = parseLineAndColumnSuffix(candidate);
  let cleanedPath = parsed.path;
  if (!cleanedPath) {
    return null;
  }

  // Claude Code emits markdown links of the form
  // `/abs/path/<real absolute path>` (e.g.
  // `/abs/path/C:/Users/foo/file.ts:42` on Windows or
  // `/abs/path//Users/foo/file.ts:42` on macOS). The `/abs/path/`
  // prefix is a Claude Code marker, not a real filesystem segment;
  // strip it so the rest of the renderer routes the link through
  // `workspace:open-file` with the actual on-disk path. Fixes #240.
  if (cleanedPath.startsWith('/abs/path/')) {
    cleanedPath = cleanedPath.slice('/abs/path/'.length);
  }

  if (!isAbsoluteFilePath(cleanedPath)) return null;

  return {
    path: cleanedPath,
    ...(parsed.line !== undefined ? { line: parsed.line } : {}),
    ...(parsed.column !== undefined ? { column: parsed.column } : {}),
  };
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  isUser = false,
  isSystemMessage = false,
  onOpenFile,
  messageId
}) => {
  // The copy confirmation needs an identity that survives the remount
  // react-markdown performs on every render. `messageId` supplies one where the
  // caller has it; the tool-result and sub-agent-prompt renderers do not, and a
  // per-mount fallback would drop the confirmation on the next streaming chunk —
  // the user would see the copy un-confirm itself immediately. Scoping to this
  // renderer instance keeps the key stable there without colliding with another
  // block at the same offset in a different card.
  const instanceIdRef = useRef<string | undefined>(undefined);
  if (!instanceIdRef.current) instanceIdRef.current = nextRendererInstanceId();

  const nodeOffset = (node: unknown): number | undefined =>
    (node as { position?: { start?: { offset?: number } } } | null | undefined)?.position?.start
      ?.offset;

  const codeBlockCopyKey = useCallback((node: unknown): string | undefined => {
    const offset = nodeOffset(node);
    if (typeof offset !== 'number') return undefined;
    return `cb:${messageId == null ? instanceIdRef.current : String(messageId)}:${offset}`;
  }, [messageId]);

  // Stable per-block key for the OverflowWrapper wrap-preference cache.
  // Combines the message id (so different messages can never share a slot)
  // with the source-position offset of the code-fence node in the parsed
  // markdown AST (so different blocks within the same message also don't
  // share). react-markdown 10 passes the AST node to each override.
  const codeBlockPersistKey = useCallback((node: unknown): string | undefined => {
    if (messageId == null) return undefined;
    const offset = (node as { position?: { start?: { offset?: number } } } | null | undefined)
      ?.position?.start?.offset;
    if (typeof offset !== 'number') return undefined;
    return `cb:${String(messageId)}:${offset}`;
  }, [messageId]);
  const trackerReferencePreviewKey = useCallback(
    (node: unknown, referenceKey: string): string | undefined => {
      if (messageId == null) return undefined;
      const offset = (node as { position?: { start?: { offset?: number } } } | null | undefined)
        ?.position?.start?.offset;
      return `tracker:${String(messageId)}:${String(offset ?? 'unknown')}:${referenceKey}`;
    },
    [messageId],
  );

  // Extension-contributed markdown plugins/components are merged on top of
  // the core baseline. The transcript registry handles deduping styles and
  // keeps the React tree subscribed to extension enable/disable events.
  const contributions = useTranscriptMarkdownContributions();
  useTranscriptMarkdownStyles(contributions.styles);

  // Core ships only `remark-gfm` as the baseline; KaTeX, syntax themes, and
  // any other domain-specific behavior now arrives via the transcript
  // markdown contribution registry (see
  // `packages/extensions/math` for the canonical KaTeX contributor).
  const remarkPlugins = useMemo<PluggableList>(
    () => [remarkGfm, ...contributions.remarkPlugins] as PluggableList,
    [contributions.remarkPlugins],
  );
  // Distinct issue-key prefixes actually used in this workspace (e.g. `NIM`),
  // so bare tracker keys in prose auto-link without matching `UTF-8`-style
  // tokens. Sorted+joined into a stable dep so the plugin memo only rebuilds
  // when the set of prefixes changes, not on every tracker-store update.
  const trackerPrefixSet = useAtomValue(trackerIssueKeyPrefixesAtom);
  const trackerPrefixKey = useMemo(
    () => Array.from(trackerPrefixSet).sort().join(','),
    [trackerPrefixSet],
  );
  // Known session ids so bare UUIDs in prose/tool results auto-link to a chip
  // without turning unrelated UUIDs into dead session links. Sorted+joined so
  // the plugin memo only rebuilds when the set of ids changes, not on every
  // session-store update (e.g. a processing bit flipping).
  const sessionRefMap = useAtomValue(sessionRefMapAtom);
  const sessionIdKey = useMemo(
    () => Array.from(sessionRefMap.keys()).sort().join(','),
    [sessionRefMap],
  );
  const rehypePlugins = useMemo<PluggableList>(
    () => [
      // Autolink bare file paths into clickable file-open links. Only useful
      // when there is a file-open handler to route the click to.
      ...(onOpenFile ? [rehypeAutolinkFilePaths] : []),
      // Autolink bare tracker keys (`NIM-123`) into live status chips, gated on
      // the prefixes this workspace actually uses.
      ...(trackerPrefixKey
        ? [[rehypeAutolinkTrackerRefs, { prefixes: trackerPrefixKey.split(',') }]]
        : []),
      // Autolink bare session UUIDs into live session chips, gated on the set
      // of known session ids.
      ...(sessionIdKey
        ? [[rehypeAutolinkSessionRefs, { sessionIds: sessionIdKey.split(',') }]]
        : []),
      ...contributions.rehypePlugins,
    ] as PluggableList,
    [contributions.rehypePlugins, onOpenFile, trackerPrefixKey, sessionIdKey],
  );

  // Pre-escape currency-pattern dollar signs so `remark-math` does not
  // collapse `$7M ... $40M`-style text as inline LaTeX in the transcript.
  // Mirrors the pandoc rules from the Lexical-editor fix in commit baf60b4e9.
  // See nimbalyst/nimbalyst#462.
  const { text: processedContent, insertions: escapeInsertions } = useMemo(
    () => escapeCurrencyDollarsWithMap(content),
    [content],
  );

  return (
    <div
      className={`markdown-content text-[0.9375rem] leading-relaxed max-w-full overflow-x-hidden break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 ${isUser ? 'font-medium' : 'font-normal'} ${isSystemMessage ? 'opacity-85 font-mono text-[0.95em]' : ''}`}
      style={{
        color: 'var(--nim-text)'
      }}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        urlTransform={transcriptUrlTransform}
        components={{
          // Code blocks with syntax highlighting
          code({ node, inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || '');
            const language = match ? match[1] : '';
            const codeString = String(children).replace(/\n$/, '');
            const isSingleLine = !codeString.includes('\n');

            // True inline code (backticks in text)
            if (inline) {
              return (
                <code
                  className={className}
                  style={{
                    backgroundColor: 'var(--nim-bg-tertiary)',
                    padding: '0.125rem 0.375rem',
                    borderRadius: '0.25rem',
                    fontSize: '0.875em',
                    fontFamily: 'var(--font-mono, monospace)',
                    color: 'var(--nim-text)'
                  }}
                  {...props}
                >
                  {children}
                </code>
              );
            }

            const codeStyle: React.CSSProperties = {
              backgroundColor: 'var(--nim-bg-tertiary)',
              padding: isSingleLine ? '0.25rem 0.5rem' : '0.75rem',
              borderRadius: isSingleLine ? '0.25rem' : '0.375rem',
              fontSize: '0.8125rem',
              lineHeight: isSingleLine ? '1.4' : '1.5',
              margin: isSingleLine ? 0 : '0.5rem 0'
            };

            // Code block with language - use syntax highlighting
            if (language) {
              const syntaxBlock = (
                <SyntaxHighlighter
                  style={{} as any}
                  customStyle={codeStyle}
                  language={language}
                  PreTag="div"
                  codeTagProps={{
                    style: {
                      fontFamily: 'var(--font-mono, monospace)',
                      fontSize: 'inherit',
                      background: 'none'
                    }
                  }}
                  {...props}
                >
                  {codeString}
                </SyntaxHighlighter>
              );
              return syntaxBlock;
            }

            // Code block without language
            const codeBlock = (
              <code
                className={className}
                style={{
                  display: isSingleLine ? 'inline-block' : 'block',
                  ...codeStyle,
                  fontFamily: 'var(--font-mono, monospace)',
                  color: 'var(--nim-text)'
                }}
                {...props}
              >
                {children}
              </code>
            );
            return codeBlock;
          },
          // `pre` is emitted for block code — fenced and four-space indented —
          // and never for inline code, so this is the one place that can tell
          // them apart: react-markdown no longer passes an `inline` flag to the
          // `code` component. Styling still lives in `code`; these wrappers only
          // supply the copy button and, for multi-line blocks, the horizontal
          // overflow handling.
          pre: ({ children, node }: any) => {
            const text = stripInsertedEscapes(
              blockCodeText(node),
              node,
              processedContent,
              escapeInsertions,
            );
            const persistKey = codeBlockPersistKey(node);
            const copyKey = codeBlockCopyKey(node);
            return text.includes('\n') ? (
              <OverflowWrapper persistKey={persistKey} copyText={text} copyKey={copyKey}>
                {children}
              </OverflowWrapper>
            ) : (
              <CompactCodeBlock persistKey={persistKey} copyText={text} copyKey={copyKey}>
                {children}
              </CompactCodeBlock>
            );
          },
          // Headings
          h1: ({ node: _node, children, style, ...props }: any) => (
            <h1 {...props} style={{
              fontSize: '1.875rem',
              fontWeight: 700,
              marginTop: '1.5rem',
              marginBottom: '1rem',
              color: 'var(--nim-text)',
              borderBottom: '1px solid var(--nim-border)',
              paddingBottom: '0.5rem',
              ...(style || {})
            }}>
              {children}
            </h1>
          ),
          h2: ({ node: _node, children, style, ...props }: any) => (
            <h2 {...props} style={{
              fontSize: '1.5rem',
              fontWeight: 600,
              marginTop: '1.25rem',
              marginBottom: '0.75rem',
              color: 'var(--nim-text)',
              ...(style || {})
            }}>
              {children}
            </h2>
          ),
          h3: ({ node: _node, children, style, ...props }: any) => (
            <h3 {...props} style={{
              fontSize: '1.25rem',
              fontWeight: 600,
              marginTop: '1rem',
              marginBottom: '0.5rem',
              color: 'var(--nim-text)',
              ...(style || {})
            }}>
              {children}
            </h3>
          ),
          h4: ({ node: _node, children, style, ...props }: any) => (
            <h4 {...props} style={{
              fontSize: '1.125rem',
              fontWeight: 600,
              marginTop: '1rem',
              marginBottom: '0.5rem',
              color: 'var(--nim-text)',
              ...(style || {})
            }}>
              {children}
            </h4>
          ),
          h5: ({ node: _node, children, style, ...props }: any) => (
            <h5 {...props} style={{
              fontSize: '1rem',
              fontWeight: 600,
              marginTop: '0.75rem',
              marginBottom: '0.5rem',
              color: 'var(--nim-text)',
              ...(style || {})
            }}>
              {children}
            </h5>
          ),
          h6: ({ node: _node, children, style, ...props }: any) => (
            <h6 {...props} style={{
              fontSize: '0.875rem',
              fontWeight: 600,
              marginTop: '0.75rem',
              marginBottom: '0.5rem',
              color: 'var(--nim-text)',
              ...(style || {})
            }}>
              {children}
            </h6>
          ),
          // Paragraphs
          p: ({ node: _node, children, style, ...props }: any) => (
            <p {...props} style={{
              marginTop: '0.5rem',
              marginBottom: '0.5rem',
              lineHeight: '1.625',
              color: 'var(--nim-text)',
              ...(isUser && { whiteSpace: 'pre-wrap' }),
              ...(style || {})
            }}>
              {children}
            </p>
          ),
          // Links
          a: ({ href, children, node, style, ...props }: any) => {
            const appActionLink = isAppActionHref(href);
            // Tracker reference links (`nimbalyst://NIM-123`) render as a live
            // status chip instead of an anchor.
            const trackerKey = parseTrackerReferenceHref(href);
            if (trackerKey) {
              return (
                <TrackerReferenceChip
                  referenceKey={trackerKey}
                  previewStateKey={trackerReferencePreviewKey(node, trackerKey)}
                />
              );
            }
            // Session references (a bare session UUID href) render as a live
            // session chip that resolves the title/phase and opens the session
            // on click. Autolinked bare UUIDs and author-written UUID links both
            // land here.
            const sessionRefId =
              href && SESSION_UUID_RE.test(href.trim()) ? href.trim() : null;
            if (sessionRefId) {
              return <SessionReferenceChip sessionId={sessionRefId} />;
            }
            // Paths wrapped by `rehypeAutolinkFilePaths` carry a marker with the
            // raw match (possibly with a :line:col suffix). They may be
            // workspace-relative, which the markdown-href resolver rejects, so
            // resolve them directly here and strip the location suffix before
            // opening.
            const autolinkedPath = node?.properties?.dataFilePath as string | undefined;
            const resolvedAutolink =
              onOpenFile && autolinkedPath ? parseLineAndColumnSuffix(autolinkedPath) : null;
            const fileTarget =
              resolvedAutolink ?? (onOpenFile ? resolveTranscriptFileTargetFromHref(href) : null);
            const filePath = fileTarget?.path ?? null;
            const isInternalLink = Boolean(filePath) || appActionLink;
            return (
              <a
                {...props}
                href={href}
                target={isInternalLink ? undefined : '_blank'}
                rel={isInternalLink ? undefined : 'noopener noreferrer'}
                onClick={(event) => {
                  if (appActionLink) {
                    event.preventDefault();
                    event.stopPropagation();
                    dispatchAppActionHref(href);
                    return;
                  }
                  if (filePath && onOpenFile) {
                    event.preventDefault();
                    onOpenFile(filePath, transcriptFileLocation(fileTarget));
                  }
                }}
                style={{
                  color: 'var(--nim-primary)',
                  textDecoration: 'underline',
                  cursor: 'pointer',
                  ...(style || {})
                }}
              >
                {children}
              </a>
            );
          },
          // Lists
          ul: ({ node: _node, children, style, ...props }: any) => (
            <ul {...props} style={{
              marginTop: '0.5rem',
              marginBottom: '0.5rem',
              paddingLeft: '1.5rem',
              listStyleType: 'disc',
              color: 'var(--nim-text)',
              ...(style || {})
            }}>
              {children}
            </ul>
          ),
          ol: ({ node: _node, children, style, ...props }: any) => (
            <ol {...props} style={{
              marginTop: '0.5rem',
              marginBottom: '0.5rem',
              paddingLeft: '1.5rem',
              listStyleType: 'decimal',
              color: 'var(--nim-text)',
              ...(style || {})
            }}>
              {children}
            </ol>
          ),
          li: ({ node: _node, children, style, ...props }: any) => (
            <li {...props} style={{
              marginTop: '0.25rem',
              marginBottom: '0.25rem',
              lineHeight: '1.625',
              ...(style || {})
            }}>
              {children}
            </li>
          ),
          // Blockquotes
          blockquote: ({ node: _node, children, style, ...props }: any) => (
            <blockquote {...props} style={{
              borderLeft: '4px solid var(--nim-border)',
              paddingLeft: '1rem',
              marginLeft: '0',
              marginTop: '0.75rem',
              marginBottom: '0.75rem',
              color: 'var(--nim-text-muted)',
              fontStyle: 'italic',
              ...(style || {})
            }}>
              {children}
            </blockquote>
          ),
          // Tables
          table: ({ node: _node, children, style, ...props }: any) => (
            <div style={{ overflowX: 'auto', marginTop: '0.75rem', marginBottom: '0.75rem' }}>
              <table {...props} style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '0.875rem',
                border: '1px solid var(--nim-border)',
                ...(style || {})
              }}>
                {children}
              </table>
            </div>
          ),
          thead: ({ node: _node, children, style, ...props }: any) => (
            <thead {...props} style={{
              backgroundColor: 'var(--nim-bg-secondary)',
              borderBottom: '2px solid var(--nim-border)',
              ...(style || {})
            }}>
              {children}
            </thead>
          ),
          tbody: ({ node: _node, children, style, ...props }: any) => (
            <tbody {...props} style={style}>
              {children}
            </tbody>
          ),
          tr: ({ node: _node, children, style, ...props }: any) => (
            <tr {...props} style={{
              borderBottom: '1px solid var(--nim-border)',
              ...(style || {})
            }}>
              {children}
            </tr>
          ),
          th: ({ node: _node, children, style, ...props }: any) => (
            <th {...props} style={{
              padding: '0.75rem',
              textAlign: 'left',
              fontWeight: 600,
              color: 'var(--nim-text)',
              ...(style || {})
            }}>
              {children}
            </th>
          ),
          td: ({ node: _node, children, style, ...props }: any) => (
            <td {...props} style={{
              padding: '0.75rem',
              color: 'var(--nim-text)',
              ...(style || {})
            }}>
              {children}
            </td>
          ),
          // Horizontal rule
          hr: ({ node: _node, style, ...props }: any) => (
            <hr {...props} style={{
              border: 'none',
              borderTop: '1px solid var(--nim-border)',
              marginTop: '1rem',
              marginBottom: '1rem',
              ...(style || {})
            }} />
          ),
          // Strong/Bold
          strong: ({ node: _node, children, style, ...props }: any) => (
            <strong {...props} style={{
              fontWeight: 700,
              color: 'var(--nim-text)',
              ...(style || {})
            }}>
              {children}
            </strong>
          ),
          // Emphasis/Italic
          em: ({ node: _node, children, style, ...props }: any) => (
            <em {...props} style={{
              fontStyle: 'italic',
              color: 'var(--nim-text)',
              ...(style || {})
            }}>
              {children}
            </em>
          ),
          // Strikethrough (GFM)
          del: ({ node: _node, children, style, ...props }: any) => (
            <del {...props} style={{
              textDecoration: 'line-through',
              color: 'var(--nim-text-faint)',
              ...(style || {})
            }}>
              {children}
            </del>
          ),
          // Extension overrides applied last so they can replace any of the
          // core component handlers above.
          ...contributions.components,
        }}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
};
