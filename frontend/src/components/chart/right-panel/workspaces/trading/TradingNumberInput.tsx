import { useEffect, useRef, useState } from "react";

type TradingNumberInputProps = {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  placeholder?: string;
};

function formatValue(value: number): string {
  return Number.isFinite(value) && value > 0 ? String(value) : "";
}

function parseText(value: string): number | null {
  const trimmed = value.trim();

  if (trimmed === "" || trimmed === ".") {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export default function TradingNumberInput({
  value,
  onChange,
  disabled,
  placeholder,
}: TradingNumberInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isEditingRef = useRef(false);
  const lastCommittedValueRef = useRef<number>(
    Number.isFinite(value) ? value : 0,
  );

  const [text, setText] = useState(() => formatValue(value));

  useEffect(() => {
    if (isEditingRef.current) return;

    const nextValue = Number.isFinite(value) ? value : 0;

    if (nextValue === lastCommittedValueRef.current) {
      return;
    }

    lastCommittedValueRef.current = nextValue;
    setText(formatValue(nextValue));
  }, [value]);

  function publish(nextText: string): void {
    const parsed = parseText(nextText);

    if (parsed == null) {
      if (nextText.trim() === "") {
        lastCommittedValueRef.current = 0;
        onChange(0);
      }
      return;
    }

    lastCommittedValueRef.current = parsed;
    onChange(parsed);
  }

  function commit(nextText: string): void {
    const trimmed = nextText.trim();

    if (trimmed === "" || trimmed === ".") {
      lastCommittedValueRef.current = 0;
      setText("");
      onChange(0);
      return;
    }

    const parsed = Number(trimmed);

    if (!Number.isFinite(parsed)) {
      setText(formatValue(lastCommittedValueRef.current));
      return;
    }

    lastCommittedValueRef.current = parsed;
    setText(String(parsed));
    onChange(parsed);
  }

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      disabled={disabled}
      value={text}
      placeholder={placeholder}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();

        if (event.key === "Enter") {
          event.preventDefault();
          commit(text);
          inputRef.current?.blur();
          return;
        }

        if (event.key === "Escape") {
          event.preventDefault();
          const restored = formatValue(lastCommittedValueRef.current);
          setText(restored);
          inputRef.current?.blur();
        }
      }}
      onFocus={(event) => {
        event.stopPropagation();
        isEditingRef.current = true;
      }}
      onChange={(event) => {
        const next = event.target.value;

        if (!/^\d*\.?\d*$/.test(next)) return;

        setText(next);
        publish(next);
      }}
      onBlur={() => {
        commit(text);
        isEditingRef.current = false;
      }}
      style={styles.input}
    />
  );
}

const styles: Record<string, React.CSSProperties> = {
  input: {
    width: "100%",
    boxSizing: "border-box",
    background: "rgba(2,6,23,.95)",
    border: "1px solid rgba(148,163,184,.24)",
    borderRadius: 11,
    color: "#e5e7eb",
    padding: "9px 10px",
    outline: "none",
    fontSize: 13,
    fontWeight: 800,
  },
};