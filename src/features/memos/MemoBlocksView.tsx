import { FileText, ExternalLink } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { orderedBlocks, pageName } from "../../core/block-tree";
import { normalizeMemoTag } from "../../core/memos";
import { tableCells, tableGrid } from "../../core/simple-table";
import type { Block, BlockTree, InlineContent, InlineRun, NotePage, StoredFile } from "../../core/types";
import { bulletFor, numberFor } from "../editor/BlockRow";
import { codeHtml } from "../editor/code-highlight";
import { memoFileUrl } from "./memo-api";

const TAG_TONES = ["blue", "green", "purple", "orange", "yellow", "pink", "gray"] as const;

export function tagTone(tag: string): (typeof TAG_TONES)[number] {
  const root = tag.split("/")[0] || tag;
  let hash = 0;
  for (let i = 0; i < root.length; i++) {
    hash = (hash * 31 + root.charCodeAt(i)) | 0;
  }
  return TAG_TONES[Math.abs(hash) % TAG_TONES.length];
}

function renderTaggedText(
  text: string,
  allowTags: boolean,
  onToggleTag?: (tag: string) => void,
): ReactNode {
  if (!allowTags || !text.includes("#")) return text;
  const tagRe = /(^|[\s(（\[【])#([^\s#.,，。!?！？:：;；)）\]】`'"\\]{1,40})/g;
  const out: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;
  while ((match = tagRe.exec(text)) !== null) {
    const prefix = match[1];
    const tag = normalizeMemoTag(match[2]);
    if (!tag) continue;
    if (match.index > cursor) out.push(text.slice(cursor, match.index));
    if (prefix) out.push(prefix);
    out.push(
      <button
        key={`tag-${keyIdx++}`}
        type="button"
        className={`memo-tag-chip memo-tag-chip--${tagTone(tag)}`}
        onClick={(event) => {
          event.stopPropagation();
          onToggleTag?.(tag);
        }}
      >
        #{tag}
      </button>,
    );
    cursor = match.index + match[0].length;
  }
  if (!out.length) return text;
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

function renderInlineRun(
  run: InlineRun,
  key: number,
  options: {
    pages: Readonly<Record<string, NotePage>>;
    allowTags: boolean;
    onToggleTag?: (tag: string) => void;
    onFollowLink?: (pageId: string, full: boolean) => void;
    onPreviewImage?: (file: StoredFile) => void;
  },
): ReactNode {
  if (run.mention) {
    if (run.mention.kind === "page") {
      const targetPageId = run.mention.page_id;
      const target = options.pages[targetPageId];
      const title = target ? (pageName(target) || "Untitled") : "未找到页面";
      return (
        <button
          key={key}
          type="button"
          className="memo-mention-chip"
          onClick={(event) => {
            event.stopPropagation();
            options.onFollowLink?.(targetPageId, event.metaKey || event.ctrlKey);
          }}
        >
          {title}
        </button>
      );
    }
    if (run.mention.kind === "date") {
      return <span key={key} className="memo-date-chip">@{run.mention.date}</span>;
    }
    if (run.mention.kind === "image") {
      const file = run.mention.file;
      return (
        <button
          key={key}
          type="button"
          className="memo-thumb"
          title="查看大图"
          onClick={(event) => {
            event.stopPropagation();
            options.onPreviewImage?.(file);
          }}
        >
          <img src={memoFileUrl(file)} alt={file.name} loading="lazy" />
        </button>
      );
    }
  }

  const marks = run.marks;
  const allowTags = options.allowTags && !marks?.code && !marks?.link;
  let node: ReactNode = renderTaggedText(run.text, allowTags, options.onToggleTag);
  if (marks?.code) node = <code>{node}</code>;
  if (marks?.bold) node = <strong>{node}</strong>;
  if (marks?.italic) node = <em>{node}</em>;
  if (marks?.underline) node = <u>{node}</u>;
  if (marks?.strike) node = <s>{node}</s>;
  if (marks?.color) node = <span data-color={marks.color}>{node}</span>;
  if (marks?.link) {
    node = (
      <a
        href={marks.link}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => event.stopPropagation()}
      >
        {node}
      </a>
    );
  }
  return <Fragment key={key}>{node}</Fragment>;
}

function renderRuns(
  content: InlineContent,
  options: {
    pages: Readonly<Record<string, NotePage>>;
    allowTags: boolean;
    onToggleTag?: (tag: string) => void;
    onFollowLink?: (pageId: string, full: boolean) => void;
    onPreviewImage?: (file: StoredFile) => void;
  },
): ReactNode {
  if (!content.length) return <br />;
  return content.map((run, idx) => renderInlineRun(run, idx, options));
}

function MemoBlockNode({
  tree,
  block,
  depth,
  index,
  pages,
  interactiveTodo,
  onToggleTag,
  onFollowLink,
  onPreviewImage,
  onToggleTodo,
}: {
  tree: BlockTree;
  block: Block;
  depth: number;
  index: number;
  pages: Readonly<Record<string, NotePage>>;
  interactiveTodo: boolean;
  onToggleTag?: (tag: string) => void;
  onFollowLink?: (pageId: string, full: boolean) => void;
  onPreviewImage?: (file: StoredFile) => void;
  onToggleTodo?: (blockId: string, checked: boolean) => void;
}) {
  const children = orderedBlocks(tree, block.id);
  const runOpts = {
    pages,
    allowTags: block.kind !== "code",
    onToggleTag,
    onFollowLink,
    onPreviewImage,
  };

  let body: ReactNode;
  if (block.kind === "divider") {
    body = <hr className="block__rule" />;
  } else if (block.kind === "code") {
    const codeText = block.content.map((r) => r.text).join("");
    const highlighted = codeHtml(codeText, block.language);
    body = (
      <div className="memo-code-wrap">
        {block.language && block.language !== "plain" && block.language !== "plain text" ? (
          <span className="memo-code-lang">{block.language}</span>
        ) : null}
        <pre className="block__editable">
          {highlighted ? <code dangerouslySetInnerHTML={{ __html: highlighted }} /> : <code>{codeText}</code>}
        </pre>
      </div>
    );
  } else if (block.kind === "file" && block.file) {
    body = (
      <a
        className="memo-file-chip"
        href={memoFileUrl(block.file)}
        download={block.file.name}
        onClick={(event) => event.stopPropagation()}
      >
        <FileText size={14} aria-hidden="true" />
        <span>{block.file.name}</span>
      </a>
    );
  } else if (block.kind === "table") {
    const grid = tableGrid(block.table);
    const cells = tableCells(grid);
    body = (
      <div className="memo-table-wrap">
        <table className="memo-table">
          <tbody>
            {cells.map((rowCells, rIdx) => (
              <tr key={grid.rows[rIdx]?.id ?? rIdx}>
                {rowCells.map((cellContent, cIdx) => {
                  const isHead = (grid.header_row && rIdx === 0) || (grid.header_column && cIdx === 0);
                  const CellTag = isHead ? "th" : "td";
                  return (
                    <CellTag key={grid.columns[cIdx]?.id ?? cIdx}>
                      {cellContent.length ? renderRuns(cellContent, { ...runOpts, allowTags: false }) : null}
                    </CellTag>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  } else if (block.kind === "embed" && block.embed) {
    body = (
      <a
        className="memo-embed-chip"
        href={block.embed.url}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => event.stopPropagation()}
      >
        <ExternalLink size={13} aria-hidden="true" />
        <span>{block.embed.provider === "youtube" ? (block.embed.title || block.embed.url) : (block.embed.text || block.embed.url)}</span>
      </a>
    );
  } else {
    const HeadingTag = (
      block.kind === "heading1" ? "h1"
        : block.kind === "heading2" ? "h2"
          : block.kind === "heading3" ? "h3"
            : block.kind === "heading4" ? "h4"
              : block.kind === "heading5" ? "h5"
                : "div"
    );
    body = (
      <HeadingTag className="block__editable">
        {renderRuns(block.content, runOpts)}
      </HeadingTag>
    );
  }

  return (
    <div
      className={`block block--${block.kind} ${block.kind === "todo" && block.checked ? "is-checked" : ""}`}
      data-color={block.color}
      style={{ ["--depth" as string]: depth }}
    >
      <div className="block__content">
        {block.kind === "todo" ? (
          <span className="block__marker">
            <button
              type="button"
              className={`checkbox ${block.checked ? "is-checked" : ""}`}
              aria-label={block.checked ? "Mark as not done" : "Mark as done"}
              aria-pressed={Boolean(block.checked)}
              disabled={!interactiveTodo}
              onClick={(event) => {
                event.stopPropagation();
                if (interactiveTodo) onToggleTodo?.(block.id, !block.checked);
              }}
            />
          </span>
        ) : null}
        {block.kind === "bullet" ? (
          <span className="block__marker block__marker--bullet" aria-hidden="true">{bulletFor(depth)}</span>
        ) : null}
        {block.kind === "numbered" ? (
          <span className="block__marker block__marker--numbered" aria-hidden="true">{numberFor(index, depth)}</span>
        ) : null}
        {block.kind === "callout" ? (
          <span className="block__callout-icon" aria-hidden="true">{block.icon || "💡"}</span>
        ) : null}
        {body}
      </div>
      {children.length ? (
        <div className="block__children">
          {children.map((child, childIdx) => (
            <MemoBlockNode
              key={child.id}
              tree={tree}
              block={child}
              depth={depth + 1}
              index={childIdx + 1}
              pages={pages}
              interactiveTodo={interactiveTodo}
              onToggleTag={onToggleTag}
              onFollowLink={onFollowLink}
              onPreviewImage={onPreviewImage}
              onToggleTodo={onToggleTodo}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function MemoBlocksView({
  tree,
  pages,
  compact = false,
  interactiveTodo = true,
  onToggleTag,
  onFollowLink,
  onPreviewImage,
  onToggleTodo,
}: {
  tree: BlockTree;
  pages: Readonly<Record<string, NotePage>>;
  compact?: boolean;
  interactiveTodo?: boolean;
  onToggleTag?: (tag: string) => void;
  onFollowLink?: (pageId: string, full: boolean) => void;
  onPreviewImage?: (file: StoredFile) => void;
  onToggleTodo?: (blockId: string, checked: boolean) => void;
}) {
  const roots = orderedBlocks(tree, null);
  let numbered = 0;
  return (
    <div className={`blocks memo-blocks-view ${compact ? "memo-blocks-view--compact" : ""}`}>
      {roots.map((block) => {
        if (block.kind === "numbered") numbered += 1;
        else numbered = 0;
        return (
          <MemoBlockNode
            key={block.id}
            tree={tree}
            block={block}
            depth={0}
            index={numbered}
            pages={pages}
            interactiveTodo={interactiveTodo}
            onToggleTag={onToggleTag}
            onFollowLink={onFollowLink}
            onPreviewImage={onPreviewImage}
            onToggleTodo={onToggleTodo}
          />
        );
      })}
    </div>
  );
}
