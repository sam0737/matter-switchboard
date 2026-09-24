import { Box, Text, useInput, useWindowSize, type Key } from "ink";
import { useState } from "react";
import { KeyHints } from "./hint.js";
import { FittedLine } from "./line.js";
import { layoutResult, moveScroll, type ScrollMove } from "./scroll.js";

export function promptInstanceKey(input: {
  title: string;
  label: string;
  hidden?: boolean;
}): string {
  return `${input.title}\n${input.label}\n${input.hidden === true ? "hidden" : "plain"}`;
}

export function Prompt(props: {
  title: string;
  label: string;
  hidden?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  return <PromptFields key={promptInstanceKey(props)} {...props} />;
}

function PromptFields(props: {
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
      <KeyHints
        items={[
          { key: "enter", action: "confirm", color: "green" },
          { key: "esc", action: "cancel", color: "yellow" },
        ]}
      />
    </Box>
  );
}

export function Result(props: { title: string; body: string; onBack: () => void }) {
  const { columns, rows } = useWindowSize();
  return <ResultPane {...props} columns={columns} rows={rows} />;
}

export function ResultPane(props: {
  title: string;
  body: string;
  columns: number;
  rows: number;
  onBack: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const [body, setBody] = useState(props.body);
  const bodyChanged = body !== props.body;
  if (bodyChanged) {
    setBody(props.body);
    setOffset(0);
  }
  const layout = layoutResult({
    title: props.title,
    body: props.body,
    columns: props.columns,
    rows: props.rows,
    offset: bodyChanged ? 0 : offset,
  });
  useInput((_, key) => {
    if (key.escape || key.return) {
      props.onBack();
      return;
    }
    const move = scrollMove(key);
    if (!move || layout.fits) return;
    setOffset((current) => moveScroll(current, move, layout.total, layout.height));
  });
  return (
    <Box flexDirection="column" width={props.columns}>
      {layout.titleLines.map((line, index) => (
        <FittedLine key={`title-${index}`} width={props.columns} bold>
          {line}
        </FittedLine>
      ))}
      {layout.lines.map((line, index) => (
        <FittedLine key={`line-${layout.offset + index}`} width={props.columns}>
          {line}
        </FittedLine>
      ))}
      {layout.fits ? null : (
        <FittedLine width={props.columns} dimColor>
          {layout.status}
        </FittedLine>
      )}
      <KeyHints
        items={[
          { key: "enter", action: "back" },
          { key: "esc", action: "back", color: "yellow" },
        ]}
      />
    </Box>
  );
}

function scrollMove(key: Key): ScrollMove | undefined {
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.pageUp) return "pageup";
  if (key.pageDown) return "pagedown";
  if (key.home) return "home";
  if (key.end) return "end";
  return undefined;
}

export function Busy(props: { message?: string }) {
  return (
    <Box flexDirection="column">
      <Text>{props.message ?? "Working…"}</Text>
    </Box>
  );
}
