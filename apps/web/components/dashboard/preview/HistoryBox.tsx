import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { UserAvatar } from "@/components/ui/user-avatar";
import { formatLocalDate } from "@/lib/date-format";
import { useTranslation } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { useInfiniteQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Bot, ChevronRight, Workflow } from "lucide-react";

import { useTRPC } from "@karakeep/shared-react/trpc";
import type { ZItemHistoryEntry } from "@karakeep/shared/types/itemHistory";

import {
  EMPTY_HISTORY_VALUE,
  formatHistoryValue,
  groupHistoryEntries,
  historyFieldLabel,
} from "./historyFormat";

const LONG_VALUE_CHARS = 140;

function HistoryValue({
  fieldName,
  value,
  kind,
}: {
  fieldName: string;
  value: unknown;
  kind: "old" | "new";
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const text = formatHistoryValue(fieldName, value);
  const isEmpty = text === EMPTY_HISTORY_VALUE;
  const isLong = text.length > LONG_VALUE_CHARS;
  return (
    <div
      data-history-value={kind}
      className={cn(
        "min-w-0 whitespace-pre-wrap break-words rounded px-1.5 py-0.5",
        kind === "old"
          ? "bg-red-500/10 text-muted-foreground line-through decoration-red-500/40"
          : "bg-green-500/10",
        isEmpty && "italic no-underline",
      )}
    >
      {isEmpty
        ? t("preview.history.empty_value")
        : isLong && !expanded
          ? `${text.slice(0, LONG_VALUE_CHARS)}…`
          : text}
      {isLong && (
        <button
          type="button"
          className="ml-1 text-xs text-primary no-underline hover:underline"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded
            ? t("preview.history.show_less")
            : t("preview.history.show_more")}
        </button>
      )}
    </div>
  );
}

function HistoryActor({ entry }: { entry: ZItemHistoryEntry }) {
  const { t } = useTranslation();
  if (entry.source === "ai") {
    return (
      <span className="flex items-center gap-1">
        <Bot className="size-3.5" />
        {t("preview.history.by_ai")}
      </span>
    );
  }
  const name = entry.changedBy?.name ?? t("preview.history.deleted_user");
  return (
    <span className="flex min-w-0 items-center gap-1">
      {entry.source === "rule" ? (
        <Workflow className="size-3.5" />
      ) : (
        <UserAvatar
          image={entry.changedBy?.image}
          name={name}
          className="size-4 text-[10px]"
        />
      )}
      <span className="truncate">
        {entry.source === "rule"
          ? t("preview.history.by_rule", { name })
          : name}
      </span>
    </span>
  );
}

export default function HistoryBox({
  bookmarkId,
  modifiedAt,
}: {
  bookmarkId: string;
  // Changes made in the background (AI tagging/summaries, rules) bump the
  // bookmark's modifiedAt, so history is refetched when it moves.
  modifiedAt: Date | null;
}) {
  const api = useTRPC();
  const { t, i18n } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  const query = useInfiniteQuery(
    api.bookmarks.getBookmarkHistory.infiniteQueryOptions(
      { bookmarkId },
      {
        initialCursor: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      },
    ),
  );
  const { refetch } = query;
  const modifiedAtMs = modifiedAt?.getTime();
  const lastModifiedAtMs = useRef(modifiedAtMs);
  useEffect(() => {
    if (lastModifiedAtMs.current === modifiedAtMs) {
      return;
    }
    lastModifiedAtMs.current = modifiedAtMs;
    void refetch();
  }, [modifiedAtMs, refetch]);

  const entries = query.data?.pages.flatMap((p) => p.entries) ?? [];
  const groups = groupHistoryEntries(entries);

  return (
    <>
      <Separator />
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger className="flex min-h-8 w-full items-center justify-between gap-2 rounded-md text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 max-sm:min-h-11 [@media(pointer:coarse)]:min-h-11">
          <span className="flex items-center gap-2">
            {t("preview.history.title")}
            {entries.length > 0 && (
              <span className="font-normal tabular-nums">
                {entries.length}
                {query.hasNextPage ? "+" : ""}
              </span>
            )}
          </span>
          <ChevronRight
            className={cn("size-4 transition-transform", isOpen && "rotate-90")}
          />
        </CollapsibleTrigger>
        <CollapsibleContent
          data-testid="bookmark-history"
          className="flex flex-col gap-3 py-3 text-sm"
        >
          {query.isPending ? (
            <p className="text-xs text-muted-foreground">
              {t("preview.history.loading")}
            </p>
          ) : query.isError ? (
            <p className="text-xs text-destructive">
              {t("preview.history.failed")}
            </p>
          ) : groups.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("preview.history.no_changes")}
            </p>
          ) : (
            <ol className="flex flex-col gap-3 border-l pl-3">
              {groups.map((group) => {
                const first = group.entries[0];
                return (
                  <li
                    key={group.changeId}
                    data-history-change={group.changeId}
                    className="flex flex-col gap-1.5"
                  >
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <HistoryActor entry={first} />
                      <time
                        dateTime={first.changedAt.toISOString()}
                        title={formatLocalDate(
                          first.changedAt,
                          "PP, p",
                          i18n.language,
                        )}
                        className="shrink-0"
                      >
                        {formatDistanceToNow(first.changedAt, {
                          addSuffix: true,
                        })}
                      </time>
                    </div>
                    {group.entries.map((entry) => (
                      <div
                        key={entry.id}
                        data-history-field={entry.fieldName}
                        className="flex flex-col gap-0.5"
                      >
                        <span className="text-xs font-medium">
                          {t(`preview.history.fields.${entry.fieldName}`, {
                            defaultValue: historyFieldLabel(entry.fieldName),
                          })}
                        </span>
                        <HistoryValue
                          fieldName={entry.fieldName}
                          value={entry.oldValue}
                          kind="old"
                        />
                        <HistoryValue
                          fieldName={entry.fieldName}
                          value={entry.newValue}
                          kind="new"
                        />
                      </div>
                    ))}
                  </li>
                );
              })}
            </ol>
          )}
          {query.hasNextPage && (
            <Button
              variant="ghost"
              size="sm"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {t("preview.history.load_more")}
            </Button>
          )}
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}
