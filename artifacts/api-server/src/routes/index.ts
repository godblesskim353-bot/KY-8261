import { Router, type IRouter } from "express";
import healthRouter from "./health";
import polymarketRouter from "./polymarket";

const router: IRouter = Router();

router.use(healthRouter);
router.use(polymarketRouter);

export default router;
