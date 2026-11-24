import { useState } from "react";
import { ActionButton } from "@/components/ui/action-button";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { formatLocalDate } from "@/lib/date-format";
import { useTranslation } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";

import { useTRPC } from "@karakeep/shared-react/trpc";
import type {
  ZHistoryEntry,
  ZHistoryValue,
} from "@karakeep/shared/types/itemHistory";

import {
  formatHistoryValue,
  groupHistoryEntries,
  historyFieldLabelKey,
} from "./historyFormat";

// Longer values start clamped, so one edit to a long note or text doesn't push
// everything else out of view.
const LONG_VALUE_CHARS = 160;
const LONG_VALUE_LINES = 3;

function HistoryValue({
  entry,
  value,
  label,
}: {
  entry: ZHistoryEntry;
  value: ZHistoryValue;
  label: string;
}) {
  const { t, i18n } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const formatted = formatHistoryValue(entry.field, value, {
    locale: i18n.language,
    yes: t("preview.history.yes"),
    no: t("preview.history.no"),
  });
  const isLong =
    !!formatted &&
    (formatted.length > LONG_VALUE_CHARS ||
      formatted.split("\n").length > LONG_VALUE_LINES);

  return (
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-col items-start">
        {/* Rendered as plain text: old values are whatever was saved. */}
        <span
          className={cn(
            "max-w-full whitespace-pre-wrap [overflow-wrap:anywhere]",
            isLong && !isExpanded && "line-clamp-3",
            !formatted && "italic text-muted-foreground",
          )}
        >
          {formatted ?? t("preview.history.empty_value")}
        </span>
        {isLong && (
          <Button
            variant="link"
            size="none"
            className="text-xs"
            aria-expanded={isExpanded}
            onClick={() => setIsExpanded(!isExpanded)}
          >
            {t(
              isExpanded
                ? "preview.history.show_less"
                : "preview.history.show_more",
            )}
          </Button>
        )}
      </dd>
    </div>
  );
}

function HistoryList({ bookmarkId }: { bookmarkId: string }) {
  const api = useTRPC();
  const { t, i18n } = useTranslation();
  const {
    data,
    isPending,
    isError,
    refetch,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery(
    api.bookmarks.getBookmarkHistory.infiniteQueryOptions(
      { bookmarkId },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        // Rules and background jobs change bookmarks without the app knowing,
        // so look again whenever the section is opened.
        refetchOnMount: "always",
      },
    ),
  );

  if (isPending) {
    return <p className="text-muted-foreground">{t("common.loading")}</p>;
  }
  if (isError && !data) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <span>{t("preview.history.load_failed")}</span>
        <Button variant="link" size="none" onClick={() => refetch()}>
          {t("actions.retry")}
        </Button>
      </div>
    );
  }

  const groups = groupHistoryEntries(
    data.pages.flatMap((page) => page.entries),
  );
  if (groups.length === 0) {
    return (
      <p className="text-muted-foreground">{t("preview.history.none_yet")}</p>
    );
  }

  return (
    <>
      <ol className="flex flex-col gap-4">
        {groups.map((group) => (
          <li
            key={group.changeId}
            className="flex flex-col gap-2 border-l-2 pl-3"
          >
            <div className="flex flex-col text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {group.source === "user"
                  ? (group.changedBy?.name ?? t("preview.history.deleted_user"))
                  : t(`preview.history.sources.${group.source}`)}
              </span>
              <time dateTime={group.changedAt.toISOString()}>
                {formatLocalDate(group.changedAt, "PP, p", i18n.language)}
              </time>
            </div>
            {group.entries.map((entry) => (
              <div key={entry.id} className="flex flex-col gap-1">
                <p className="font-medium">
                  {t(historyFieldLabelKey(entry.field))}
                </p>
                <dl className="flex flex-col gap-1">
                  <HistoryValue
                    entry={entry}
                    value={entry.oldValue}
                    label={t("preview.history.before")}
                  />
                  <HistoryValue
                    entry={entry}
                    value={entry.newValue}
                    label={t("preview.history.after")}
                  />
                </dl>
              </div>
            ))}
          </li>
        ))}
      </ol>
      {hasNextPage && (
        <ActionButton
          variant="ghost"
          size="sm"
          loading={isFetchingNextPage}
          onClick={() => fetchNextPage()}
        >
          {t("actions.load_more")}
        </ActionButton>
      )}
    </>
  );
}

export default function HistoryBox({ bookmarkId }: { bookmarkId: string }) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Separator />
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger className="flex min-h-8 w-full items-center justify-between gap-2 rounded-md text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 max-sm:min-h-11 [@media(pointer:coarse)]:min-h-11">
          {t("preview.history.title")}
          <ChevronRight
            className={cn("size-4 transition-transform", isOpen && "rotate-90")}
          />
        </CollapsibleTrigger>
        {/* Unmounted while closed, so nothing is fetched until it's opened. */}
        <CollapsibleContent className="flex flex-col gap-3 py-3 text-sm">
          <HistoryList bookmarkId={bookmarkId} />
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}
