import express, { type Express } from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import path from "node:path";
import pinoHttp from "pino-http";
import { fileURLToPath } from "node:url";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();
const DASHBOARD_DIST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../polymarket-btc-dashboard/dist/public",
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

if (process.env.SERVE_DASHBOARD === "true" && existsSync(DASHBOARD_DIST)) {
  app.use(express.static(DASHBOARD_DIST));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(path.join(DASHBOARD_DIST, "index.html"));
  });
}

export default app;
