import { Box, Text, useInput } from "ink";
import { useState } from "react";

export interface MenuItem {
  id: string;
  label: string;
}

export function Menu(props: {
  title: string;
  items: MenuItem[];
  onSelect: (id: string) => void;
  onBack?: () => void;
  hint?: string;
}) {
  const [index, setIndex] = useState(0);
  const count = props.items.length;
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
    <Box flexDirection="column">
      <Text bold>{props.title}</Text>
      {count === 0 ? <Text dimColor>Nothing to list.</Text> : null}
      {props.items.map((item, itemIndex) => (
        <Text key={item.id} {...(itemIndex === index ? { color: "cyan" as const } : {})}>
          {itemIndex === index ? "> " : "  "}
          {item.label}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text dimColor>{props.hint ?? "arrows move   enter select   esc back"}</Text>
      </Box>
    </Box>
  );
}
