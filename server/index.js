import express from "express";
import cors from "cors";
import { scraperRoutes } from "./routes/scraper.js";
import { outreachRoutes } from "./routes/outreach.js";
import { requireAuth } from "./middleware/auth.js";

const app = express();
app.use(cors({ origin: ["http://localhost:3010", "http://localhost:5173"] }));
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ status: "ok" }));
app.use("/api/scraper", requireAuth, scraperRoutes());
app.use("/api/outreach", requireAuth, outreachRoutes());

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Linkable Ops server running on port ${PORT}`));
