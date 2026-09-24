import { Box, Text, useInput } from "ink";
import { useState } from "react";

export function Prompt(props: {
  title: string;
  label: string;
  hidden?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.return) {
      props.onSubmit(value.trim());
      return;
    }
    if (key.backspace || key.delete) {
      setValue((current) => current.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta) return;
    const submitted = input.includes("\r") || input.includes("\n");
    const printable = [...input].filter((character) => character >= " ").join("");
    if (submitted) {
      props.onSubmit((value + printable).trim());
      return;
    }
    if (printable) setValue((current) => current + printable);
  });
  const shown = props.hidden ? "•".repeat(value.length) : value;
  return (
    <Box flexDirection="column">
      <Text bold>{props.title}</Text>
      <Text>{props.label}</Text>
      <Text>
        {shown}
        <Text color="cyan">█</Text>
      </Text>
      <Box marginTop={1}>
        <Text dimColor>enter confirm esc cancel</Text>
      </Box>
    </Box>
  );
}

export function Result(props: { title: string; body: string; onBack: () => void }) {
  useInput((_, key) => {
    if (key.escape || key.return) props.onBack();
  });
  return (
    <Box flexDirection="column">
      <Text bold>{props.title}</Text>
      <Text>{props.body}</Text>
      <Box marginTop={1}>
        <Text dimColor>esc or enter back</Text>
      </Box>
    </Box>
  );
}

export function Busy(props: { message?: string }) {
  return (
    <Box flexDirection="column">
      <Text>{props.message ?? "Working…"}</Text>
    </Box>
  );
}
