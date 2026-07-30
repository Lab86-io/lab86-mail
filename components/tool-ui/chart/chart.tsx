"use client";

import { useMemo, useCallback, memo } from "react";
import {
  BarChart,
  AreaChart,
  PieChart,
  LineChart,
  Bar,
  Area,
  Pie,
  Cell,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";

import {
  cn,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  type ChartConfig,
} from "./_adapter";
import type { ChartProps } from "./schema";

const DEFAULT_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export const Chart = memo(function Chart({
  id,
  type,
  title,
  description,
  data,
  xKey,
  series,
  colors,
  showLegend = false,
  showGrid = true,
  className,
  onDataPointClick,
}: ChartProps) {
  const palette = colors?.length ? colors : DEFAULT_COLORS;

  const seriesColors = useMemo(
    () =>
      series.map(
        (seriesItem, index) =>
          seriesItem.color ?? palette[index % palette.length],
      ),
    [series, palette],
  );

  const chartConfig: ChartConfig = useMemo(
    () =>
      Object.fromEntries(
        series.map((seriesItem, index) => [
          seriesItem.key,
          {
            label: seriesItem.label,
            color: seriesColors[index],
          },
        ]),
      ),
    [series, seriesColors],
  );

  const handleDataPointClick = useCallback(
    (
      seriesKey: string,
      seriesLabel: string,
      payload: Record<string, unknown>,
      index: number,
    ) => {
      onDataPointClick?.({
        seriesKey,
        seriesLabel,
        xValue: payload[xKey],
        yValue: payload[seriesKey],
        index,
        payload,
      });
    },
    [onDataPointClick, xKey],
  );

  const chartContent = type === "donut" ? (
    <ChartContainer
      config={chartConfig}
      className="min-h-[200px] w-full"
      data-tool-ui-id={id}
    >
      <PieChart accessibilityLayer>
        <ChartTooltip content={<ChartTooltipContent />} />
        <Pie
          data={data}
          dataKey={series[0].key}
          nameKey={xKey}
          innerRadius="52%"
          outerRadius="82%"
          paddingAngle={2}
          onClick={(payload, index) => {
            handleDataPointClick(
              series[0].key,
              series[0].label,
              payload as unknown as Record<string, unknown>,
              index,
            );
          }}
          cursor={onDataPointClick ? "pointer" : undefined}
        >
          {data.map((_, index) => (
            <Cell key={`${id}-slice-${index}`} fill={palette[index % palette.length]} />
          ))}
        </Pie>
        {showLegend && <ChartLegend content={<ChartLegendContent />} />}
      </PieChart>
    </ChartContainer>
  ) : (
    <ChartContainer
      config={chartConfig}
      className="min-h-[200px] w-full"
      data-tool-ui-id={id}
    >
      {type === "line" ? (
        <LineChart data={data} accessibilityLayer>
          {showGrid && <CartesianGrid vertical={false} />}
          <XAxis dataKey={xKey} tickLine={false} tickMargin={10} axisLine={false} />
          <YAxis tickLine={false} axisLine={false} tickMargin={10} />
          <ChartTooltip content={<ChartTooltipContent />} />
          {showLegend && <ChartLegend content={<ChartLegendContent />} />}
          {series.map((s, i) => (
            <Line
              key={s.key}
              dataKey={s.key}
              type="monotone"
              stroke={seriesColors[i]}
              strokeWidth={2}
              dot={{ r: 4, cursor: onDataPointClick ? "pointer" : undefined }}
              activeDot={
                {
                  r: 6,
                  cursor: onDataPointClick ? "pointer" : undefined,
                  onClick: ((
                    _: unknown,
                    dotData: {
                      payload: Record<string, unknown>;
                      index: number;
                    },
                  ) => {
                    handleDataPointClick(
                      s.key,
                      s.label,
                      dotData.payload,
                      dotData.index,
                    );
                  }) as unknown as React.MouseEventHandler,
                } as unknown as NonNullable<
                  React.ComponentProps<typeof Line>["activeDot"]
                >
              }
            />
          ))}
        </LineChart>
      ) : type === "area" ? (
        <AreaChart data={data} accessibilityLayer>
          {showGrid && <CartesianGrid vertical={false} />}
          <XAxis dataKey={xKey} tickLine={false} tickMargin={10} axisLine={false} />
          <YAxis tickLine={false} axisLine={false} tickMargin={10} />
          <ChartTooltip content={<ChartTooltipContent />} />
          {showLegend && <ChartLegend content={<ChartLegendContent />} />}
          {series.map((s, i) => (
            <Area
              key={s.key}
              dataKey={s.key}
              type="monotone"
              stroke={seriesColors[i]}
              fill={seriesColors[i]}
              fillOpacity={0.2}
              strokeWidth={2}
            />
          ))}
        </AreaChart>
      ) : (
        <BarChart data={data} accessibilityLayer>
        {showGrid && <CartesianGrid vertical={false} />}
        <XAxis
          dataKey={xKey}
          tickLine={false}
          tickMargin={10}
          axisLine={false}
        />
        <YAxis tickLine={false} axisLine={false} tickMargin={10} />
        <ChartTooltip content={<ChartTooltipContent />} />
        {showLegend && <ChartLegend content={<ChartLegendContent />} />}

        {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              fill={seriesColors[i]}
              stackId={type === "stacked_bar" ? "brief-stack" : undefined}
              radius={4}
              onClick={(data) => {
                // Recharts 3 types omit index/payload on BarRectangleItem but
                // they exist at runtime.
                const item = data as unknown as {
                  payload: Record<string, unknown>;
                  index: number;
                };
                handleDataPointClick(s.key, s.label, item.payload, item.index);
              }}
              cursor={onDataPointClick ? "pointer" : undefined}
            />
          ))}
        </BarChart>
      )}
    </ChartContainer>
  );

  return (
    <Card
      className={cn("w-full min-w-80", className)}
      data-tool-ui-id={id}
      data-slot="chart"
    >
      {(title || description) && (
        <CardHeader>
          {title && <CardTitle className="text-pretty">{title}</CardTitle>}
          {description && (
            <CardDescription className="text-pretty">
              {description}
            </CardDescription>
          )}
        </CardHeader>
      )}
      <CardContent>{chartContent}</CardContent>
    </Card>
  );
});
