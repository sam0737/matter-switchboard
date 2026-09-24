import { Box, Text, useApp, useInput } from "ink";
import { formatNumber } from "./format.js";
import { flattenSockets, type TuiState } from "./model.js";

export function Dashboard(props: {
  state: TuiState;
  onMove: (delta: number) => void;
  onToggle: () => void;
  onConfigure: () => void;
}) {
  const { exit } = useApp();
  const rows = flattenSockets(props.state.dashboard.strips);
  useInput((input, key) => {
    if (input === "q") {
      exit();
      return;
    }
    if (input === "c") {
      props.onConfigure();
      return;
    }
    if (key.upArrow) {
      props.onMove(-1);
      return;
    }
    if (key.downArrow) {
      props.onMove(1);
      return;
    }
    if (key.return) props.onToggle();
  });
  const { dashboard } = props.state;
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>Matter Switchboard</Text>
        <Text> </Text>
        {dashboard.serverDown ? (
          <Text color="red">server down</Text>
        ) : (
          <Text color="green">live</Text>
        )}
      </Box>
      {dashboard.notice ? <Text color="red">{dashboard.notice}</Text> : null}
      {dashboard.strips.length === 0 && !dashboard.serverDown ? (
        <Text dimColor>No devices. Press c to configure (add a mock or commission a strip).</Text>
      ) : null}
      {dashboard.strips.map((strip, stripIndex) => {
        const focusInStrip = rows[dashboard.focusIndex]?.stripIndex === stripIndex;
        return (
          <Box key={strip.slug} flexDirection="column" marginTop={1}>
            <Text>
              <Text bold>{strip.slug}</Text>
              <Text dimColor> {strip.kind} </Text>
              <Text color={strip.available ? "green" : "red"}>
                {strip.available ? "reachable" : "unreachable"}
              </Text>
              {strip.error ? <Text color="red"> {strip.error}</Text> : null}
            </Text>
            {strip.endpoints.map((endpoint, endpointIndex) => {
              const focused =
                focusInStrip && rows[dashboard.focusIndex]?.endpointIndex === endpointIndex;
              const power = endpoint.pending ? "…" : endpoint.on ? "ON" : "off";
              const powerColor = endpoint.pending ? "yellow" : endpoint.on ? "green" : undefined;
              return (
                <Text key={endpoint.endpointId} {...(focused ? { color: "cyan" as const } : {})}>
                  {focused ? "> " : "  "}
                  {String(endpoint.endpointId).padStart(2)} {endpoint.name.padEnd(16)}{" "}
                  <Text {...(powerColor ? { color: powerColor } : {})}>{power.padEnd(3)}</Text>
                  {"  "}
                  {formatNumber(endpoint.currentAmps, "A")}
                  {"  "}
                  {formatNumber(endpoint.voltageVolts, "V")}
                  {"  "}
                  {formatNumber(endpoint.activePowerWatts, "W")}
                </Text>
              );
            })}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>enter toggle c configure q quit</Text>
      </Box>
    </Box>
  );
}
