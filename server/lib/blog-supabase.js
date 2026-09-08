// The blog has its own Supabase project (separate from the ops database).
// Configure BLOG_SUPABASE_URL and BLOG_SUPABASE_SERVICE_ROLE_KEY. Falls back
// to the ops project variables so local dev keeps working if they are unset.
import { createClient } from "@supabase/supabase-js";
import "./supabase.js"; // loads server/.env for local development

const url = process.env.BLOG_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.BLOG_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!process.env.BLOG_SUPABASE_URL) console.warn("BLOG_SUPABASE_URL not set; blog routes are using the ops Supabase project");

export const blogDb = createClient(url, key, { auth: { persistSession: false } });
