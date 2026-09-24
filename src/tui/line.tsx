import { Box, Text } from "ink";

export function FittedLine(props: {
  width: number;
  children: string;
  bold?: boolean;
  dimColor?: boolean;
  color?: "cyan";
}) {
  return (
    <Box width={props.width} height={1} overflow="hidden">
      <Text
        wrap="truncate"
        {...(props.bold ? { bold: true as const } : {})}
        {...(props.dimColor ? { dimColor: true as const } : {})}
        {...(props.color ? { color: props.color } : {})}
      >
        {props.children.length === 0 ? " " : props.children}
      </Text>
    </Box>
  );
}
