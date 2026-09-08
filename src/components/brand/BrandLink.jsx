import { useTheme } from "../../contexts/ThemeContext";
import { useBrandDrawer } from "../../contexts/BrandDrawerContext";

// A brand name that opens the Brand 360 drawer. Renders inline so it can sit
// inside table cells and list rows without changing their layout.
export function BrandLink({ userId, children, style = {}, title = "Open brand 360" }) {
  const { theme } = useTheme();
  const { openBrand } = useBrandDrawer();
  if (!userId) return <span style={style}>{children}</span>;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); openBrand(userId); }}
      title={title}
      style={{
        background: "none", border: "none", padding: 0, margin: 0, font: "inherit", color: "inherit",
        cursor: "pointer", textAlign: "left", textDecoration: "underline dotted",
        textDecorationColor: theme.textMuted, textUnderlineOffset: 3, maxWidth: "100%",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...style,
      }}
    >
      {children}
    </button>
  );
}
