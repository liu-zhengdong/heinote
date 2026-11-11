import { Plus, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { MenuItem, MenuList } from "../../components/Menu";
import { Select } from "../../components/Select";
import type { DatabaseProperty, FilterCondition, FilterGroup, ViewFilter } from "../../core/types";
import {
  defaultFilterOp, FILTER_OPS, FILTER_OP_LABELS, filterNeedsValue, propertyOptions,
} from "./database-model";
import { OptionTag } from "./properties";

/** A column a condition can be about: its id, name and mark. */
export interface FilterColumn {
  id: string;
  label: string;
  icon: ReactNode;
}

/* A view's filters, as Notion's panel: a line per condition — Where, then
   And — each its property, its operator and the value it compares to, and ×
   to take it away. At most one group sits among them, its conditions joined
   by its own And/Or; everything is AND-ed together. A value is offered the
   way the property asks: options to pick, a day to point, a number or words
   to type — and nothing at all for the empties. */

/** The value a condition opens with when its property or operator wants
 *  one: the first option, checked, or just blank words. */
function defaultValue(property: DatabaseProperty, op: string): string | undefined {
  if (!filterNeedsValue(op)) return undefined;
  if (property.type === "select" || property.type === "status" || property.type === "multi_select") {
    return propertyOptions(property)[0] ?? "";
  }
  if (property.type === "checkbox") return "true";
  return "";
}

/** A condition rebuilt for a new property or operator: the operator valid
 *  for the type, the value present only when the operator asks for one. */
function normalize(condition: FilterCondition, property: DatabaseProperty | undefined, op?: string): FilterCondition {
  const next: FilterCondition = { ...condition, ...(op !== undefined ? { op } : {}) };
  const type = property?.type;
  if (!type) return next;
  const active = next.op && FILTER_OPS[type].includes(next.op) ? next.op : defaultFilterOp(type);
  next.op = active;
  const value = filterNeedsValue(active) ? (next.value ?? defaultValue(property, active) ?? "") : undefined;
  if (value === undefined) delete next.value;
  else next.value = value;
  return next;
}

/** The words, day or count a condition compares to, in the shape the
 *  property gives it. */
function ConditionValue({
  condition,
  property,
  onChange,
}: {
  condition: FilterCondition;
  property: DatabaseProperty | undefined;
  onChange(value: string): void;
}) {
  if (!property) return <input className="filter-panel__input" value="" aria-label="Filter value" disabled />;
  const op = condition.op ?? defaultFilterOp(property.type);
  if (!filterNeedsValue(op)) return null;
  if (property.type === "select" || property.type === "status" || property.type === "multi_select") {
    return (
      <Select
        className="filter-panel__field"
        size="compact"
        aria-label="Filter value"
        value={condition.value ?? ""}
        onValueChange={onChange}
        options={propertyOptions(property).map((option) => ({
          value: option, label: option, content: <OptionTag property={property} value={option} />,
        }))}
      />
    );
  }
  if (property.type === "checkbox") {
    return (
      <Select
        className="filter-panel__field"
        size="compact"
        aria-label="Filter value"
        value={condition.value ?? "true"}
        onValueChange={onChange}
        options={[{ value: "true", label: "Checked" }, { value: "false", label: "Unchecked" }]}
      />
    );
  }
  if (property.type === "date" || property.type === "created_time" || property.type === "last_edited_time") {
    return (
      <input
        className="filter-panel__input"
        type="date"
        aria-label="Filter day"
        value={condition.value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  return (
    <input
      className="filter-panel__input"
      type={property.type === "number" ? "number" : "text"}
      aria-label="Filter value"
      placeholder="Type a value…"
      value={condition.value ?? ""}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** One condition: a lead word (Where, or the group's And/Or), then its
 *  property, operator and value. */
function ConditionRow({
  condition,
  lead,
  columns,
  properties,
  onEdit,
  onRemove,
}: {
  condition: FilterCondition;
  lead: ReactNode;
  columns: readonly FilterColumn[];
  properties: readonly DatabaseProperty[];
  onEdit(next: FilterCondition): void;
  onRemove?(): void;
}) {
  const property = properties.find((item) => item.id === condition.property_id);
  const ops = property ? FILTER_OPS[property.type] : [];
  return (
    <div className="cond">
      <span className="cond__lead">{lead}</span>
      <Select
        className="filter-panel__field filter-panel__field--property"
        size="compact"
        aria-label="Filter property"
        placeholder="Pick a property"
        value={condition.property_id}
        onValueChange={(property_id) => onEdit(normalize({ ...condition, property_id }, properties.find((item) => item.id === property_id)))}
        options={columns.map((column) => ({
          value: column.id, label: column.label,
          content: <><span className="filter-panel__mark" aria-hidden="true">{column.icon}</span>{column.label}</>,
        }))}
      />
      <Select
        className="filter-panel__field filter-panel__field--op"
        size="compact"
        aria-label="Filter operator"
        disabled={!property}
        value={condition.op ?? ""}
        onValueChange={(op) => onEdit(normalize(condition, property, op))}
        options={ops.map((item) => ({ value: item, label: FILTER_OP_LABELS[item] ?? item }))}
      />
      <ConditionValue condition={condition} property={property} onChange={(value) => onEdit({ ...condition, value })} />
      {onRemove ? (
        <button type="button" className="icon-btn icon-btn--sm cond__remove" aria-label="Remove condition" onClick={onRemove}>
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}

/** A view's conditions and its one group, edited together. Every change is
 *  the whole list, handed back — the panel never saves a half-made row
 *  (Add seeds a complete condition). */
export function FilterPanel({
  items,
  columns,
  properties,
  onChange,
}: {
  items: readonly ViewFilter[];
  columns: readonly FilterColumn[];
  properties: readonly DatabaseProperty[];
  onChange(next: ViewFilter[]): void;
}) {
  const groupAt = items.findIndex((item) => "conditions" in item);
  const draft = !items.length;
  const shown: ViewFilter[] = items.length ? [...items] : [{ property_id: "" }];

  const setItem = (index: number, item: ViewFilter | null) =>
    onChange(items.flatMap((held, at) => (at === index ? (item ? [item] : []) : [held])));
  const setGroup = (group: FilterGroup, patch: Partial<FilterGroup>) => setItem(groupAt, { ...group, ...patch });
  /* A new condition is born complete: the first property, its own first
   *  operator and a value it can hold. */
  const fresh = (): FilterCondition | null => {
    const property = properties.find((item) => FILTER_OPS[item.type].length);
    if (!property) return null;
    return normalize({ property_id: property.id }, property);
  };
  const add = (intoGroup: boolean) => {
    const made = fresh();
    if (!made) return;
    if (intoGroup && groupAt >= 0) {
      const group = items[groupAt] as FilterGroup;
      setGroup(group, { conditions: [...group.conditions, made] });
      return;
    }
    if (intoGroup) onChange([...items, { logic: "and", conditions: [made] }]);
    else onChange([...items, made]);
  };

  return (
    <div className="filter-panel">
      <div className="filter-panel__title">Filter</div>
      <div className="filter-panel__lines">
        {shown.map((item, index) => "conditions" in item ? (
          <div key={index} className="group-box">
            <div className="group-box__head">
              <span className="cond__lead">And</span>
              <Select
                className="filter-panel__field filter-panel__field--logic"
                size="compact"
                aria-label="Group logic"
                value={item.logic}
                onValueChange={(logic) => setGroup(item, { logic: logic as FilterGroup["logic"] })}
                options={[{ value: "and", label: "every condition" }, { value: "or", label: "any condition" }]}
              />
              <button type="button" className="icon-btn icon-btn--sm cond__remove" aria-label="Remove group" onClick={() => setItem(index, null)}>
                <X size={14} />
              </button>
            </div>
            {item.conditions.map((condition, at) => (
              <ConditionRow
                key={at}
                condition={condition}
                lead={at === 0 ? "Where" : item.logic === "or" ? "Or" : "And"}
                columns={columns}
                properties={properties}
                onEdit={(next) => setGroup(item, { conditions: item.conditions.map((held, pos) => (pos === at ? next : held)) })}
                onRemove={() => {
                  const left = item.conditions.filter((_, pos) => pos !== at);
                  // The group's last condition gone, the group goes with it.
                  if (left.length) setGroup(item, { conditions: left });
                  else setItem(index, null);
                }}
              />
            ))}
            <button type="button" className="filter-panel__add-in" onClick={() => add(true)}>
              <Plus size={13} />Add condition
            </button>
          </div>
        ) : (
          <ConditionRow
            key={index}
            condition={item as FilterCondition}
            lead={index === 0 ? "Where" : "And"}
            columns={columns}
            properties={properties}
            onEdit={(next) => (draft ? onChange([next]) : setItem(index, next))}
            onRemove={draft ? undefined : () => setItem(index, null)}
          />
        ))}
      </div>
      <MenuList label="Filters">
        <MenuItem
          icon={<Plus size={16} />}
          label="Add filter"
          disabled={!properties.length}
          onSelect={() => add(false)}
        />
        <MenuItem
          icon={<Plus size={16} />}
          label="Add filter group"
          disabled={!properties.length || groupAt >= 0}
          onSelect={() => add(true)}
        />
        <MenuItem
          icon={<Trash2 size={16} />}
          label="Delete filter"
          disabled={!items.length}
          onSelect={() => onChange([])}
        />
      </MenuList>
    </div>
  );
}
