import { type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { shortcutLabelForCommand } from "../keybindings";
import {
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import {
  CommandCollection,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./ui/command";
import { ThreadSearchMatchExcerpt } from "./ThreadSearchMatch";
import { useT } from "../i18n";

function isInterfaceResult(value: string): boolean {
  return value.startsWith("action:") || value.startsWith("setting:");
}

interface CommandPaletteResultsProps {
  emptyStateMessage?: string;
  groups: ReadonlyArray<CommandPaletteGroup>;
  highlightedItemValue?: string | null;
  isActionsOnly: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}

export function CommandPaletteResults(props: CommandPaletteResultsProps) {
  const t = useT();
  if (props.groups.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        {t(
          props.emptyStateMessage ??
            (props.isActionsOnly
              ? "No matching actions."
              : "No matching commands, projects, or threads."),
        )}
      </div>
    );
  }

  return (
    <CommandList>
      {props.groups.map((group) => (
        <CommandGroup items={group.items} key={group.value}>
          <CommandGroupLabel>{t(group.label)}</CommandGroupLabel>
          <CommandCollection>
            {(item) =>
              item.disabled ? (
                <DisabledCommandPaletteResultRow item={item} key={item.value} />
              ) : (
                <CommandPaletteResultRow
                  item={item}
                  key={item.value}
                  keybindings={props.keybindings}
                  isActive={props.highlightedItemValue === item.value}
                  onExecuteItem={props.onExecuteItem}
                />
              )
            }
          </CommandCollection>
        </CommandGroup>
      ))}
    </CommandList>
  );
}

function DisabledCommandPaletteResultRow(props: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
}) {
  const t = useT();
  const translateItem = isInterfaceResult(props.item.value);
  const title =
    translateItem && typeof props.item.title === "string" ? t(props.item.title) : props.item.title;
  const description =
    translateItem && typeof props.item.description === "string"
      ? t(props.item.description)
      : props.item.description;
  return (
    <div className="flex min-h-8 select-none items-center gap-2 rounded-sm px-2 py-1.5 text-base opacity-64 sm:min-h-7 sm:text-sm">
      {props.item.icon}
      {description || props.item.threadContentMatch ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
            {props.item.titleLeadingContent}
            <span className="truncate">{title}</span>
          </span>
          {props.item.threadContentMatch ? (
            <ThreadSearchMatchExcerpt match={props.item.threadContentMatch} />
          ) : null}
          {description ? (
            <span className="min-w-0 text-muted-foreground/70 text-xs">{description}</span>
          ) : null}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-foreground">
          {props.item.titleLeadingContent}
          <span className="truncate">{title}</span>
        </span>
      )}
      {props.item.titleTrailingContent}
    </div>
  );
}

function CommandPaletteResultRow(props: {
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
  isActive: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem | CommandPaletteSubmenuItem) => void;
}) {
  const t = useT();
  const translateItem = isInterfaceResult(props.item.value);
  const title =
    translateItem && typeof props.item.title === "string" ? t(props.item.title) : props.item.title;
  const description =
    translateItem && typeof props.item.description === "string"
      ? t(props.item.description)
      : props.item.description;
  const shortcutLabel = props.item.shortcutCommand
    ? shortcutLabelForCommand(props.keybindings, props.item.shortcutCommand)
    : null;

  return (
    <CommandItem
      value={props.item.value}
      active={props.isActive}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onExecuteItem(props.item);
      }}
    >
      {props.item.icon}
      {description || props.item.threadContentMatch ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
            {props.item.titleLeadingContent}
            <span className="truncate">{title}</span>
          </span>
          {props.item.threadContentMatch ? (
            <ThreadSearchMatchExcerpt match={props.item.threadContentMatch} />
          ) : null}
          {description ? (
            <span className="min-w-0 text-muted-foreground/70 text-xs">{description}</span>
          ) : null}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-foreground">
          {props.item.titleLeadingContent}
          <span className="truncate">{title}</span>
        </span>
      )}
      {props.item.titleTrailingContent}
      {props.item.timestamp ? (
        <span className="min-w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground/70">
          {props.item.timestamp}
        </span>
      ) : null}
      {shortcutLabel ? <CommandShortcut>{shortcutLabel}</CommandShortcut> : null}
      {props.item.kind === "submenu" ? (
        <ChevronRightIcon className="-me-0.5 ms-auto size-4 shrink-0 text-muted-foreground/70" />
      ) : null}
    </CommandItem>
  );
}
