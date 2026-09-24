import { Box, useInput, useWindowSize } from "ink";
import { useState } from "react";
import { KeyHints, type KeyHint } from "./hint.js";
import { FittedLine } from "./line.js";
import { rangeStatus, revealOffset, visibleSlice } from "./scroll.js";

const MENU_CHROME_ROWS = 3;

export interface MenuItem {
  id: string;
  label: string;
}

export function menuInstanceKey(input: { title: string; items: Array<{ id: string }> }): string {
  return `${input.title}\n${input.items.map((item) => item.id).join("\n")}`;
}

export function Menu(props: {
  title: string;
  items: MenuItem[];
  onSelect: (id: string) => void;
  onBack?: () => void;
  hint?: KeyHint[];
}) {
  return <MenuList key={menuInstanceKey(props)} {...props} />;
}

function MenuList(props: {
  title: string;
  items: MenuItem[];
  onSelect: (id: string) => void;
  onBack?: () => void;
  hint?: KeyHint[];
}) {
  const { columns, rows } = useWindowSize();
  const [index, setIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const count = props.items.length;
  const probe = visibleSlice(props.items, rows, MENU_CHROME_ROWS, 0);
  const revealed = revealOffset(offset, index, count, probe.height);
  const view = visibleSlice(props.items, rows, MENU_CHROME_ROWS, revealed);
  if (view.offset !== offset) setOffset(view.offset);
  useInput((input, key) => {
    if ((key.escape || input === "q") && props.onBack) {
      props.onBack();
      return;
    }
    if (count === 0) return;
    if (key.upArrow) {
      setIndex((current) => (current + count - 1) % count);
      return;
    }
    if (key.downArrow) {
      setIndex((current) => (current + 1) % count);
      return;
    }
    if (key.return) {
      const item = props.items[index];
      if (item) props.onSelect(item.id);
    }
  });
  return (
    <Box flexDirection="column" width={columns}>
      <FittedLine width={columns} bold>
        {props.title}
      </FittedLine>
      {count === 0 ? (
        <FittedLine width={columns} dimColor>
          Nothing to list.
        </FittedLine>
      ) : null}
      {view.items.map((item, visibleIndex) => {
        const itemIndex = view.offset + visibleIndex;
        const selected = itemIndex === index;
        return (
          <FittedLine
            key={item.id}
            width={columns}
            {...(selected ? { color: "cyan" as const } : {})}
          >
            {`${selected ? "> " : "  "}${item.label}`}
          </FittedLine>
        );
      })}
      {view.fits ? null : (
        <FittedLine width={columns} dimColor>
          {rangeStatus(view.offset, view.items.length, view.total)}
        </FittedLine>
      )}
      <KeyHints
        items={
          props.hint ?? [
            { key: "arrows", action: "move" },
            { key: "enter", action: "select" },
            { key: "esc", action: "back", color: "yellow" },
          ]
        }
      />
    </Box>
  );
}
