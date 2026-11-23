import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { isoDate } from "../../../core/inline-content";
import type { DatabaseProperty, NotePage } from "../../../core/types";
import {
  dateRange,
  localeWeekStart,
  monthGrid,
  propertyValue,
} from "../database-model";
import { fullPage, type LayoutProps } from "./shared";

export function CalendarLayout({
  rows,
  property,
  onOpen,
  onAdd,
  readOnly,
}: LayoutProps & { property: DatabaseProperty }) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const weekStart = useMemo(() => localeWeekStart(navigator.language), []);
  const days = monthGrid(cursor.year, cursor.month, weekStart);
  const today = isoDate(new Date());

  const byDay = useMemo(() => {
    const map = new Map<string, NotePage[]>();
    for (const row of rows) {
      const value = propertyValue(row, property);
      // A range sits on the day it starts.
      const start = dateRange(value)?.start;
      if (!start) continue;
      map.set(start, [...(map.get(start) ?? []), row]);
    }
    return map;
  }, [property, rows]);

  const month = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" })
    .format(new Date(cursor.year, cursor.month, 1));
  const weekdays = days.slice(0, 7).map((day) => new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(day));
  const step = (delta: number) => setCursor(({ year, month: current }) => {
    const next = new Date(year, current + delta, 1);
    return { year: next.getFullYear(), month: next.getMonth() };
  });

  return (
    <div className="db-cal">
      <div className="db-cal__bar">
        <strong className="db-cal__month">{month}</strong>
        <span className="db-cal__nav">
          <button type="button" className="icon-btn icon-btn--sm" aria-label="Previous month" onClick={() => step(-1)}>
            <ChevronLeft size={15} />
          </button>
          <button
            type="button"
            className="btn db-cal__today"
            onClick={() => {
              const now = new Date();
              setCursor({ year: now.getFullYear(), month: now.getMonth() });
            }}
          >
            Today
          </button>
          <button type="button" className="icon-btn icon-btn--sm" aria-label="Next month" onClick={() => step(1)}>
            <ChevronRight size={15} />
          </button>
        </span>
      </div>
      <div className="db-cal__grid" role="grid" aria-label={month}>
        {weekdays.map((weekday) => <span key={weekday} className="db-cal__weekday" role="columnheader">{weekday}</span>)}
        {days.map((day) => {
          const key = isoDate(day);
          const items = byDay.get(key) ?? [];
          const outside = day.getMonth() !== cursor.month;
          const label = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" }).format(day);
          return (
            <div
              key={key}
              role="gridcell"
              aria-label={label}
              className={`db-cal__day ${outside ? "is-outside" : ""} ${key === today ? "is-today" : ""}`}
            >
              <span className="db-cal__date">{day.getDate()}</span>
              {readOnly ? null : (
                <button
                  type="button"
                  className="db-cal__add"
                  aria-label={`New row on ${label}`}
                  onClick={() => onAdd({ [property.id]: key })}
                >
                  <Plus size={12} />
                </button>
              )}
              {items.slice(0, 3).map((row) => (
                <button type="button" key={row.id} className="db-cal__item" data-page-id={row.id} data-block-name={row.id} onClick={(event) => onOpen(row.id, fullPage(event))}>
                  {row.title || "Untitled"}
                </button>
              ))}
              {items.length > 3 ? <span className="db-cal__more">+{items.length - 3} more</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
