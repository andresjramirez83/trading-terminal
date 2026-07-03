import { useEffect, useState } from "react";

type TradingNumberInputProps = {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  placeholder?: string;
};

export default function TradingNumberInput({
  value,
  onChange,
  disabled,
  placeholder,
}: TradingNumberInputProps) {
  const [text, setText] = useState("");

  useEffect(() => {
    if (document.activeElement instanceof HTMLInputElement) return;
    setText(Number.isFinite(value) && value > 0 ? String(value) : "");
  }, [value]);

  return (
    <input
      type="text"
      inputMode="decimal"
      disabled={disabled}
      value={text}
      placeholder={placeholder}
      onChange={(event) => {
        const next = event.target.value;

        if (!/^\d*\.?\d*$/.test(next)) return;

        setText(next);

        const parsed = Number(next);
        if (next !== "" && next !== "." && Number.isFinite(parsed)) {
          onChange(parsed);
        }

        if (next === "") {
          onChange(0);
        }
      }}
      onFocus={(event) => {
        setText(Number.isFinite(value) && value > 0 ? String(value) : "");
        event.currentTarget.select();
      }}
      onBlur={() => {
        setText(Number.isFinite(value) && value > 0 ? String(value) : "");
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