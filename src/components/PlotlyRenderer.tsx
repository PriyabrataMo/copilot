"use client";
import React, { useEffect, useRef } from "react";

type Props = {
  figures: string[]; // array of fig.to_json() strings
};

export function PlotlyRenderer({ figures }: Props) {
  const containerRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    let cancelled = false;
    async function render() {
      try {
        const mod = (await import("plotly.js-dist-min")) as unknown as {
          default?: unknown;
          newPlot: (
            el: HTMLElement,
            data: unknown,
            layout?: unknown,
            config?: unknown
          ) => Promise<void>;
        };
        type PlotlyType = {
          newPlot: (
            el: HTMLElement,
            data: unknown,
            layout?: unknown,
            config?: unknown
          ) => Promise<void>;
        };
        const candidate = (mod as unknown as { default?: unknown })?.default ?? mod;
        const Plotly = candidate as unknown as PlotlyType;
        for (let i = 0; i < figures.length; i += 1) {
          const container = containerRefs.current[i];
          if (!container) continue;
          let parsed: { data?: unknown; layout?: unknown; config?: unknown } | null = null;
          try {
            parsed = JSON.parse(figures[i]);
          } catch (e) {
            // skip invalid figure
            continue;
          }
          if (cancelled) return;
          await Plotly.newPlot(
            container,
            parsed?.data ?? [],
            parsed?.layout ?? {},
            parsed?.config ?? {}
          );
        }
      } catch (e) {
        // ignore
      }
    }
    render();
    return () => {
      cancelled = true;
    };
  }, [figures]);

  return (
    <div className="space-y-4">
      {figures.map((_, idx) => (
        <div
          key={idx}
          ref={(el: HTMLDivElement | null) => {
            containerRefs.current[idx] = el;
          }}
          className="w-full min-h-[320px] border rounded bg-white"
        />
      ))}
    </div>
  );
}


