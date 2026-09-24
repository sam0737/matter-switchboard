import { Box, Text } from "ink";

export interface KeyHint {
  key: string;
  action: string;
  color?: "cyan" | "green" | "yellow";
}

export function KeyHints(props: { items: KeyHint[] }) {
  return (
    <Box marginTop={1} columnGap={3}>
      {props.items.map((item, index) => (
        <Text key={`${item.key}-${item.action}-${index}`}>
          <Text bold color={item.color ?? "cyan"}>
            {item.key}
          </Text>
          <Text dimColor> {item.action}</Text>
        </Text>
      ))}
    </Box>
  );
}
