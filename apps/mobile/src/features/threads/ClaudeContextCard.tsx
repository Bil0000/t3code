import {
  claudeContextSegmentColor,
  claudeContextUsedCategories,
  formatClaudeContextPercent,
  formatClaudeContextTokens,
  type ClaudeContextReport,
  type ClaudeContextSection,
} from "@t3tools/shared/claudeContextReport";
import { memo, useState } from "react";
import { type ColorValue, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ThreadDisclosureChevron } from "./thread-work-log";

function SectionRow(props: {
  readonly section: ClaudeContextSection;
  readonly chevronColor: ColorValue;
}) {
  const [open, setOpen] = useState(false);
  const { section } = props;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={section.title}
        onPress={() => setOpen((value) => !value)}
        className="min-h-11 flex-row items-center gap-2"
      >
        <ThreadDisclosureChevron
          expanded={open}
          collapsedDirection="right"
          size={13}
          tintColor={props.chevronColor}
        />
        <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
          {section.title}
        </Text>
        <Text className="text-xs tabular-nums text-foreground-muted">
          {section.totalTokens !== null
            ? `${formatClaudeContextTokens(section.totalTokens)} · `
            : ""}
          {section.rows.length}
        </Text>
      </Pressable>
      {open ? (
        <View className="mb-2 ml-5 gap-1">
          {section.rows.map((row) => (
            <View key={row.join("|")} className="flex-row items-center gap-3">
              <Text selectable className="flex-1 text-xs text-foreground-secondary">
                {row.slice(0, -1).join(" · ")}
              </Text>
              <Text className="text-xs tabular-nums text-foreground-muted">{row.at(-1)}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export const ClaudeContextCard = memo(function ClaudeContextCard(props: {
  readonly report: ClaudeContextReport;
  readonly chevronColor: ColorValue;
}) {
  const { report } = props;
  const [open, setOpen] = useState(false);
  const used = claudeContextUsedCategories(report);
  const overLimit = report.overLimit !== null || report.usedPercent > 100;

  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel="Context window usage"
        onPress={() => setOpen((value) => !value)}
        className="gap-1"
      >
        <View className="flex-row items-center gap-2">
          <Text
            className={
              overLimit
                ? "font-t3-bold text-2xs uppercase tracking-[1.1px] text-danger-foreground"
                : "font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary"
            }
          >
            Context
          </Text>
          <Text className="flex-1 font-t3-medium text-sm text-foreground" numberOfLines={1}>
            {report.model ?? "Context window"}
          </Text>
          <ThreadDisclosureChevron
            expanded={open}
            collapsedDirection="right"
            size={15}
            tintColor={props.chevronColor}
          />
        </View>
        <Text className="font-t3-bold text-lg tabular-nums text-foreground">
          {`${report.usedTokens} / ${report.maxTokens} (${formatClaudeContextPercent(report.usedPercent)})`}
        </Text>
      </Pressable>
      <View className="h-2 flex-row overflow-hidden rounded-full bg-subtle">
        {used.length > 0 ? (
          used.map((category, index) => (
            <View
              key={category.name}
              className="h-full"
              style={{
                width: `${Math.min(100, category.percent)}%`,
                backgroundColor: claudeContextSegmentColor(index, used.length),
              }}
            />
          ))
        ) : (
          <View
            className="h-full bg-foreground"
            style={{ width: `${Math.min(100, report.usedPercent)}%` }}
          />
        )}
      </View>
      {report.overLimit ? (
        <Text className="text-xs text-danger-foreground">Over limit: {report.overLimit}</Text>
      ) : null}
      {open && report.categories.length > 0 ? (
        <View className="gap-1">
          {report.categories.map((category) => {
            const usedIndex = used.indexOf(category);
            return (
              <View key={category.name} className="flex-row items-center gap-2">
                <View
                  className={
                    usedIndex === -1
                      ? "size-2 rounded-full bg-subtle-strong"
                      : "size-2 rounded-full"
                  }
                  style={
                    usedIndex === -1
                      ? undefined
                      : { backgroundColor: claudeContextSegmentColor(usedIndex, used.length) }
                  }
                />
                <Text className="flex-1 text-xs text-foreground" numberOfLines={1}>
                  {category.name}
                </Text>
                <Text className="text-xs tabular-nums text-foreground-muted">
                  {category.tokens}
                </Text>
                <Text className="min-w-10 text-right text-xs tabular-nums text-foreground-secondary">
                  {formatClaudeContextPercent(category.percent)}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
      {open && report.sections.length > 0 ? (
        <View className="border-t border-border pt-1">
          {report.sections.map((section) => (
            <SectionRow key={section.title} section={section} chevronColor={props.chevronColor} />
          ))}
        </View>
      ) : null}
    </View>
  );
});
