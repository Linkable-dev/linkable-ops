-- Per-article stock photo (Pexels) chosen at generation time or in the editor.
-- Shape: { provider, id, alt, width, height, src, srcset:[{url,w}], credit:{name,url}, page, query }
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS hero_image JSONB;
