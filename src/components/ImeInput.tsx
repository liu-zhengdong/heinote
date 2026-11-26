import {
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type FocusEvent,
  type InputHTMLAttributes,
  type Ref,
} from "react";

/**
 * Keeps a controlled `<input>` or `<textarea>` synchronized with external state
 * without disrupting CJK IME composition (such as Windows Microsoft Pinyin).
 *
 * While an IME composition is active, intermediate preedit text stays in local
 * draft state instead of writing through `onCommit`, so external writes, undo
 * steps, and async snapshots never overwrite `element.value` mid-composition.
 */
export function useImeValue<E extends HTMLInputElement | HTMLTextAreaElement>(
  value: string,
  onCommit: (next: string) => void,
) {
  const [draft, setDraft] = useState<string | null>(null);
  const composing = useRef(false);

  const flush = (next: string) => {
    composing.current = false;
    setDraft(null);
    if (next !== value) onCommit(next);
  };

  return {
    value: draft ?? value,
    onChange(event: ChangeEvent<E>) {
      const next = event.target.value;
      if (composing.current || (event.nativeEvent as InputEvent).isComposing) {
        composing.current = true;
        setDraft(next);
        return;
      }
      if (draft !== null) setDraft(null);
      onCommit(next);
    },
    onCompositionStart(event: CompositionEvent<E>) {
      composing.current = true;
      setDraft(event.currentTarget.value);
    },
    onCompositionEnd(event: CompositionEvent<E>) {
      flush(event.currentTarget.value);
    },
    onBlur(event: FocusEvent<E>) {
      if (composing.current) flush(event.currentTarget.value);
    },
  };
}

export interface ImeInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
  ref?: Ref<HTMLInputElement>;
  value: string;
  onValueChange(next: string): void;
}

export function ImeInput({
  value,
  onValueChange,
  onBlur,
  onCompositionStart,
  onCompositionEnd,
  ...rest
}: ImeInputProps) {
  const ime = useImeValue<HTMLInputElement>(value, onValueChange);
  return (
    <input
      {...rest}
      value={ime.value}
      onChange={ime.onChange}
      onCompositionStart={(event) => {
        ime.onCompositionStart(event);
        onCompositionStart?.(event);
      }}
      onCompositionEnd={(event) => {
        ime.onCompositionEnd(event);
        onCompositionEnd?.(event);
      }}
      onBlur={(event) => {
        ime.onBlur(event);
        onBlur?.(event);
      }}
    />
  );
}
