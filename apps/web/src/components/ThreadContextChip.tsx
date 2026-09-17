import { Link } from "@tanstack/react-router";
import { collectThreadContextLinks } from "@t3tools/shared/threadContext";
import { MessageCircleIcon } from "lucide-react";

import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
  CONTEXT_INLINE_CHIP_INTERACTIVE_CLASS_NAME,
  CONTEXT_INLINE_CHIP_TONE_CLASS_NAMES,
} from "./composerInlineChip";

export function ThreadContextChip({ source }: { source: string }) {
  const thread = collectThreadContextLinks(source)[0];
  if (!thread) return <span>{source}</span>;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId: thread.environmentId, threadId: thread.threadId }}
      aria-label={`Open thread: ${thread.label}`}
      title={thread.label}
      data-markdown-copy={source}
      className={`${COMPOSER_INLINE_CHIP_CLASS_NAME} ${CONTEXT_INLINE_CHIP_TONE_CLASS_NAMES.mention} ${CONTEXT_INLINE_CHIP_INTERACTIVE_CLASS_NAME}`}
    >
      <MessageCircleIcon className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{thread.label}</span>
    </Link>
  );
}
