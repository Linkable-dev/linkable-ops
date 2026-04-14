export function Tag({ children, color }) {
  return (
    <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 20, background: color + "18", color, fontSize: 11, fontWeight: 600, marginRight: 6 }}>
      {children}
    </span>
  );
}
