import { useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { Modal } from "./Modal";
import { Btn } from "./Button";

/**
 * The themed, dismissable, keyboard-friendly confirm this app otherwise has —
 * `window.confirm`/`window.prompt` are unstyled, block the JS thread, ignore
 * dark mode, and are the one place in the app that looks like a different
 * program. Pair with useConfirm() below rather than local state when the
 * call site has nothing else to track.
 *
 * `prompt` (optional) turns this into a text-input confirm: pass its initial
 * value and onConfirm receives the typed string instead of nothing.
 */
export function ConfirmDialog({
  open, title = "Are you sure?", body, confirmLabel = "Confirm", cancelLabel = "Cancel",
  danger = false, loading = false, prompt, onConfirm, onCancel,
}) {
  const { theme } = useTheme();
  const [value, setValue] = useState(prompt?.initial ?? "");

  if (!open) return null;
  const field = {
    width: "100%", padding: "8px 10px", borderRadius: 8, border: `1px solid ${theme.border}`,
    background: theme.bg, color: theme.text, fontSize: 13, fontFamily: "inherit", marginTop: 10,
  };

  return (
    <Modal open={open} onClose={onCancel} title={title} width={420}>
      {body && <p style={{ fontSize: 13, color: theme.textMid, margin: 0, lineHeight: 1.5 }}>{body}</p>}
      {prompt && (
        <input
          autoFocus
          style={field}
          placeholder={prompt.placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !loading) onConfirm(value); }}
        />
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <Btn variant="secondary" onClick={onCancel} disabled={loading}>{cancelLabel}</Btn>
        <Btn
          variant={danger ? "danger" : "solid"}
          loading={loading}
          disabled={prompt && prompt.required && !value.trim()}
          onClick={() => onConfirm(prompt ? value : undefined)}
        >
          {confirmLabel}
        </Btn>
      </div>
    </Modal>
  );
}

// State plumbing for the common case: ask(), then the dialog calls back
// with what was confirmed (or nothing, for a plain yes/no). One hook instead
// of every call site inventing its own `confirmState` shape.
// eslint-disable-next-line react-refresh/only-export-components
export function useConfirm() {
  const [state, setState] = useState(null); // { options, resolve }

  const ask = (options) => new Promise((resolve) => setState({ options, resolve }));
  const close = (value) => { state?.resolve(value); setState(null); };

  const dialog = state ? (
    <ConfirmDialog
      open
      {...state.options}
      onConfirm={(v) => close(v === undefined ? true : v)}
      onCancel={() => close(state.options.prompt ? null : false)}
    />
  ) : null;

  return { ask, dialog };
}
