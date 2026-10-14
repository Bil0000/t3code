import type {
  IssueListOrder,
  IssueListSort,
  IssueCapabilities,
  IssueListEntry,
} from "@t3tools/contracts";
import { ArrowDownUpIcon } from "lucide-react";
import type { ElementType } from "react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
interface IssueFilterOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly Icon: ElementType<{ className?: string }>;
}
const SORT_LABELS: Record<IssueListSort, string> = {
  updated: "Recently updated",
  created: "Newest",
  comments: "Most commented",
};

function RadioGroup<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<IssueFilterOption<Value>>;
  onChange: (value: Value) => void;
}) {
  return (
    <MenuGroup>
      <MenuGroupLabel>{label}</MenuGroupLabel>
      <MenuRadioGroup value={value} onValueChange={(next) => onChange(next as Value)}>
        {options.map((option) => (
          <MenuRadioItem key={option.value} value={option.value}>
            <span className="flex min-w-0 items-center gap-2">
              <option.Icon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{option.label}</span>
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </MenuGroup>
  );
}

export function IssueSortMenu({
  sorts,
  sort,
  order,
  orders,
  onSort,
  onOrder,
}: {
  sorts: ReadonlyArray<IssueListSort>;
  sort: IssueListSort;
  order: IssueListOrder;
  orders: ReadonlyArray<IssueListOrder>;
  onSort: (sort: IssueListSort) => void;
  onOrder: (order: IssueListOrder) => void;
}) {
  if (sorts.length <= 1 && orders.length <= 1) return null;
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="outline" size="icon" aria-label={`Sort: ${SORT_LABELS[sort]}`} />}
      >
        <ArrowDownUpIcon aria-hidden className="size-4" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="min-w-48">
        <RadioGroup
          label="Sort"
          value={sort}
          options={sorts.map((value) => ({
            value,
            label: SORT_LABELS[value],
            Icon: ArrowDownUpIcon,
          }))}
          onChange={onSort}
        />
        {orders.length > 1 ? (
          <>
            <MenuSeparator />
            <RadioGroup
              label="Order"
              value={order}
              options={orders.map((value) => ({
                value,
                label: value === "desc" ? "Descending" : "Ascending",
                Icon: ArrowDownUpIcon,
              }))}
              onChange={onOrder}
            />
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

export function issueSortOptions(
  trackers: ReadonlyArray<{
    readonly configured?: boolean | undefined;
    readonly capabilities?: Pick<IssueCapabilities, "listSorts" | "listOrders"> | null | undefined;
  }>,
) {
  const active = trackers.filter((tracker) => tracker.configured !== false);
  const sources = active.length === 0 ? [{}] : active;
  return {
    sorts: (["updated", "created", "comments"] as IssueListSort[]).filter((sort) =>
      sources.every(
        (tracker) => tracker.capabilities?.listSorts?.includes(sort) ?? sort === "updated",
      ),
    ),
    orders: (["desc", "asc"] as IssueListOrder[]).filter((order) =>
      sources.every(
        (tracker) => tracker.capabilities?.listOrders?.includes(order) ?? order === "desc",
      ),
    ),
  };
}

export function supportedIssueSort(
  sort: IssueListSort | undefined,
  order: IssueListOrder | undefined,
  options: ReturnType<typeof issueSortOptions>,
) {
  return {
    sort:
      sort !== undefined && options.sorts.includes(sort) ? sort : (options.sorts[0] ?? "updated"),
    order:
      order !== undefined && options.orders.includes(order) ? order : (options.orders[0] ?? "desc"),
  };
}

export function compareIssueListRows(
  left: Pick<IssueListEntry, "createdAt" | "updatedAt" | "commentCount">,
  right: Pick<IssueListEntry, "createdAt" | "updatedAt" | "commentCount">,
  sort: IssueListSort,
  order: IssueListOrder,
): number {
  const difference =
    sort === "comments"
      ? (left.commentCount ?? 0) - (right.commentCount ?? 0)
      : Date.parse(sort === "created" ? left.createdAt : left.updatedAt) -
        Date.parse(sort === "created" ? right.createdAt : right.updatedAt);
  return order === "asc" ? difference : -difference;
}
