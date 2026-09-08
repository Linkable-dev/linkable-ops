import { createContext, useCallback, useContext, useMemo, useState } from "react";
import BrandDrawer from "../components/brand/BrandDrawer";

// Any brand name in the app can open the Brand 360 drawer through this context:
//   const { openBrand } = useBrandDrawer(); openBrand(userId)
const BrandDrawerContext = createContext({ openBrand: () => {}, closeBrand: () => {}, brandUserId: null });

export function BrandDrawerProvider({ children }) {
  const [brandUserId, setBrandUserId] = useState(null);
  const openBrand = useCallback((userId) => { if (userId) setBrandUserId(String(userId)); }, []);
  const closeBrand = useCallback(() => setBrandUserId(null), []);
  const value = useMemo(() => ({ openBrand, closeBrand, brandUserId }), [openBrand, closeBrand, brandUserId]);
  return (
    <BrandDrawerContext.Provider value={value}>
      {children}
      <BrandDrawer userId={brandUserId} onClose={closeBrand} />
    </BrandDrawerContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useBrandDrawer() {
  return useContext(BrandDrawerContext);
}
