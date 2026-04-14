import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthContext";

const KBContext = createContext(null);

const EMPTY_KB = {
  icp: {
    industry: "",
    geography: "",
    fundingStage: "",
    revenueRange: "",
    pains: "",
    fears: "",
    desires: "",
    techStack: "",
  },
  service: {
    deliverables: "",
    competitors: "",
    existingCustomers: "",
  },
  brand: {
    tone: "",
    voice: "",
    examples: "",
  },
  strategicBrief: "",
  onboardingComplete: false,
};

function hasData(obj) {
  return Object.values(obj).some((v) => v && String(v).trim().length > 0);
}

export function KBProvider({ children }) {
  const { user, profile } = useAuth();
  const teamId = profile?.team_id;
  const [kb, setKbState] = useState(EMPTY_KB);
  const [loading, setLoading] = useState(true);

  // Load KB data from Supabase
  useEffect(() => {
    if (!user || !teamId) {
      setKbState(EMPTY_KB);
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function loadKB() {
      setLoading(true);

      const [icpRes, serviceRes, brandRes] = await Promise.all([
        supabase
          .from("icp_profiles")
          .select("*")
          .eq("team_id", teamId)
          .eq("is_active", true)
          .single(),
        supabase
          .from("service_profiles")
          .select("*")
          .eq("team_id", teamId)
          .eq("is_active", true)
          .single(),
        supabase
          .from("brand_voices")
          .select("*")
          .eq("team_id", teamId)
          .eq("is_active", true)
          .single(),
      ]);

      if (cancelled) return;

      const icp = icpRes.data
        ? {
            industry: icpRes.data.industry || "",
            geography: icpRes.data.geography || "",
            fundingStage: icpRes.data.funding_stage || "",
            revenueRange: icpRes.data.revenue_range || "",
            pains: icpRes.data.pains || "",
            fears: icpRes.data.fears || "",
            desires: icpRes.data.desires || "",
            techStack: icpRes.data.tech_stack || "",
          }
        : { ...EMPTY_KB.icp };

      const service = serviceRes.data
        ? {
            deliverables: serviceRes.data.deliverables || "",
            competitors: serviceRes.data.competitors || "",
            existingCustomers: serviceRes.data.existing_customers || "",
          }
        : { ...EMPTY_KB.service };

      const brand = brandRes.data
        ? {
            tone: brandRes.data.tone || "",
            voice: brandRes.data.voice || "",
            examples: brandRes.data.examples || "",
          }
        : { ...EMPTY_KB.brand };

      const onboardingComplete = hasData(icp) && hasData(service) && hasData(brand);

      setKbState({ icp, service, brand, strategicBrief: "", onboardingComplete });
      setLoading(false);
    }

    loadKB();
    return () => { cancelled = true; };
  }, [user, teamId]);

  // Persist KB changes to Supabase
  const setKb = useCallback(
    async (newKb) => {
      if (!teamId) return;

      // Optimistically update local state
      const merged = { ...kb, ...newKb };
      const onboardingComplete =
        hasData(merged.icp) && hasData(merged.service) && hasData(merged.brand);
      const updated = { ...merged, onboardingComplete };
      setKbState(updated);

      // Upsert ICP profile
      if (newKb.icp) {
        await supabase.from("icp_profiles").upsert(
          {
            team_id: teamId,
            is_active: true,
            industry: newKb.icp.industry,
            geography: newKb.icp.geography,
            funding_stage: newKb.icp.fundingStage,
            revenue_range: newKb.icp.revenueRange,
            pains: newKb.icp.pains,
            fears: newKb.icp.fears,
            desires: newKb.icp.desires,
            tech_stack: newKb.icp.techStack,
          },
          { onConflict: "team_id,is_active" }
        );
      }

      // Upsert service profile
      if (newKb.service) {
        await supabase.from("service_profiles").upsert(
          {
            team_id: teamId,
            is_active: true,
            deliverables: newKb.service.deliverables,
            competitors: newKb.service.competitors,
            existing_customers: newKb.service.existingCustomers,
          },
          { onConflict: "team_id,is_active" }
        );
      }

      // Upsert brand voice
      if (newKb.brand) {
        await supabase.from("brand_voices").upsert(
          {
            team_id: teamId,
            is_active: true,
            tone: newKb.brand.tone,
            voice: newKb.brand.voice,
            examples: newKb.brand.examples,
          },
          { onConflict: "team_id,is_active" }
        );
      }

      // Insert strategic brief if provided
      if (newKb.strategicBrief) {
        await supabase.from("strategic_briefs").insert({
          team_id: teamId,
          content: newKb.strategicBrief,
        });
      }
    },
    [teamId, kb]
  );

  return (
    <KBContext.Provider value={{ kb, setKb, loading }}>
      {children}
    </KBContext.Provider>
  );
}

export function useKB() {
  const ctx = useContext(KBContext);
  if (!ctx) throw new Error("useKB must be used within a KBProvider");
  return ctx;
}
